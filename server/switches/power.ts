import type { Clock } from '../clock';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Camera, type Registry } from '../registry';
import type { CommandRow, Commands, WireCommand } from '../commands/service';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import { FieldError } from '../validate';
import { tx } from '../db/open';
import { SWITCH_SURVEY_MAX } from '../../contract/build';
import type { CameraPower, PowerActorType, Switch } from './store';
import type { SwitchService } from './service';

// Camera power (design 2026-11-07-poe-switches-design.md, "Verify", "Power-cycle", "Survey"): what powers a
// camera, checked and changed through the switch's operating proxy (switch.locate, switch.survey, switch.cycle).
// Every step is a signed command; its answer arrives through Commands.onFinal (keyed by command id; never
// waitFinal). One step follows another only after the previous one is final: a search asks one switch after the
// other (the mapped one first, then the account's other active switches by name; the first that finds it wins).
// The camera's own proxy hears about each change (camera.power.set) and about a power-cycle (camera.power.cycling,
// camera.power.cycled), each only if its allow list has the entry. The checks' and surveys' state is memory (lost on
// a restart); a camera's last power-cycle is kept in camera_power_cycles: a cycle running at a restart is re-attached
// to its switch.cycle row and ends when that is final (no search or retry after a restart).
// The camera's own proxy may ask for a cycle (camera.power.cycle.request, requestFromProxy); the answer
// (camera.power.cycle.result) goes out once, when the cycle is final, also across a restart.

// proxy: a camera's own proxy asking for a power-cycle (actorType 'proxy').
export interface Who { actor: string; sysadmin: boolean; system?: boolean; proxy?: boolean }
// The scheduler and the hooks.
export const SYSTEM: Who = { actor: 'system', sysadmin: true, system: true };
export const HOST_UNKNOWN = 'camera host unknown in cams-admin';
// The refusals of a proxy's request (camera.power.cycle.result reason).
export const NOT_IN_ADMIN = 'camera not in cams-admin';
export const CYCLE_RUNNING = 'a power-cycle is already running';
export const TOO_SOON = 'too soon';
// At most one request per camera in this time from proxies (memory).
export const PROXY_REQUEST_GAP_MS = 60_000;
interface CycleRequest { requestId: string; proxyId: string; proxyCameraId: string }

export type PowerOutcome = { ok: true; commandId: string } | { ok: false; code: string; reason: string };
export type FlowOp = 'verify' | 'search' | 'propose' | 'cycle';
export interface PowerFlow {
  op: FlowOp; requestedAt: number; force?: boolean; state: 'running' | 'ok' | 'failed'; code: string | null; reason: string | null;
  commandIds: string[]; finishedAt: number | null;
}
export interface PowerView {
  cameraId: string; camsId: string; accountId: string; power: CameraPower; switch: { id: string; name: string; state: Switch['state'] } | null;
  lastCheck: PowerFlow | null; lastCycle: PowerFlow | null;
}
export interface SurveyResultView { cameraId: string; camsId: string; found: boolean; port?: number; kind?: CameraPower['kind']; reason?: string }
export interface SurveyView { switchId: string; at: number; state: 'running' | 'done'; commandIds: string[]; results: SurveyResultView[] }
export interface SurveyStart { commandIds: string[]; queued: boolean }

export interface PowerDeps {
  db: Db; clock: Clock; audit: Audit; registry: Registry; commands: Commands; status: StatusStore; switches: SwitchService; live: LiveHub; log: Logger;
}

interface Hit { sw: Switch; port: number; watts: number; poe: boolean }
type Occupying = Extract<CameraPower, { switchId: string }>;

