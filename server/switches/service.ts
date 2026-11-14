import type { Clock } from '../clock';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { CommandRow, Commands } from '../commands/service';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import { FieldError, checkCameraHost, switchInput } from '../validate';
import { SwitchStore, type CameraPower, type Switch, type SwitchPatch } from './store';
import { OPEN_SQL } from '../commands/states';

// The switch lifecycle (design 2026-11-07-poe-switches-design.md, "Switch lifecycle"): add, test through the
// operating proxy, update (a new address is tested first), move to another operator, remove. Every step that
// depends on the switch is a signed command (switch.read, switch.poeOn, switch.forget); the record changes only
// when the command's final result arrives (Commands.onFinal, keyed by command id; never waitFinal for a write).
// A read (read()) is the one short wait. The pending map is memory: after a restart an open flow's answer
// changes nothing (the record stays as it was; the command history and the audit keep what happened).

export interface Caller { actor: string; sysadmin: boolean }
// An operations token (scope `switches`) is audited as actorType 'system', like the other token routes.
const typeOf = (actor: string): 'sysadmin' | 'system' => (actor.startsWith('ops-token:') ? 'system' : 'sysadmin');
export type SwitchOp = 'test' | 'update' | 'move' | 'remove';
export interface SwitchLast { op: SwitchOp; outcome: 'ok' | 'refused' | 'failed'; code: string | null; at: number }
export interface SwitchView extends Switch { pending: { op: SwitchOp; commandIds: string[] }[]; last: SwitchLast | null }
export interface PortView { port: number; live: Record<string, unknown> | null; cameras: { id: string; camsId: string; power: CameraPower }[] }
export interface ReadView { switch: Switch; commandId: string; state: CommandRow['state']; outcomeCode: string | null; live: { sn: string | null; firmware: string | null } | null; ports: PortView[] }

export interface SwitchServiceDeps {
  db: Db; clock: Clock; audit: Audit; registry: Registry; commands: Commands; live: LiveHub; log: Logger;
  // How long read() waits for the proxy's answer (ms).
  readWaitMs?: number;
  // After a successful test or move (Task 8: the survey).
  onActive?: (switchId: string) => void;
}

const READ_WAIT_MS = 8000;

interface Pending {
  op: SwitchOp; switchId: string; accountId: string; actor: string;
  // update: the fields to save; move: the new operator and address.
  patch?: SwitchPatch; to?: string; from?: string;
  // remove: the commands still open, the forget's id.
  open?: Set<string>; abort?: boolean;
}

const ref = (s: Switch, o: { host?: string; ports?: number; offSeconds?: number } = {}) => ({
  id: s.id, model: s.model, host: o.host ?? s.host, ports: o.ports ?? s.ports, offSeconds: o.offSeconds ?? s.offSeconds,
});

export class SwitchService {
  readonly store: SwitchStore;
  onActive: (switchId: string) => void;
  // cmdId → the flow it belongs to.
  private pending = new Map<string, Pending>();
  private last = new Map<string, SwitchLast>();

