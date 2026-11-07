import type { Clock } from '../clock';
import type { Audit } from '../audit';
import { tx, type Db } from '../db/open';
import { newId } from '../ids';
import { ApiError } from '../registry';

// Switch records and what powers a camera (design 2026-11-07-poe-switches-design.md).
// Every write is one transaction with its audit entries.

type Row = Record<string, unknown>;

export interface Switch {
  id: string; accountId: string; name: string; model: 'sscpoe-web'; host: string; ports: number; offSeconds: number; proxyId: string;
  state: 'pending' | 'active'; sn: string | null; firmware: string | null; readAt: number | null; survey: boolean; createdAt: number; updatedAt: number;
}
export type CameraPower =
  | { kind: 'poe'; switchId: string; port: number; watts: number; verifiedAt?: number; notSeen?: boolean }
  | { kind: 'data-only'; switchId: string; port: number; verifiedAt?: number; notSeen?: boolean }
  | { kind: 'adapter' }
  | { kind: 'unknown' };
export type PowerActorType = 'sysadmin' | 'proxy' | 'system' | 'cams';
export interface SwitchInput { name: string; model: 'sscpoe-web'; host: string; ports: number; offSeconds: number; proxyId: string; state?: 'pending' | 'active'; survey?: boolean }
export type SwitchPatch = Partial<SwitchInput & { sn: string | null; firmware: string | null; readAt: number | null }>;

const UNKNOWN: CameraPower = { kind: 'unknown' };
const toSwitch = (r: Row): Switch => ({
  id: r.id as string, accountId: r.account_id as string, name: r.name as string, model: r.model as 'sscpoe-web', host: r.host as string, ports: r.ports as number,
  offSeconds: r.off_seconds as number, proxyId: r.proxy_id as string, state: r.state as Switch['state'], sn: r.sn as string | null, firmware: r.firmware as string | null,
  readAt: r.read_at as number | null, survey: r.survey === 1, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});
const toPower = (v: unknown): CameraPower => (v ? (JSON.parse(v as string) as CameraPower) : UNKNOWN);
// Only these occupy a port.
const occupies = (p: CameraPower): p is Extract<CameraPower, { switchId: string }> => p.kind === 'poe' || p.kind === 'data-only';
// A record without verifiedAt is older than one with.
const verified = (p: CameraPower): number => ('verifiedAt' in p && typeof p.verifiedAt === 'number' ? p.verifiedAt : -Infinity);

const COLS: Record<string, string> = {
  name: 'name', model: 'model', host: 'host', ports: 'ports', offSeconds: 'off_seconds', proxyId: 'proxy_id', state: 'state', sn: 'sn', firmware: 'firmware', readAt: 'read_at', survey: 'survey',
};

function mapConstraint(e: unknown): never {
  const m = e instanceof Error ? e.message : String(e);
  if (/UNIQUE.*switches\.account_id, switches\.name/.test(m)) throw new ApiError(409, 'duplicate_name', 'name');
  if (/FOREIGN KEY/.test(m)) throw new ApiError(400, 'invalid', 'proxyId');
  if (/CHECK/.test(m)) throw new ApiError(400, 'invalid');
  throw e;
}
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return mapConstraint(e);
  }
}

export class SwitchStore {
  constructor(private db: Db, private clock: Clock, private audit: Audit) {}

  private row(accountId: string, id: string): Row {
    const r = this.db.prepare('SELECT * FROM switches WHERE id = ? AND account_id = ?').get(id, accountId) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    return r;
  }