const occupies = (p: CameraPower): p is Occupying => p.kind === 'poe' || p.kind === 'data-only';
// A reported address without its ":port" (an IPv6 literal keeps its brackets).
export const bareHost = (a: string): string => {
  const m = /^(\[[^\]]+\]|[^:]+):\d{1,5}$/.exec(a);
  return m ? m[1] : a;
};
const ref = (s: Switch) => ({ id: s.id, model: s.model, host: s.host, ports: s.ports, offSeconds: s.offSeconds });
const clamp = (s: string) => (s.length > 200 ? s.slice(0, 199) + '…' : s);
const LOCATE_TEXT: Record<string, string> = { not_reachable: 'camera not reachable from the operator', ambiguous: 'no clear port (ambiguous)', no_traffic: 'no traffic on any port' };
const CYCLE_TEXT: Record<string, string> = {
  not_verified: "the camera's traffic is not on the mapped port",
  no_power: 'the port has PoE off or draws 0 W',
  switch_busy: 'the switch is busy',
  poe_may_be_off: 'PoE may still be off on the port: check the switch',
  password_unset: 'switch password not set on the operator (or set for another address: set it again)',
  switch_auth: 'the switch refused the password',
  switch_unreachable: 'the switch is not reachable from the operator',
  switch_error: 'the switch answered with an error',
  unknown: 'no final answer from the operator',
  expired: 'the operator was offline: the command was never sent',
};
const errCode = (e: unknown) => (e instanceof ApiError ? e.code : e instanceof FieldError ? 'invalid' : 'error');
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export class PowerService {
  // cmdId → what its final result does.
  private pending = new Map<string, (r: CommandRow) => void>();
  private lastCheck = new Map<string, PowerFlow>();
  private lastCycle = new Map<string, PowerFlow>();
  private surveys = new Map<string, SurveyView>();
  // A survey asked for while one runs on the switch: at most one waits (the newest caller).
  private queued = new Map<string, Who>();
  // proxyId → camera ref → the last reported address (memory: the first report after a start is no change).
  private addresses = new Map<string, Map<string, string>>();
  // cameraId → when a proxy's request last started a cycle attempt (the 60 s gap).
  private lastRequest = new Map<string, number>();

  constructor(private d: PowerDeps) {
    d.commands.onFinal((r) => {
      const fn = this.pending.get(r.id);
      if (!fn) return;
      this.pending.delete(r.id);
      try {
        fn(r);
      } catch (e) {
        d.log.error({ err: e, cmdId: r.id }, 'power_final_failed');
      }
    });
    this.restore();
  }

  // --- reads -----------------------------------------------------------------------------
  get(cameraId: string, accountId?: string): PowerView {
    const c = this.camera(cameraId, accountId);
    const sw = occupies(c.power) ? this.d.switches.store.findById(c.power.switchId) : null;
    return {
      cameraId: c.id, camsId: c.camsId, accountId: c.accountId, power: c.power, switch: sw ? { id: sw.id, name: sw.name, state: sw.state } : null,
      lastCheck: this.lastCheck.get(c.id) ?? null, lastCycle: this.lastCycle.get(c.id) ?? null,
    };
  }

  lastSurvey(switchId: string): SurveyView | null {
    this.switchOf(switchId);
    return this.surveys.get(switchId) ?? null;
  }

  // --- writes ------------------------------------------------------------------------------
  // PUT power: {kind:'adapter'} (no switch, no power-cycle, surveys skip it), {kind:'auto'} (unknown, then a
  // search), or {switchId, port} (a proposal: saved only when the camera's traffic is on that port).
  declare(who: Who, cameraId: string, raw: unknown): PowerView | PowerOutcome {
    this.sysadmin(who);
    const c = this.camera(cameraId);
    if (!isObj(raw)) throw new FieldError('body');
    if ('kind' in raw) {
      for (const k of Object.keys(raw)) if (k !== 'kind') throw new FieldError(k, 'unknown');
      if (raw.kind === 'adapter') {
        this.store(who, c, { kind: 'adapter' }, 'declared adapter');
        return this.get(c.id);
      }
      if (raw.kind !== 'auto') throw new FieldError('kind');
      const host = this.hostOf(c);
      if (!host) return this.refuse('host_unknown', HOST_UNKNOWN);
      if (this.busy(c.id)) return this.refuse('busy', 'a power check or power-cycle of this camera is running');
      this.store(who, c, { kind: 'unknown' }, 'declared auto: search');
      return this.find(who, this.camera(c.id), 'search');
    }
    for (const k of Object.keys(raw)) if (k !== 'switchId' && k !== 'port') throw new FieldError(k, 'unknown');
    if (typeof raw.switchId !== 'string') throw new FieldError('switchId');
    const sw = this.d.switches.store.findById(raw.switchId);
    if (!sw || sw.accountId !== c.accountId) throw new FieldError('switchId');
    if (!Number.isSafeInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > sw.ports) throw new FieldError('port');
    return this.propose(who, c, sw, raw.port as number);
  }

  // switch.locate on the mapped switch; not there (or unknown) → the search goes on through the other switches.
  verify(who: Who, cameraId: string): PowerOutcome {
    this.sysadmin(who);
    const c = this.camera(cameraId);
    if (c.power.kind === 'adapter') return this.refuse('adapter', 'declared adapter-powered: on no switch');
    return this.find(who, c, 'verify');
  }

  // switch.locate on each active switch of the account (the mapped one first), one after another.
  search(who: Who, cameraId: string): PowerOutcome {
    this.sysadmin(who);
    return this.find(who, this.camera(cameraId), 'search');
  }

  // Unforced: switch.cycle {force:false, host} on the mapped switch (the operator verifies in the same session);
  // not_verified → search → found elsewhere: the mapping follows and the cycle is tried once there. Forced: a poe
  // mapping only, switch.cycle {force:true, host:null}, audited camera-power-cycle-forced.
  cycle(who: Who, cameraId: string, raw: unknown): PowerOutcome {
    return this.startCycle(who, cameraId, raw, null);
  }

  // A camera's own proxy asks (camera.power.cycle.request): an unforced cycle as the proxy, answered with
  // camera.power.cycle.result {ok, reason?} when it is final (refusals right away). Audited camera-power-cycle.
  requestFromProxy(proxyId: string, accountId: string, ev: { camera: string; requestId: string }): void {
    const req: CycleRequest = { requestId: ev.requestId, proxyId, proxyCameraId: ev.camera };
    const who: Who = { actor: proxyId, sysadmin: true, proxy: true };
    const audit = (c: Camera | null, out: PowerOutcome) => this.d.audit.write({
      actorType: 'proxy', actor: proxyId, action: 'camera-power-cycle', accountId, targetType: 'camera', targetId: c?.id ?? null, targetLabel: c?.camsId ?? null,
      outcome: out.ok ? 'ok' : 'refused', detail: { requestId: req.requestId, camera: req.proxyCameraId, ...(out.ok ? { cmdId: out.commandId } : { code: out.code, reason: out.reason }) },
    });
    const row = this.d.db.prepare('SELECT id FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?').get(accountId, proxyId, ev.camera) as { id: string } | undefined;
    const c = row ? this.camera(row.id) : null;
    let out: PowerOutcome;
    if (!c) out = this.refuse('not_in_admin', NOT_IN_ADMIN);
    else if (this.lastCycle.get(c.id)?.state === 'running') out = this.refuse('busy', CYCLE_RUNNING);
    else if (this.d.clock.now() - (this.lastRequest.get(c.id) ?? -Infinity) < PROXY_REQUEST_GAP_MS) out = this.refuse('too_soon', TOO_SOON);
    else {
      this.lastRequest.set(c.id, this.d.clock.now());
      try {
        out = this.startCycle(who, c.id, {}, req);
      } catch (e) {
        out = this.refuse(errCode(e), e instanceof ApiError && e.hint ? e.hint : errCode(e));
      }
    }
    audit(c, out);
    if (!out.ok) this.answer(accountId, req, false, out.reason);
  }

  private startCycle(who: Who, cameraId: string, raw: unknown, req: CycleRequest | null): PowerOutcome {
    this.sysadmin(who);
    const c = this.camera(cameraId);
    if (raw !== undefined && raw !== null && !isObj(raw)) throw new FieldError('body');
    const b = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== 'force') throw new FieldError(k, 'unknown');
    if (b.force !== undefined && typeof b.force !== 'boolean') throw new FieldError('force');
    const force = b.force === true;
    // A forced cycle sends no host (host:null): it needs none.
    if (!force && !this.hostOf(c)) return this.refuse('host_unknown', HOST_UNKNOWN);
    const p = c.power;
    if (p.kind === 'unknown') return this.refuse('power_unknown', 'what powers the camera is unknown: verify or search first');
    if (p.kind !== 'poe') return this.refuse('not_poe', p.kind === 'adapter' ? 'not PoE powered (adapter)' : 'not PoE powered: its port draws 0 W');
    if (this.busy(c.id)) return this.refuse('busy', 'a power check or power-cycle of this camera is running');
    const sw = this.d.switches.store.findById(p.switchId);
    if (!sw || sw.state !== 'active') return this.refuse('switch_unavailable', 'the switch is not active');
    if (this.d.switches.get(sw.id).pending.length) return this.refuse('switch_busy', `${sw.name} is busy (a test, move or removal)`);
    if (!this.allowed(sw.proxyId, 'switch.cycle')) return this.refuse('not_allowed_on_proxy', "switch.cycle is not in the operator's allow list");
    const flow = this.flow('cycle', force);
    this.lastCycle.set(c.id, flow);
    this.own(who, c, 'camera.power.cycling', { v: 1, camera: c.proxyCameraId, at: this.d.clock.now() });
    try {
      const id = this.sendCycle(who, c, sw, p.port, force, false, flow);
      this.saveCycle(c.id, flow, id, req);
      if (force) {
        this.d.audit.write({ actorType: this.type(who), actor: who.actor, action: 'camera-power-cycle-forced', accountId: c.accountId, targetType: 'camera', targetId: c.id, targetLabel: c.camsId, outcome: 'ok',
          detail: { switchId: sw.id, switchName: sw.name, port: p.port, cmdId: id } });
      }
      return { ok: true, commandId: id };
    } catch (e) {
      this.finishCycle(who, c, flow, 'failed', errCode(e), e instanceof ApiError && e.hint ? e.hint : errCode(e));
      return this.refuse(errCode(e), e instanceof ApiError && e.hint ? e.hint : errCode(e));
    }
  }

  // One switch.survey per ≤16 cameras: every camera of the account that isn't adapter and has a host. While a
  // survey runs on the switch, one more waits (queued); more asks fold into that one.
  survey(who: Who, switchId: string): SurveyStart {
    this.sysadmin(who);
    const sw = this.switchOf(switchId);
    if (sw.state !== 'active') throw new ApiError(409, 'switch_not_active', undefined, 'test the switch first');
    if (this.surveys.get(sw.id)?.state === 'running') {
      this.queued.set(sw.id, who);
      return { commandIds: [], queued: true };
    }
    return this.runSurvey(who, sw);
  }

  // Every active switch of the account; `auto` (the hooks, the daily run): only those with survey on.
  surveyAccount(who: Who, accountId: string, auto = false): { switches: ({ switchId: string } & (SurveyStart | { error: string }))[] } {
    this.sysadmin(who);
    this.d.registry.getAccount(accountId);
    const out: ({ switchId: string } & (SurveyStart | { error: string }))[] = [];
    for (const sw of this.d.switches.store.listSwitches(accountId)) {
      if (sw.state !== 'active' || (auto && !sw.survey)) continue;
      try {
        out.push({ switchId: sw.id, ...this.survey(who, sw.id) });
      } catch (e) {
        this.d.log.warn({ err: e, switchId: sw.id }, 'power_survey_not_started');
        out.push({ switchId: sw.id, error: errCode(e) });
      }
    }
    return { switches: out };
  }

  // --- hooks (actor: system) ----------------------------------------------------------------
  // The daily run: every account with an active switch that has survey on.
  surveyDaily(): void {
    const accounts = this.d.db.prepare(`SELECT DISTINCT account_id FROM switches WHERE state = 'active' AND survey = 1 ORDER BY account_id`).all() as { account_id: string }[];
    for (const a of accounts) this.hook(() => this.surveyAccount(SYSTEM, a.account_id, true));
  }
  // A camera added, or its host changed.
  cameraChanged(accountId: string): void {
    this.hook(() => this.surveyAccount(SYSTEM, accountId, true));
  }
  // A switch tested or moved (SwitchService.onActive).
  switchActive(switchId: string): void {
    this.hook(() => {
      const sw = this.d.switches.store.findById(switchId);
      if (sw && sw.survey) this.survey(SYSTEM, switchId);
    });
  }

  // --- verify / search / propose --------------------------------------------------------------
  private find(who: Who, c: Camera, op: 'verify' | 'search'): PowerOutcome {
    const host = this.hostOf(c);
    if (!host) return this.refuse('host_unknown', HOST_UNKNOWN);
    if (this.busy(c.id)) return this.refuse('busy', 'a power check or power-cycle of this camera is running');
    const flow = this.flow(op);
    const notes: string[] = [];
    const id = this.locateChain(who, c, host, this.searchOrder(c), 0, notes, flow, (hit) => {
      if (!hit) return this.finish(flow, 'failed', 'not_found', `found on no switch: ${notes.join('; ')}`);
      this.applyHit(who, c.id, hit, op === 'verify' ? 'verify' : 'search');
      this.finish(flow, 'ok', null, null);
    });
    if (!id) return this.refuse('no_switch', notes.length ? notes.join('; ') : 'the account has no active switch');
    this.lastCheck.set(c.id, flow);
    return { ok: true, commandId: id };
  }

  private propose(who: Who, c: Camera, sw: Switch, port: number): PowerOutcome {
    const host = this.hostOf(c);
    if (!host) return this.refuse('host_unknown', HOST_UNKNOWN);
    if (sw.state !== 'active') return this.refuse('switch_not_active', 'test the switch first');
    if (this.busy(c.id)) return this.refuse('busy', 'a power check or power-cycle of this camera is running');
    const flow = this.flow('propose');
    const notes: string[] = [];
    const id = this.locateChain(who, c, host, [sw], 0, notes, flow, (hit) => {
      if (!hit) return this.finish(flow, 'failed', 'not_found', notes.join('; '));
      if (hit.port !== port) return this.finish(flow, 'failed', 'not_on_port', `the camera's traffic is on port ${hit.port}, not ${port}`);
      this.applyHit(who, c.id, hit, 'proposed and verified');
      this.finish(flow, 'ok', null, null);
    });
    if (!id) return this.refuse('no_switch', notes.join('; '));
    this.lastCheck.set(c.id, flow);
    return { ok: true, commandId: id };
  }

  // The mapped switch first (if active), then the account's other active switches by name.
  private searchOrder(c: Camera): Switch[] {
    const all = this.d.switches.store.listSwitches(c.accountId).filter((s) => s.state === 'active');
    const mapped = occupies(c.power) ? all.find((s) => s.id === (c.power as Occupying).switchId) : undefined;
    return mapped ? [mapped, ...all.filter((s) => s !== mapped)] : all;
  }

  // switch.locate on list[i]; not found there → list[i+1] once the answer is in. A switch whose command can't be
  // created is noted and skipped. Returns the first command's id, or null when none could be sent (done not called).
  private locateChain(who: Who, c: Camera, host: string, list: Switch[], i: number, notes: string[], flow: PowerFlow, done: (hit: Hit | null) => void): string | null {
    for (let k = i; k < list.length; k++) {
      const sw = list[k];
      try {
        return this.send(who, c.accountId, sw.proxyId, 'switch.locate', { v: 1, switch: ref(sw), host }, flow, (r) => {
          const res = r.state === 'done' ? r.result : null;
          if (res && res.found === true && Number.isSafeInteger(res.port)) {
            return done({ sw, port: res.port as number, watts: typeof res.watts === 'number' ? res.watts : 0, poe: res.poe !== false });
          }
          notes.push(`${sw.name}: ${res ? LOCATE_TEXT[String(res.reason)] ?? 'not found' : r.outcomeCode ? CYCLE_TEXT[r.outcomeCode] ?? r.outcomeCode : r.state}`);
          if (this.locateChain(who, c, host, list, k + 1, notes, flow, done) === null) done(null);
        });
      } catch (e) {
        notes.push(`${sw.name}: ${errCode(e)}`);
      }
    }
    return null;
  }

  // poe vs data-only by watts > 0. The same mapping again: verifiedAt/watts only (not audited); a new one is
  // setPower (audited, one camera per port) and camera.power.set to the camera's proxy (and to a displaced one's).
  private applyHit(who: Who, cameraId: string, hit: Hit, why: string): CameraPower {
    const now = this.d.clock.now();
    const next: CameraPower = hit.poe && hit.watts > 0
      ? { kind: 'poe', switchId: hit.sw.id, port: hit.port, watts: hit.watts, verifiedAt: now }
      : { kind: 'data-only', switchId: hit.sw.id, port: hit.port, verifiedAt: now };
    const c = this.camera(cameraId);
    const cur = c.power;
    if (occupies(cur) && cur.kind === next.kind && cur.switchId === next.switchId && cur.port === next.port && !cur.notSeen) {
      this.d.switches.store.touchPower(c.id, next);
      this.d.live.publishRegistry('camera', c.id);
      return next;
    }
    const displaced = this.d.switches.store.camerasOnSwitch(hit.sw.id).filter((o) => o.id !== c.id && occupies(o.power) && o.power.port === hit.port).map((o) => o.id);
    const stored = this.store(who, c, next, why);
    for (const id of displaced) if (this.camera(id).power.kind === 'unknown') this.notify(who, this.camera(id));
    return stored;
  }

  // --- cycle -------------------------------------------------------------------------------------
  private sendCycle(who: Who, c: Camera, sw: Switch, port: number, force: boolean, retried: boolean, flow: PowerFlow): string {
    const host = force ? null : this.hostOf(c);
    return this.send(who, c.accountId, sw.proxyId, 'switch.cycle', { v: 1, switch: ref(sw), port, host, force, camera: c.id }, flow, (r) => {
      if (r.state === 'done') {
        const res = r.result ?? {};
        const now = this.camera(c.id).power;
        // Verified by the operator: the record is fresh (its watts if it reported some).
        if (!force && res.verified === true && now.kind === 'poe' && now.switchId === sw.id && now.port === port) {
          const watts = typeof res.watts === 'number' && res.watts > 0 ? res.watts : now.watts;
          this.applyHit(who, c.id, { sw, port, watts, poe: true }, 'power-cycle verified');
        }
        return this.finishCycle(who, c, flow, 'ok', null, `power-cycled on ${sw.name} port ${port}`);
      }
      const code = r.outcomeCode ?? r.state;
      if (code !== 'not_verified' || force || retried) return this.finishCycle(who, c, flow, 'failed', code, CYCLE_TEXT[code] ?? code);
      // Not on the mapped port: search, then once more on the port it was found on (never a loop).
      const host2 = this.hostOf(this.camera(c.id));
      const notes: string[] = [];
      const onHit = (hit: Hit | null) => {
        if (!hit) return this.finishCycle(who, c, flow, 'failed', 'not_verified', clamp(`found on no switch (last known: ${sw.name} port ${port}); ${notes.join('; ')}`));
        if (hit.sw.id === sw.id && hit.port === port) return this.finishCycle(who, c, flow, 'failed', 'not_verified', `${sw.name} could not verify the camera on port ${port}`);
        const stored = this.applyHit(who, c.id, hit, 'found by a power-cycle search');
        if (stored.kind !== 'poe') return this.finishCycle(who, c, flow, 'failed', 'not_poe', `found on ${hit.sw.name} port ${hit.port}, not PoE powered`);
        try {
          const retry = this.sendCycle(who, this.camera(c.id), hit.sw, hit.port, false, true, flow);
          this.saveCycle(c.id, flow, retry);
        } catch (e) {
          this.finishCycle(who, c, flow, 'failed', errCode(e), errCode(e));
        }
      };
      const id = host2 ? this.locateChain(who, c, host2, this.searchOrder(this.camera(c.id)), 0, notes, flow, onHit) : null;
      if (!id) this.finishCycle(who, c, flow, 'failed', 'not_verified', clamp(`${CYCLE_TEXT.not_verified}; ${notes.join('; ') || 'no switch to search'}`));
    });
  }

  private finishCycle(who: Who, c: Camera, flow: PowerFlow, state: 'ok' | 'failed', code: string | null, message: string): void {
    this.finish(flow, state, code, state === 'ok' ? null : message);
    // The open request is taken (cleared) before its answer goes out: at most once, also across a crash.
    const req = this.saveCycle(c.id, flow, null);
    this.own(who, c, 'camera.power.cycled', { v: 1, camera: c.proxyCameraId, ok: state === 'ok', message: clamp(message) });
    if (req) this.answer(c.accountId, req, state === 'ok', message);
  }

  // --- the persisted cycle (camera_power_cycles) ----------------------------------------------------
  // Running: the flow, its current switch.cycle and (when a proxy asked) the request. Final (commandId null): the
  // flow only; the request is cleared and returned (the caller answers it). `req` undefined keeps the stored one.
  private saveCycle(cameraId: string, flow: PowerFlow, commandId: string | null, req?: CycleRequest | null): CycleRequest | null {
    try {
      return tx(this.d.db, () => {
        const cur = this.d.db.prepare('SELECT request FROM camera_power_cycles WHERE camera_id = ?').get(cameraId) as { request: string | null } | undefined;
        const kept: CycleRequest | null = req !== undefined ? req : cur?.request ? JSON.parse(cur.request) : null;
        const store = commandId ? kept : null;
        this.d.db.prepare(`INSERT INTO camera_power_cycles (camera_id, flow, command_id, request) VALUES (?,?,?,?)
          ON CONFLICT(camera_id) DO UPDATE SET flow = excluded.flow, command_id = excluded.command_id, request = excluded.request`)
          .run(cameraId, JSON.stringify(flow), commandId, store ? JSON.stringify(store) : null);
        return commandId ? null : kept;
      });
    } catch (e) {
      this.d.log.error({ err: e, cameraId }, 'power_cycle_not_saved');
      return null;
    }
  }

  // On start: every camera's last cycle is shown again; a running one ends when its switch.cycle is final (now, if
  // it already is, or when its answer arrives).
  private restore(): void {
    const rows = this.d.db.prepare('SELECT camera_id, flow, command_id FROM camera_power_cycles').all() as { camera_id: string; flow: string; command_id: string | null }[];
    for (const r of rows) {
      try {
        const flow = JSON.parse(r.flow) as PowerFlow;
        this.lastCycle.set(r.camera_id, flow);
        if (flow.state !== 'running') continue;
        const cmd = r.command_id ? this.commandRow(r.command_id) : null;
        if (!cmd) {
          this.restoredFinal(r.camera_id, null);
          continue;
        }
        if (['queued', 'sent', 'received'].includes(cmd.state)) this.pending.set(cmd.id, (fin) => this.restoredFinal(r.camera_id, fin));
        else this.restoredFinal(r.camera_id, cmd);
      } catch (e) {
        this.d.log.error({ err: e, cameraId: r.camera_id }, 'power_cycle_restore_failed');
      }
    }
  }

  // A cycle that ran across a restart ends with its switch.cycle's final row (null: none left).
  private restoredFinal(cameraId: string, r: CommandRow | null): void {
    const flow = this.lastCycle.get(cameraId);
    if (!flow || flow.state !== 'running') return;
    const c = this.camera(cameraId);
    const args = r?.args ?? {};
    const sw = isObj(args.switch) && typeof args.switch.id === 'string' ? this.d.switches.store.findById(args.switch.id) : null;
    if (r?.state === 'done') return this.finishCycle(SYSTEM, c, flow, 'ok', null, `power-cycled on ${sw?.name ?? 'the switch'} port ${String(args.port)}`);
    const code = r ? r.outcomeCode ?? r.state : 'restart';
    this.finishCycle(SYSTEM, c, flow, 'failed', code, r ? CYCLE_TEXT[code] ?? code : 'cams-admin restarted during the power-cycle');
  }

  private commandRow(id: string): CommandRow | null {
    const r = this.d.db.prepare('SELECT account_id, proxy_id FROM commands WHERE id = ?').get(id) as { account_id: string; proxy_id: string | null } | undefined;
    return r?.proxy_id ? this.d.commands.get(r.account_id, r.proxy_id, id) : null;
  }

  // camera.power.cycle.result to the asking proxy: skipped (logged) when its allow list lacks the entry.
  private answer(accountId: string, req: CycleRequest, ok: boolean, reason: string): void {
    if (!this.allowed(req.proxyId, 'camera.power.cycle.result')) {
      this.d.log.warn({ proxyId: req.proxyId, requestId: req.requestId }, 'power_cycle_result_not_allowed');
      return;
    }
    try {
      this.d.commands.create(SYSTEM.actor, accountId, req.proxyId, 'camera.power.cycle.result',
        { v: 1, camera: req.proxyCameraId, requestId: req.requestId, ok, ...(ok ? {} : { reason: clamp(reason) }) }, { actorType: 'system' });
    } catch (e) {
      this.d.log.warn({ err: e, proxyId: req.proxyId, requestId: req.requestId }, 'power_cycle_result_not_sent');
    }
  }

  // --- survey ------------------------------------------------------------------------------------
  private runSurvey(who: Who, sw: Switch): SurveyStart {
    const cams = this.d.registry.listCameras(sw.accountId).filter((c) => c.power.kind !== 'adapter');
    const withHost = cams.filter((c) => this.hostOf(c));
    const view: SurveyView = {
      switchId: sw.id, at: this.d.clock.now(), state: 'running', commandIds: [],
      results: cams.filter((c) => !this.hostOf(c)).map((c) => ({ cameraId: c.id, camsId: c.camsId, found: false, reason: HOST_UNKNOWN })),
    };
    const open = new Set<string>();
    const end = () => {
      view.state = 'done';
      this.d.live.publishRegistry('switch', sw.id);
      const next = this.queued.get(sw.id);
      if (!next) return;
      this.queued.delete(sw.id);
      this.hook(() => this.survey(next, sw.id));
    };
    const chunks: Camera[][] = [];
    for (let i = 0; i < withHost.length; i += SWITCH_SURVEY_MAX) chunks.push(withHost.slice(i, i + SWITCH_SURVEY_MAX));
    for (const [i, chunk] of chunks.entries()) {
      let id: string;
      try {
        id = this.send(who, sw.accountId, sw.proxyId, 'switch.survey', { v: 1, switch: ref(sw), cameras: chunk.map((c) => ({ camera: c.id, host: this.hostOf(c)! })) }, null, (r) => {
          open.delete(r.id);
          try {
            this.surveyAnswer(who, sw, chunk, r, view);
          } finally {
            if (!open.size) end();
          }
        });
      } catch (e) {
        if (i === 0) throw e;
        view.results.push(...chunk.map((c) => ({ cameraId: c.id, camsId: c.camsId, found: false, reason: `survey not sent: ${errCode(e)}` })));
        continue;
      }
      open.add(id);
      view.commandIds.push(id);
    }
    this.surveys.set(sw.id, view);
    if (!open.size) end();
    return { commandIds: [...view.commandIds], queued: false };
  }

  // found → mapped (setPower when it changed); no_traffic/ambiguous for a camera mapped to this switch → notSeen;
  // not_reachable → reported only.
  private surveyAnswer(who: Who, sw: Switch, chunk: Camera[], r: CommandRow, view: SurveyView): void {
    const results = r.state === 'done' && Array.isArray(r.result?.results) ? (r.result!.results as Record<string, unknown>[]) : null;
    if (!results) {
      const why = `survey ${r.state}${r.outcomeCode ? `: ${CYCLE_TEXT[r.outcomeCode] ?? r.outcomeCode}` : ''}`;
      view.results.push(...chunk.map((c) => ({ cameraId: c.id, camsId: c.camsId, found: false, reason: why })));
      return;
    }
    const byId = new Map(chunk.map((c) => [c.id, c]));
    for (const res of results) {
      const c = typeof res.camera === 'string' ? byId.get(res.camera) : undefined;
      if (!c) continue;
      byId.delete(c.id);
      try {
        if (res.found === true && Number.isSafeInteger(res.port)) {
          const stored = this.applyHit(who, c.id, { sw, port: res.port as number, watts: typeof res.watts === 'number' ? res.watts : 0, poe: res.poe !== false }, 'survey');
          view.results.push({ cameraId: c.id, camsId: c.camsId, found: true, port: res.port as number, kind: stored.kind });
          continue;
        }
        const reason = typeof res.reason === 'string' ? res.reason : 'not found';
        view.results.push({ cameraId: c.id, camsId: c.camsId, found: false, reason });
        // notSeen only when the operator saw no traffic or no clear port (not_reachable: reported only).
        if (reason !== 'no_traffic' && reason !== 'ambiguous') continue;
        const cur = this.camera(c.id).power;
        if (occupies(cur) && cur.switchId === sw.id && !cur.notSeen) this.store(who, this.camera(c.id), { ...cur, notSeen: true }, 'not seen in the survey');
      } catch (e) {
        this.d.log.error({ err: e, cameraId: c.id, switchId: sw.id }, 'power_survey_result_failed');
      }
    }
    for (const c of byId.values()) view.results.push({ cameraId: c.id, camsId: c.camsId, found: false, reason: 'no answer for this camera' });
  }

  // --- helpers -----------------------------------------------------------------------------------
  private send(who: Who, accountId: string, proxyId: string, command: WireCommand, args: Record<string, unknown>, flow: PowerFlow | null, fn: (r: CommandRow) => void): string {
    const cmd = this.d.commands.create(who.actor, accountId, proxyId, command, args, { actorType: this.type(who) });
    this.pending.set(cmd.id, fn);
    flow?.commandIds.push(cmd.id);
    return cmd.id;
  }

  // setPower (audited) and camera.power.set to the camera's proxy.
  private store(who: Who, c: Camera, power: CameraPower, why: string): CameraPower {
    const stored = this.d.switches.store.setPower(c.id, power, who.actor, this.type(who), why);
    this.notify(who, this.camera(c.id));
    return stored;
  }

  private notify(who: Who, c: Camera): void {
    this.d.live.publishRegistry('camera', c.id);
    const p = c.power;
    const sw = occupies(p) ? this.d.switches.store.findById(p.switchId) : null;
    const power = occupies(p)
      ? { kind: p.kind, ...(sw ? { switchName: sw.name.slice(0, 64) } : {}), port: p.port, ...(p.kind === 'poe' ? { watts: p.watts } : {}),
        ...(p.verifiedAt !== undefined ? { verifiedAt: p.verifiedAt } : {}), ...(p.notSeen ? { notSeen: true } : {}) }
      : { kind: p.kind };
    this.own(who, c, 'camera.power.set', { v: 1, camera: c.proxyCameraId, power });
  }

  // A message to the camera's own proxy: skipped (silently) without a proxy or without the allow entry.
  private own(who: Who, c: Camera, command: 'camera.power.set' | 'camera.power.cycling' | 'camera.power.cycled', args: Record<string, unknown>): void {
    if (!c.proxyId || !c.proxyCameraId || !this.allowed(c.proxyId, command)) return;
    try {
      this.d.commands.create(who.actor, c.accountId, c.proxyId, command, args, { actorType: this.type(who) });
    } catch (e) {
      this.d.log.warn({ err: e, cameraId: c.id, command }, 'power_notice_not_sent');
    }
  }

  // The camera's address: the registry host, else (none, or 'from-proxy') the owning proxy's reported camera
  // address (its health summary, ":port" dropped); null when neither exists.
  hostOf(c: Camera): string | null {
    if (c.host && c.host !== 'from-proxy') return c.host;
    if (!c.proxyId || !c.proxyCameraId) return null;
    const a = this.d.status.row(c.proxyId)?.reported?.cameras.find((x) => x.ref === c.proxyCameraId)?.address;
    return a ? bareHost(a) : null;
  }

  // After each heartbeat: a camera whose reported address changed (a later report than the first this run) is a
  // host change for a camera that takes its host from the proxy: a survey of its account (debounced per switch).
  reportedCameras(proxyId: string, cams: { ref: string; address?: string }[]): void {
    const seen = this.addresses.get(proxyId) ?? new Map<string, string>();
    this.addresses.set(proxyId, seen);
    const accounts = new Set<string>();
    for (const rc of cams) {
      if (!rc.address) continue;
      const before = seen.get(rc.ref);
      seen.set(rc.ref, rc.address);
      if (before === undefined || before === rc.address) continue;
      const row = this.d.db.prepare('SELECT account_id, host FROM cameras WHERE proxy_id = ? AND proxy_camera_id = ?').get(proxyId, rc.ref) as { account_id: string; host: string | null } | undefined;
      if (row && (!row.host || row.host === 'from-proxy')) accounts.add(row.account_id);
    }
    for (const a of accounts) this.cameraChanged(a);
  }

  private allowed(proxyId: string, command: string): boolean {
    return !!this.d.status.row(proxyId)?.reported?.commands?.allow?.includes(command);
  }

  private flow(op: FlowOp, force?: boolean): PowerFlow {
    return { op, requestedAt: this.d.clock.now(), ...(op === 'cycle' ? { force: !!force } : {}), state: 'running', code: null, reason: null, commandIds: [], finishedAt: null };
  }
  private finish(flow: PowerFlow, state: 'ok' | 'failed', code: string | null, reason: string | null): void {
    Object.assign(flow, { state, code, reason, finishedAt: this.d.clock.now() });
  }
  private busy(cameraId: string): boolean {
    return this.lastCheck.get(cameraId)?.state === 'running' || this.lastCycle.get(cameraId)?.state === 'running';
  }
  private refuse(code: string, reason: string): PowerOutcome {
    return { ok: false, code, reason };
  }

  private hook(fn: () => unknown): void {
    try {
      fn();
    } catch (e) {
      this.d.log.warn({ err: e }, 'power_hook_failed');
    }
  }

  private camera(id: string, accountId?: string): Camera {
    const r = this.d.db.prepare('SELECT account_id FROM cameras WHERE id = ?').get(id) as { account_id: string } | undefined;
    if (!r || (accountId !== undefined && r.account_id !== accountId)) throw new ApiError(404, 'not_found');
    return this.d.registry.getCamera(r.account_id, id);
  }
  private switchOf(id: string): Switch {
    const s = this.d.switches.store.findById(id);
    if (!s) throw new ApiError(404, 'not_found');
    return s;
  }
  private sysadmin(who: Who): void {
    if (!who.sysadmin) throw new ApiError(403, 'forbidden');
  }
  private type(who: Who): Extract<PowerActorType, 'sysadmin' | 'system' | 'proxy'> {
    return who.system ? 'system' : who.proxy ? 'proxy' : 'sysadmin';
  }
}