  constructor(private d: SwitchServiceDeps) {
    this.store = new SwitchStore(d.db, d.clock, d.audit);
    this.onActive = d.onActive ?? (() => {});
    d.commands.onFinal((r) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      try {
        this.onFinal(p, r);
      } catch (e) {
        d.log.error({ err: e, cmdId: r.id, switchId: p.switchId }, 'switch_final_failed');
      }
    });
  }

  // --- reads ---------------------------------------------------------------------------
  list(accountId: string): SwitchView[] {
    this.d.registry.getAccount(accountId);
    return this.store.listSwitches(accountId).map((s) => this.view(s));
  }
  get(id: string): SwitchView {
    return this.view(this.find(id));
  }

  // The live port table: switch.read through the operator (a short wait), with the cameras mapped per port.
  async read(c: Caller, id: string): Promise<ReadView> {
    this.sysadmin(c);
    const s = this.find(id);
    const cmd = this.d.commands.create(c.actor, s.accountId, s.proxyId, 'switch.read', { v: 1, switch: ref(s) }, { actorType: typeOf(c.actor) });
    const fin = await this.d.commands.waitFinal(cmd.id, this.d.readWaitMs ?? READ_WAIT_MS);
    const result = fin?.state === 'done' ? fin.result : null;
    const livePorts = new Map<number, Record<string, unknown>>();
    if (result && Array.isArray(result.ports)) for (const p of result.ports as Record<string, unknown>[]) if (p && Number.isSafeInteger(p.port)) livePorts.set(p.port as number, p);
    const mapped = this.store.camerasOnSwitch(s.id);
    return {
      switch: s, commandId: cmd.id, state: fin?.state ?? cmd.state, outcomeCode: fin?.outcomeCode ?? null,
      live: result ? { sn: typeof result.sn === 'string' ? result.sn : null, firmware: typeof result.firmware === 'string' ? result.firmware : null } : null,
      ports: Array.from({ length: s.ports }, (_, i) => i + 1).map((port) => ({
        port, live: livePorts.get(port) ?? null,
        cameras: mapped.filter((m) => 'port' in m.power && m.power.port === port).map((m) => ({ id: m.id, camsId: m.camsId, power: m.power })),
      })),
    };
  }

  // --- writes (a signed-in system admin only) ----------------------------------------
  add(c: Caller, accountId: string, raw: unknown): Switch {
    this.sysadmin(c);
    this.d.registry.getAccount(accountId);
    const input = switchInput(raw, false) as Required<ReturnType<typeof switchInput>>;
    this.operatorOf(accountId, input.proxyId);
    const s = this.store.createSwitch(c.actor, accountId, { ...input, state: 'pending' }, typeOf(c.actor));
    this.publish(s.id);
    return s;
  }

  // switch.read through the operator; the answer makes it active (see onFinal).
  test(c: Caller, id: string): { commandId: string } {
    this.sysadmin(c);
    const s = this.find(id);
    this.notBusy(s.id);
    return { commandId: this.send({ op: 'test', switchId: s.id, accountId: s.accountId, actor: c.actor }, s.proxyId, 'switch.read', { v: 1, switch: ref(s) }) };
  }

  // Plain fields at once; a new address of a tested switch is tested first (the serial must match), with
  // everything else in the same change. An untested (pending) switch takes a new address as it is.
  update(c: Caller, id: string, raw: unknown): Switch | { commandId: string } {
    this.sysadmin(c);
    const s = this.find(id);
    const patch = switchInput(raw, true) as SwitchPatch;
    if (patch.proxyId !== undefined) throw new FieldError('proxyId', 'invalid', 'a move changes the operating proxy');
    // Fewer ports than a mapped camera's port would hide that mapping from the port table (#166): unmap it first.
    if (patch.ports !== undefined) {
      const beyond = this.store.camerasOnSwitch(s.id).filter((m) => 'port' in m.power && m.power.port > patch.ports!);
      if (beyond.length) throw new ApiError(409, 'ports_in_use', 'ports', `${beyond.map((m) => `${m.camsId} is on port ${'port' in m.power ? m.power.port : '?'}`).join(', ')}: change its power first`);
    }
    if (patch.host === undefined || patch.host === s.host || s.state === 'pending') {
      const out = this.store.updateSwitch(c.actor, s.accountId, s.id, patch, typeOf(c.actor));
      this.publish(s.id);
      return out;
    }
    this.notBusy(s.id);
    // The fields are saved with the answer: a name taken now is refused now (the store's 409 for a plain change).
    if (patch.name !== undefined && patch.name !== s.name && this.d.db.prepare('SELECT 1 FROM switches WHERE account_id = ? AND name = ? AND id != ?').get(s.accountId, patch.name, s.id)) throw new ApiError(409, 'duplicate_name', 'name');
    const args = { v: 1, switch: ref(s, { host: patch.host, ports: patch.ports, offSeconds: patch.offSeconds }) };
    return { commandId: this.send({ op: 'update', switchId: s.id, accountId: s.accountId, actor: c.actor, patch }, s.proxyId, 'switch.read', args) };
  }

  // Test through the new operator (the serial must match), flip, then switch.forget to the old one.
  move(c: Caller, id: string, raw: unknown): { commandId: string } {
    this.sysadmin(c);
    const s = this.find(id);
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!b) throw new FieldError('body');
    for (const k of Object.keys(b)) if (k !== 'proxyId' && k !== 'host') throw new FieldError(k, 'unknown');
    if (typeof b.proxyId !== 'string' || b.proxyId === s.proxyId) throw new FieldError('proxyId');
    this.operatorOf(s.accountId, b.proxyId);
    let host: string | undefined;
    if (b.host !== undefined && b.host !== null) {
      if (typeof b.host !== 'string') throw new FieldError('host');
      host = checkCameraHost(b.host.trim());
    }
    this.notBusy(s.id);
    const patch: SwitchPatch = { proxyId: b.proxyId, ...(host !== undefined ? { host } : {}) };
    return { commandId: this.send({ op: 'move', switchId: s.id, accountId: s.accountId, actor: c.actor, patch, from: s.proxyId, to: b.proxyId }, b.proxyId, 'switch.read', { v: 1, switch: ref(s, { host }) }) };
  }

  // PoE on for every port with a mapped poe camera, then switch.forget; the record goes (cameras → unknown) when
  // all of them are final. A failed poeOn is audited and does not stop the removal.
  remove(c: Caller, id: string): { commandId: string; commandIds: string[] } {
    this.sysadmin(c);
    const s = this.find(id);
    this.notBusy(s.id);
    const ports = [...new Set(this.store.camerasOnSwitch(s.id).flatMap((m) => (m.power.kind === 'poe' ? [m.power.port] : [])))].sort((a, b) => a - b);
    const p: Pending = { op: 'remove', switchId: s.id, accountId: s.accountId, actor: c.actor, open: new Set() };
    const ids: string[] = [];
    try {
      for (const port of ports) ids.push(this.send(p, s.proxyId, 'switch.poeOn', { v: 1, switch: ref(s), port }));
      ids.push(this.send(p, s.proxyId, 'switch.forget', { v: 1, switchId: s.id }));
    } catch (e) {
      // Some were queued: their answers end here, the record stays.
      p.abort = true;
      throw e;
    }
    return { commandId: ids[ids.length - 1], commandIds: ids };
  }

  // --- the flows' answers -----------------------------------------------------------
  private onFinal(p: Pending, r: CommandRow): void {
    this.pending.delete(r.id);
    if (p.op === 'remove') return this.removeStep(p, r);
    const s = this.store.findById(p.switchId);
    if (!s) {
      // Removed meanwhile (another path): nothing to save, the answer is kept in the audit.
      this.d.audit.write({ actorType: typeOf(p.actor), actor: p.actor, action: 'switch-test', accountId: p.accountId, targetType: 'switch', targetId: p.switchId, outcome: 'failed', detail: { op: p.op, code: 'not_found', cmdId: r.id } });
      return;
    }
    const res = r.result;
    if (r.state !== 'done' || !res || !(res.sn === null || typeof res.sn === 'string')) {
      return this.outcome(p, s, r.state === 'refused' ? 'refused' : 'failed', r.state === 'done' ? 'unreadable' : (r.outcomeCode ?? r.state), { cmdId: r.id });
    }
    const sn = res.sn as string | null;
    // A tested switch answers with its own serial; a serial is one switch, in any account.
    if (s.sn !== null && sn !== s.sn) return this.outcome(p, s, 'refused', 'switch_mismatch', { cmdId: r.id, sn, expected: s.sn });
    const holder = sn === null ? null : this.store.findBySerial(sn);
    if (holder && holder.id !== s.id) return this.outcome(p, s, 'refused', 'switch_taken', { cmdId: r.id, sn });
    const tested: SwitchPatch = { state: 'active', sn, firmware: typeof res.firmware === 'string' ? res.firmware : null, readAt: this.d.clock.now() };
    try {
      this.store.updateSwitch(p.actor, p.accountId, s.id, { ...(p.patch ?? {}), ...tested }, typeOf(p.actor));
    } catch (e) {
      // The test passed but the change can't be saved (a name taken meanwhile, the switch gone): nothing changes.
      return this.outcome(p, s, 'failed', 'save_failed', { cmdId: r.id, sn, reason: e instanceof ApiError ? e.code : 'error' });
    }
    this.outcome(p, s, 'ok', null, { cmdId: r.id, sn });
    if (p.op === 'move' && p.from) {
      try {
        this.d.commands.create(p.actor, p.accountId, p.from, 'switch.forget', { v: 1, switchId: s.id }, { actorType: typeOf(p.actor) });
      } catch (e) {
        // The old operator keeps the password (it can't be told now): audited, the move stands.
        this.d.audit.write({ actorType: typeOf(p.actor), actor: p.actor, action: 'switch-move', accountId: p.accountId, targetType: 'switch', targetId: s.id, targetLabel: s.name, outcome: 'failed',
          detail: { step: 'forget', proxyId: p.from, code: e instanceof ApiError ? e.code : 'error' } });
      }
    }
    if (p.op === 'test' || p.op === 'move') {
      try {
        this.onActive(s.id);
      } catch (e) {
        this.d.log.error({ err: e, switchId: s.id }, 'switch_on_active_failed');
      }
    }
  }

  private removeStep(p: Pending, r: CommandRow): void {
    p.open!.delete(r.id);
    if (r.command === 'switch.poeOn' && r.state !== 'done') {
      this.d.audit.write({ actorType: typeOf(p.actor), actor: p.actor, action: 'switch-delete', accountId: p.accountId, targetType: 'switch', targetId: p.switchId, outcome: 'failed',
        detail: { step: 'poeOn', cmdId: r.id, port: r.args.port ?? null, state: r.state, code: r.outcomeCode } });
    }
    // A failed forget doesn't stop the removal either, but the operator still holds the password: audited (#166).
    if (r.command === 'switch.forget' && r.state !== 'done') {
      this.d.audit.write({ actorType: typeOf(p.actor), actor: p.actor, action: 'switch-delete', accountId: p.accountId, targetType: 'switch', targetId: p.switchId, outcome: 'failed',
        detail: { step: 'forget', cmdId: r.id, proxyId: r.proxyId, state: r.state, code: r.outcomeCode } });
    }
    if (p.open!.size > 0 || p.abort) return;
    if (!this.d.db.prepare('SELECT 1 FROM switches WHERE id = ?').get(p.switchId)) return;
    this.store.deleteSwitch(p.actor, p.accountId, p.switchId, typeOf(p.actor));
    this.last.delete(p.switchId);
    this.publish(p.switchId);
  }

  private outcome(p: Pending, s: Switch, outcome: SwitchLast['outcome'], code: string | null, detail: Record<string, unknown>): void {
    this.last.set(s.id, { op: p.op, outcome, code, at: this.d.clock.now() });
    this.d.audit.write({ actorType: typeOf(p.actor), actor: p.actor, action: 'switch-test', accountId: p.accountId, targetType: 'switch', targetId: s.id, targetLabel: s.name, outcome,
      detail: { op: p.op, ...(code ? { code } : {}), ...(p.to ? { proxyId: p.to } : {}), ...detail } });
    this.publish(s.id);
  }

  // --- helpers --------------------------------------------------------------------------
  private send(p: Pending, proxyId: string, command: 'switch.read' | 'switch.poeOn' | 'switch.forget', args: Record<string, unknown>): string {
    const cmd = this.d.commands.create(p.actor, p.accountId, proxyId, command, args, { actorType: typeOf(p.actor) });
    this.pending.set(cmd.id, p);
    p.open?.add(cmd.id);
    this.publish(p.switchId);
    return cmd.id;
  }

  // One flow per switch: refused while one of ours is open, or any open switch command names it (a survey, a cycle).
  // A switch.forget to a proxy that no longer operates it (after a move) doesn't count: the old operator may be away
  // for a long time, and its forget touches only its own copy of the password.
  private notBusy(switchId: string): void {
    if ([...this.pending.values()].some((p) => p.switchId === switchId && !p.abort)) throw new ApiError(409, 'switch_busy');
    const operator = this.store.findById(switchId)?.proxyId ?? null;
    const open = this.d.db.prepare(`SELECT 1 FROM commands WHERE command LIKE 'switch.%' AND state IN ${OPEN_SQL} AND (json_extract(args, '$.switch.id') = ? OR json_extract(args, '$.switchId') = ?)
      AND NOT (command = 'switch.forget' AND proxy_id IS NOT ?) LIMIT 1`).get(switchId, switchId, operator);
    if (open) throw new ApiError(409, 'switch_busy');
  }

  private find(id: string): Switch {
    const s = this.store.findById(id);
    if (!s) throw new ApiError(404, 'not_found');
    return s;
  }

  // The operator must be a proxy of the switch's account.
  private operatorOf(accountId: string, proxyId: string): void {
    try {
      this.d.registry.getProxy(accountId, proxyId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new FieldError('proxyId');
      throw e;
    }
  }

  private sysadmin(c: Caller): void {
    if (!c.sysadmin) throw new ApiError(403, 'forbidden');
  }

  private view(s: Switch): SwitchView {
    const byOp = new Map<Pending, string[]>();
    for (const [id, p] of this.pending) if (p.switchId === s.id && !p.abort) byOp.set(p, [...(byOp.get(p) ?? []), id]);
    return { ...s, pending: [...byOp].map(([p, commandIds]) => ({ op: p.op, commandIds })), last: this.last.get(s.id) ?? null };
  }

  private publish(id: string): void {
    this.d.live.publishRegistry('switch', id);
  }
}