  createSwitch(actor: string, accountId: string, input: SwitchInput, actorType: PowerActorType = 'sysadmin'): Switch {
    return guard(() => tx(this.db, () => {
      const now = this.clock.now();
      const id = newId('sw');
      this.db.prepare(`INSERT INTO switches (id, account_id, name, model, host, ports, off_seconds, proxy_id, state, survey, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, accountId, input.name, input.model, input.host, input.ports, input.offSeconds, input.proxyId, input.state ?? 'pending', input.survey === false ? 0 : 1, now, now);
      this.audit.write({ actorType, actor, action: 'switch-create', accountId, targetType: 'switch', targetId: id, targetLabel: input.name, outcome: 'ok', detail: { host: input.host, proxyId: input.proxyId } });
      return this.getSwitch(accountId, id);
    }));
  }

  getSwitch(accountId: string, id: string): Switch {
    return toSwitch(this.row(accountId, id));
  }

  // By id alone (the /switches/:switchId routes); null when there is none.
  findById(id: string): Switch | null {
    const r = this.db.prepare('SELECT * FROM switches WHERE id = ?').get(id) as Row | undefined;
    return r ? toSwitch(r) : null;
  }

  listSwitches(accountId: string): Switch[] {
    return (this.db.prepare('SELECT * FROM switches WHERE account_id = ? ORDER BY name').all(accountId) as Row[]).map(toSwitch);
  }

  findBySerial(sn: string): Switch | null {
    const r = this.db.prepare('SELECT * FROM switches WHERE sn = ? ORDER BY id LIMIT 1').get(sn) as Row | undefined;
    return r ? toSwitch(r) : null;
  }

  // A change of the proxy is audited as switch-move, every other change as switch-update.
  updateSwitch(actor: string, accountId: string, id: string, patch: SwitchPatch, actorType: PowerActorType = 'sysadmin'): Switch {
    return guard(() => tx(this.db, () => {
      const old = this.getSwitch(accountId, id);
      const sets: string[] = ['updated_at = ?'];
      const args: (string | number | null)[] = [this.clock.now()];
      const changed: string[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        const col = COLS[k];
        if (!col) throw new ApiError(400, 'invalid', k);
        sets.push(`${col} = ?`);
        args.push(k === 'survey' ? (v ? 1 : 0) : (v as string | number | null));
        changed.push(k);
      }
      this.db.prepare(`UPDATE switches SET ${sets.join(', ')} WHERE id = ? AND account_id = ?`).run(...args, id, accountId);
      const now = this.getSwitch(accountId, id);
      const moved = now.proxyId !== old.proxyId;
      this.audit.write({
        actorType, actor, action: moved ? 'switch-move' : 'switch-update', accountId, targetType: 'switch', targetId: id, targetLabel: now.name, outcome: 'ok',
        detail: moved ? { from: old.proxyId, to: now.proxyId, fields: changed } : { fields: changed },
      });
      return now;
    }));
  }

  // The cameras mapped to it go to unknown in the same transaction (the caller switches PoE on and forgets first).
  deleteSwitch(actor: string, accountId: string, id: string, actorType: PowerActorType = 'sysadmin'): void {
    guard(() => tx(this.db, () => {
      const s = this.getSwitch(accountId, id);
      for (const c of this.camerasOnSwitch(id)) this.writePower(c.id, c.accountId, c.camsId, c.power, UNKNOWN, actor, actorType, 'switch deleted');
      this.db.prepare('DELETE FROM switches WHERE id = ? AND account_id = ?').run(id, accountId);
      this.audit.write({ actorType, actor, action: 'switch-delete', accountId, targetType: 'switch', targetId: id, targetLabel: s.name, outcome: 'ok', detail: {} });
    }));
  }

  // The cameras whose power is poe or data-only on this switch.
  camerasOnSwitch(switchId: string): { id: string; accountId: string; camsId: string; power: CameraPower }[] {
    const rows = this.db.prepare(`SELECT id, account_id, cams_id, power FROM cameras WHERE json_extract(power, '$.kind') IN ('poe', 'data-only') AND json_extract(power, '$.switchId') = ? ORDER BY cams_id`).all(switchId) as Row[];
    return rows.map((r) => ({ id: r.id as string, accountId: r.account_id as string, camsId: r.cams_id as string, power: toPower(r.power) }));
  }

  private writePower(cameraId: string, accountId: string, camsId: string, from: CameraPower, to: CameraPower, actor: string, actorType: PowerActorType, why: string): void {
    this.db.prepare('UPDATE cameras SET power = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(to), this.clock.now(), cameraId);
    this.audit.write({ actorType, actor, action: 'camera-power-set', accountId, targetType: 'camera', targetId: cameraId, targetLabel: camsId, outcome: 'ok', detail: { from, to, why } });
  }

  // One camera per switch port: the older record on the port goes to unknown (verifiedAt smaller; none = older).
  // If the port's holder is strictly newer than the incoming record, the incoming one is stored as unknown instead.
  // Both changes are audited as camera-power-set.
  setPower(cameraId: string, power: CameraPower, actor: string, actorType: PowerActorType, why: string): CameraPower {
    return guard(() => tx(this.db, () => {
      const c = this.db.prepare('SELECT id, account_id, cams_id, power FROM cameras WHERE id = ?').get(cameraId) as Row | undefined;
      if (!c) throw new ApiError(404, 'not_found');
      const accountId = c.account_id as string;
      const camsId = c.cams_id as string;
      let next = power;
      if (occupies(power)) {
        if (!this.db.prepare('SELECT 1 FROM switches WHERE id = ? AND account_id = ?').get(power.switchId, accountId)) throw new ApiError(400, 'invalid', 'switchId');
        for (const o of this.camerasOnSwitch(power.switchId)) {
          if (o.id === cameraId || !occupies(o.power) || o.power.port !== power.port) continue;
          if (verified(o.power) > verified(power)) next = UNKNOWN;
          else this.writePower(o.id, o.accountId, o.camsId, o.power, UNKNOWN, actor, actorType, `port taken by ${camsId}`);
        }
      }
      this.writePower(cameraId, accountId, camsId, toPower(c.power), next, actor, actorType, why);
      return next;
    }));
  }
}
