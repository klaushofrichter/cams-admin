import { createHash } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { Logger } from '../log';
import type { CommandRow, Commands, WireCommand } from '../commands/service';
import { validateResultPayload } from '../contract';
import { MOVE_ANSWER_REASONS, MOVE_KINDS } from '../../contract/build';
import { newId } from '../ids';
import { MoveBusy, MoveStore, type Move } from './store';
import { eligibleTargets, precheck, type Candidate, type EligibleTarget, type PrecheckDeps } from './precheck';
import { moveToken, targetAddress, type Resolve } from './token';
import type { MoveApproveEvent, MoveCameraConn, MoveEvent, MovePhaseEvent, MoveRequestEvent, MoveTargetsEvent } from './types';

// The move job, its start (plan Task 4; S §4, §6, §7, §8.1): a source's
// move.targets and move.request events, cams-admin's precheck, move.open to the
// source, then (only once that is done, A15) move.offer to the target, and the
// target's answer relayed to the source as move.answer. Then (plan Task 5,
// S §7, §9.1, §10.2) the source's approval, move.start to the target, move.go
// with the target's key and leaf to the source, the registry switch-over at
// the target's `switched`, move.release, offer expiry and the automatic
// cancel when a side fails before the camera moved. Copying and the end are
// Task 6. Events repeat (cam-proxy re-emits after every welcome): every
// handler here is idempotent, and `resume` re-derives the next command from
// the phase and the move's commands.

// A25: the estimate before any plan exists: every kind of the source's summary,
// at the target's measured rate, plus a per-file overhead (one request, a hash,
// a catalog row). The probe reports 0 when it failed (the target still accepts):
// then a conservative 1 MB/s, well under any LAN path (100 Mbit/s ≈ 12 MB/s).
export const PER_FILE_OVERHEAD_MS = 50;
export const FALLBACK_BPS = 1_000_000;
const SEEN_KEEP_MS = 60 * 60_000;
// S §7: an offer not approved within 30 minutes expires (cam-proxy closes its side itself after 35).
export const OFFER_EXPIRY_MS = 30 * 60_000;
// tick() resumes each move at most this often (a command that can't be queued is not retried every second).
export const RESUME_GAP_MS = 10_000;
// A command that can never be queued for this move: retrying won't help.
const PERMANENT = new Set(['invalid_args', 'not_allowed_on_proxy', 'not_enrolled', 'not_found']);
// Phases before the camera moved: a failure there cancels both sides (S §10.2, A17).
const PRE_SWITCH = new Set(['awaiting-approval', 'approved', 'switching']);
// The target's phases from the switch-over on: one of them while cams-admin is
// still `switching` means the `switched` event was missed (the target re-emits its current phase only).
const TARGET_SWITCHED = new Set(['switched', 'copying', 'copied']);
const FINAL_STATES = new Set(['done', 'refused', 'failed', 'expired', 'unknown']);
const DONE_MAX = 512;
const SEEN_MAX = 2000;

const ANSWER_REASONS = new Set<string>(MOVE_ANSWER_REASONS);
// Plans compared by value: key order is not meaning.
const canonical = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const samePlan = (a: unknown, b: unknown) => a !== null && a !== undefined && canonical(a) === canonical(b);
// The fingerprint of the target's X25519 public key (as cam-proxy audits it): never the key itself in an audit record.
const keyFingerprint = (spkiB64: string) => `SHA256:${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase()}`;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

export function estimateS(summary: unknown, probeBps: number): number {
  let bytes = 0;
  let files = 0;
  const s = (summary && typeof summary === 'object' ? summary : {}) as Record<string, { bytes?: unknown; files?: unknown } | undefined>;
  for (const k of MOVE_KINDS) {
    if (isCount(s[k]?.bytes)) bytes += s[k]!.bytes as number;
    if (isCount(s[k]?.files)) files += s[k]!.files as number;
  }
  const bps = isCount(probeBps) && probeBps > 0 ? probeBps : FALLBACK_BPS;
  return Math.ceil(bytes / bps + (files * PER_FILE_OVERHEAD_MS) / 1000);
}
const bytesOf = (summary: unknown) => MOVE_KINDS.reduce((n, k) => {
  const b = (summary as Record<string, { bytes?: unknown }> | null)?.[k]?.bytes;
  return n + (isCount(b) ? b : 0);
}, 0);

// The offer result's space, as the answer's strict schema takes it.
function answerSpace(x: unknown): Record<string, unknown> | null {
  const s = x as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !isCount(s.needed) || !isCount(s.available) || typeof s.fits !== 'boolean') return null;
  const pk = (s.perKind && typeof s.perKind === 'object' ? s.perKind : {}) as Record<string, unknown>;
  const perKind = Object.fromEntries(MOVE_KINDS.filter((k) => isCount(pk[k])).map((k) => [k, pk[k]]));
  return { needed: s.needed, available: s.available, fits: s.fits, perKind, retentionProposal: s.retentionProposal ?? null };
}

export interface MovesDeps { db: Db; clock: Clock; audit: Audit; registry: Registry; status: StatusStore; commands: Commands; log: Logger; resolve?: Resolve }

// What move.offer needs that the row doesn't keep: the token's plaintext (never
// in the DB) and the camera's connection fields. Held from the request until
// move.open is done; lost on a restart, which fails the move (token_lost).
interface Pending { token: string; camera: MoveCameraConn }

export class Moves {
  readonly store: MoveStore;
  private pending = new Map<string, Pending>();
  // Requests already handled (or in flight), by source and requestId: a repeated event answers nothing new.
  private seen = new Map<string, number>();
  // When tick() last resumed each move (memory).
  private resumedAt = new Map<string, number>();

  constructor(private d: MovesDeps) {
    this.store = new MoveStore(d.db, d.clock);
    d.commands.onFinal((r) => this.onFinal(r));
  }

  private get pd(): PrecheckDeps {
    return { db: this.d.db, registry: this.d.registry, status: this.d.status, store: this.store };
  }

  eligibleTargets(accountId: string, sourceProxyId: string): EligibleTarget[] {
    return eligibleTargets(this.pd, accountId, sourceProxyId);
  }

  precheck(m: Candidate) {
    return precheck(this.pd, m);
  }

  onEvent(proxyId: string, accountId: string, ev: MoveEvent): void {
    switch (ev.kind) {
      case 'move.targets':
        return this.onTargets(proxyId, accountId, ev);
      case 'move.request':
        this.onRequest(proxyId, accountId, ev).catch((e) => this.d.log.error({ err: e, proxyId }, 'move_request_failed'));
        return;
      case 'move.approve':
        return this.onApprove(proxyId, accountId, ev);
      case 'move.phase':
        return this.onPhase(proxyId, accountId, ev);
      default:
        return; // cancel, progress: Task 6
    }
  }

  tick(): void {
    const now = this.d.clock.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_KEEP_MS) this.seen.delete(k);
    for (const id of this.pending.keys()) if (this.store.get(id)?.phase !== 'requested') this.pending.delete(id);
    const active = this.store.active();
    const ids = new Set(active.map((m) => m.id));
    for (const id of this.resumedAt.keys()) if (!ids.has(id)) this.resumedAt.delete(id);
    for (const m of active) {
      try {
        if (m.phase === 'awaiting-approval' && this.expired(m)) this.failMove(m, 'offer_expired');
        else if (now - (this.resumedAt.get(m.id) ?? 0) >= RESUME_GAP_MS) this.resume(m.id);
      } catch (e) {
        this.d.log.error({ err: e, moveId: m.id }, 'move_tick_failed');
      }
    }
  }

  // The hub's "proxy live" hook: the move this proxy takes part in re-derives its next step.
  onLive(proxyId: string): void {
    const m = this.store.byProxy(proxyId);
    if (m) this.resume(m.id);
  }

  // Re-derive the next command from the phase and the move's commands (a
  // restart, a lost write, a reconnect): a missing command is created, a final
  // one whose result was not handled is handled now, an open one is left to the
  // command queue (it re-sends with the same cmdId). Never a second command for a step.
  resume(moveId: string): void {
    const m = this.store.get(moveId);
    if (!m || m.endedAt !== null) return;
    this.resumedAt.set(m.id, this.d.clock.now());
    const step = (proxyId: string, command: WireCommand, create: () => void, final: (r: CommandRow) => void) => {
      const r = this.lastCommand(m, proxyId, command);
      if (!r) return create();
      if (FINAL_STATES.has(r.state)) final(r);
    };
    switch (m.phase) {
      case 'awaiting-approval':
        if (this.expired(m)) this.failMove(m, 'offer_expired');
        return;
      case 'approved':
        return step(m.targetProxyId, 'move.start', () => this.queueStep(m, 'start', () => this.sendStart(m)), (r) => this.onStartFinal(m, r));
      case 'switching':
        return step(m.sourceProxyId, 'move.go', () => this.queueStep(m, 'go', () => this.sendGo(m)), (r) => this.onGoFinal(m, r));
      case 'copying':
        return step(m.sourceProxyId, 'move.release', () => this.queueStep(m, 'release', () => this.sendRelease(m)), (r) => this.onReleaseFinal(m, r));
      default:
        return; // requested and offered: the command queue and Task 4; cleaning on: Task 6
    }
  }

  // The newest command of this name for this move on this proxy.
  private lastCommand(m: Move, proxyId: string, command: WireCommand): CommandRow | null {
    const r = this.d.db.prepare(`SELECT id FROM commands WHERE proxy_id = ? AND command = ? AND json_extract(args, '$.moveId') = ? ORDER BY rowid DESC LIMIT 1`)
      .get(proxyId, command, m.id) as { id: string } | undefined;
    return r ? this.d.commands.get(m.accountId, proxyId, r.id) : null;
  }

  // A step's command; one that can never be queued fails the move (and cancels both), a passing refusal waits for the next resume.
  private queueStep(m: Move, step: string, send: () => { ok: true } | { ok: false; code: string }): void {
    tx(this.d.db, () => {
      const r = send();
      if (!r.ok && PERMANENT.has(r.code)) this.failMoveIn(m, `${step}:${r.code}`);
    });
  }

  private expired(m: Move): boolean {
    return m.offeredAt !== null && this.d.clock.now() - m.offeredAt > OFFER_EXPIRY_MS;
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, this.d.clock.now());
    while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }

  // A system command; {ok:false} (logged) when it can't be queued (the proxy paused, the entry gone, invalid args).
  private send(accountId: string, proxyId: string, command: WireCommand, args: Record<string, unknown>): { ok: true } | { ok: false; code: string } {
    try {
      this.d.commands.create('system', accountId, proxyId, command, args, { actorType: 'system' });
      return { ok: true };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      this.d.log.warn({ proxyId, command, code: e.code }, 'move_command_not_queued');
      return { ok: false, code: e.code };
    }
  }

  private onTargets(proxyId: string, accountId: string, ev: MoveTargetsEvent): void {
    if (!this.once(`t:${proxyId}:${ev.requestId}`)) return;
    this.send(accountId, proxyId, 'move.targets', { v: 1, requestId: ev.requestId, targets: this.eligibleTargets(accountId, proxyId) });
  }

  // --- the request ----------------------------------------------------------------------

  private async onRequest(proxyId: string, accountId: string, ev: MoveRequestEvent): Promise<void> {
    if (this.store.byRequest(proxyId, ev.requestId) || !this.once(`r:${proxyId}:${ev.requestId}`)) return;
    const cam = this.d.db.prepare('SELECT id, cams_id FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?')
      .get(accountId, proxyId, ev.camera.proxyCameraId) as { id: string; cams_id: string } | undefined;
    const ctx = { proxyId, accountId, ev, cameraId: cam?.id ?? null, camsId: cam?.cams_id ?? null };
    // Not in the registry: no move row can name it, and no answer reason says so (the source's request ages out).
    if (!cam) return this.refuse(ctx, 'unknown_camera');
    const cand: Candidate = { accountId, sourceProxyId: proxyId, targetProxyId: ev.target, cameraId: cam.id };
    let pc = this.precheck(cand);
    if (!pc.ok) return this.refuse(ctx, pc.reason);
    const src = this.d.registry.proxyById(proxyId)!;
    const tgt = this.d.registry.proxyById(ev.target)!;
    // The offer names the source's url and TLS name; the token is bound to the target's LAN address (R4).
    if (!src.url || !src.tlsServername) return this.refuse(ctx, 'not_routed', 'source_registry_incomplete');
    const targetIp = await targetAddress(tgt.url, this.d.resolve);
    if (!targetIp) return this.refuse(ctx, 'not_routed', 'target_address');
    pc = this.precheck(cand); // again: things may have changed while resolving
    if (!pc.ok) return this.refuse(ctx, pc.reason);
    const { token, tokenHash } = moveToken();
    let m: Move;
    try {
      m = tx(this.d.db, () => {
        const mv = this.store.create({
          accountId, cameraId: cam.id, sourceProxyId: proxyId, targetProxyId: ev.target, requestId: ev.requestId, summary: ev.summary, settings: ev.settings,
          tokenHash, targetIp, actor: `${ev.actor.origin}:${ev.actor.label}`.slice(0, 100),
        });
        this.audit(mv, 'move-request', 'ok', { phase: 'requested', by: ev.actor }, { actorType: 'proxy', actor: proxyId });
        const open = this.send(accountId, proxyId, 'move.open', { v: 1, moveId: mv.id, requestId: ev.requestId, camera: ev.camera.proxyCameraId, tokenHash, targetIp });
        if (!open.ok) return this.failIn(mv, `open:${open.code}`, null);
        return mv;
      });
    } catch (e) {
      if (e instanceof MoveBusy) return this.refuse(ctx, 'busy');
      throw e;
    }
    if (m.phase === 'requested') this.pending.set(m.id, { token, camera: ev.camera });
  }

  // A request cams-admin refuses before any move row exists (busy and other_account can't have one).
  private refuse(c: { proxyId: string; accountId: string; ev: MoveRequestEvent; cameraId: string | null; camsId: string | null }, reason: string, detail?: string): void {
    const t = this.d.registry.proxyById(c.ev.target);
    // Another account's proxy: its id only, never its name.
    const target = { proxyId: c.ev.target, name: t && t.accountId === c.accountId ? t.name : c.ev.target };
    const moveId = newId('mv');
    tx(this.d.db, () => {
      this.d.audit.write({
        actorType: 'proxy', actor: c.proxyId, action: 'move-request', accountId: c.accountId, targetType: 'camera', targetId: c.cameraId, targetLabel: c.camsId, outcome: 'refused',
        detail: { moveId, requestId: c.ev.requestId, camsId: c.camsId, source: c.proxyId, target: c.ev.target, reason, phase: 'rejected', by: c.ev.actor, ...(detail ? { detail } : {}) },
      });
      if (ANSWER_REASONS.has(reason)) this.send(c.accountId, c.proxyId, 'move.answer', { v: 1, moveId, requestId: c.ev.requestId, target, accept: false, reason });
    });
  }

  // --- command results ----------------------------------------------------------------------

  private onFinal(r: CommandRow): void {
    if (!['move.open', 'move.offer', 'move.start', 'move.go', 'move.release'].includes(r.command)) return;
    const moveId = r.args.moveId;
    const m = typeof moveId === 'string' ? this.store.get(moveId) : null;
    if (!m) return;
    switch (r.command) {
      case 'move.open': return this.onOpenFinal(m, r);
      case 'move.offer': return this.onOfferFinal(m, r);
      case 'move.start': return this.onStartFinal(m, r);
      case 'move.go': return this.onGoFinal(m, r);
      case 'move.release': return this.onReleaseFinal(m, r);
    }
  }

  private onOpenFinal(m: Move, r: CommandRow): void {
    // Late or repeated (an unknown command answered after all): the move has moved on.
    if (m.phase !== 'requested' || r.proxyId !== m.sourceProxyId) return;
    const p = this.pending.get(m.id);
    this.pending.delete(m.id);
    if (r.state !== 'done') {
      // The source didn't open its side: the move fails. Its answer names the source's own refusal when it is one the
      // panel can show (busy, no_site_ca, moves_not_allowed, external_cert); otherwise there is no fitting reason to give.
      const code = r.outcomeCode ?? r.state;
      this.fail(m, `open:${code}`, ANSWER_REASONS.has(code) ? code : null);
      return;
    }
    if (!p) return this.fail(m, 'token_lost', 'target_failed');
    const src = this.d.registry.proxyById(m.sourceProxyId);
    if (!src?.url || !src.tlsServername) return this.fail(m, 'source_registry_incomplete', 'not_routed');
    tx(this.d.db, () => {
      const offer = this.send(m.accountId, m.targetProxyId, 'move.offer', {
        v: 1, moveId: m.id, token: p.token,
        source: { proxyId: src.id, name: src.name, url: src.url, caFingerprints: src.caFingerprints.slice(0, 2), tlsServername: src.tlsServername },
        camera: { camsId: this.camsId(m), ...p.camera },
        summary: m.summary, settings: m.settings,
      });
      if (!offer.ok) return void this.failIn(m, `offer:${offer.code}`, offer.code === 'not_allowed_on_proxy' ? 'moves_not_allowed' : 'target_failed');
      const mv = this.store.setPhase(m.id, 'offered', { offeredAt: this.d.clock.now() });
      this.audit(mv, 'move-offer', 'ok', { phase: 'offered' });
    });
  }

  private onOfferFinal(m: Move, r: CommandRow): void {
    if (m.phase !== 'offered' || r.proxyId !== m.targetProxyId) return;
    const res = r.result as Record<string, unknown> | null;
    if (r.state === 'done' && res?.accept === true) {
      const space = answerSpace(res.space);
      if (!space || !isCount(res.probeBps) || !validateResultPayload('move.offer', res)) return this.fail(m, 'bad_result', 'target_failed');
      const est = estimateS(m.summary, res.probeBps);
      tx(this.d.db, () => {
        const a = this.answer(m, { accept: true, space, estimateS: est });
        const mv = this.store.setPhase(m.id, 'awaiting-approval', { rateBps: res.probeBps as number, etaS: est, bytesTotal: bytesOf(m.summary) });
        this.audit(mv, 'move-offer', 'ok', { phase: 'awaiting-approval', accept: true, estimateS: est, fits: space.fits, probeBps: res.probeBps, ...(a ? {} : { answer: 'not_queued' }) });
      });
      return;
    }
    if (r.state === 'done' && res?.accept === false) return this.reject(m, typeof res.reason === 'string' && ANSWER_REASONS.has(res.reason) ? res.reason : 'target_failed');
    // A2: the proxy's own command check refused it (move.receive not allowed there).
    if (r.state === 'refused' && r.outcomeCode === 'not_allowed') return this.reject(m, 'moves_not_allowed');
    this.fail(m, r.state === 'done' ? 'bad_result' : r.outcomeCode ?? r.state, 'target_failed');
  }

  // --- approval, start, go, switch-over (plan Task 5) -------------------------------------------

  private onApprove(proxyId: string, accountId: string, ev: MoveApproveEvent): void {
    const m = this.store.get(ev.moveId);
    if (!m || m.accountId !== accountId) return this.approveRefused(proxyId, accountId, ev.moveId, null, 'unknown_move');
    // Approving is the only approval (S §7): the source's own page, nowhere else.
    if (proxyId !== m.sourceProxyId) return this.approveRefused(proxyId, accountId, ev.moveId, m, 'not_source');
    if (m.phase !== 'awaiting-approval') {
      if (samePlan(m.plan, ev.plan)) return; // the same approval again (re-sent by the source): nothing new
      return this.approveRefused(proxyId, accountId, ev.moveId, m, m.plan !== null ? 'plan_changed' : 'wrong_phase');
    }
    tx(this.d.db, () => {
      if (this.expired(m)) {
        this.audit(m, 'move-approve', 'refused', { reason: 'offer_expired', phase: m.phase }, { actorType: 'proxy', actor: proxyId });
        this.failMoveIn(m, 'offer_expired');
        return;
      }
      // The plan as the source approved it, unchanged: move.go must carry exactly this one (plan_mismatch otherwise).
      const mv = this.store.setPhase(m.id, 'approved', { plan: ev.plan, approvedAt: this.d.clock.now() });
      this.audit(mv, 'move-approve', 'ok', { phase: 'approved', plan: ev.plan }, { actorType: 'proxy', actor: proxyId });
      const r = this.sendStart(mv);
      if (!r.ok && PERMANENT.has(r.code)) this.failMoveIn(mv, `start:${r.code}`);
    });
  }

  private approveRefused(proxyId: string, accountId: string, moveId: string, m: Move | null, reason: string): void {
    this.d.audit.throttled(`move-approve:${proxyId}:${moveId}:${reason}`, {
      actorType: 'proxy', actor: proxyId, action: 'move-approve', accountId, targetType: 'camera', targetId: m?.cameraId ?? null, targetLabel: m ? this.camsId(m) : null, outcome: 'refused',
      detail: { moveId, reason, ...(m ? { camsId: this.camsId(m), source: m.sourceProxyId, target: m.targetProxyId, phase: m.phase } : {}) },
    });
  }

  private sendStart(m: Move) {
    // B34: the chunks cams-admin already knows as verified (none on a first start), newest last.
    const done = this.store.chunks(m.id).filter((c) => c.state === 'verified').map((c) => c.id).slice(-DONE_MAX);
    return this.send(m.accountId, m.targetProxyId, 'move.start', { v: 1, moveId: m.id, plan: m.plan, settings: m.settings ?? {}, done });
  }
  private sendGo(m: Move) {
    return this.send(m.accountId, m.sourceProxyId, 'move.go', { v: 1, moveId: m.id, plan: m.plan, targetPublicKey: m.targetPublicKey, expectedLeaf: m.leafFingerprint });
  }
  private sendRelease(m: Move) {
    return this.send(m.accountId, m.sourceProxyId, 'move.release', { v: 1, moveId: m.id });
  }

  private onStartFinal(m: Move, r: CommandRow): void {
    if (m.phase !== 'approved' || r.proxyId !== m.targetProxyId) return;
    if (r.state !== 'done') return this.failMove(m, `start:${r.outcomeCode ?? r.state}`); // X15
    const res = r.result;
    if (!res || typeof res.publicKey !== 'string' || typeof res.leafFingerprint !== 'string' || !validateResultPayload('move.start', res)) return this.failMove(m, 'start:bad_result');
    const publicKey = res.publicKey;
    const leaf = res.leafFingerprint;
    tx(this.d.db, () => {
      const mv = this.store.setPhase(m.id, 'switching', { targetPublicKey: publicKey, leafFingerprint: leaf });
      this.audit(mv, 'move-phase', 'ok', { phase: 'switching', leafFingerprint: leaf, publicKeyFingerprint: keyFingerprint(publicKey) });
      const go = this.sendGo(mv);
      if (!go.ok && PERMANENT.has(go.code)) this.failMoveIn(mv, `go:${go.code}`);
    });
  }

  private onGoFinal(m: Move, r: CommandRow): void {
    if (m.phase !== 'switching' || r.proxyId !== m.sourceProxyId) return;
    if (r.state !== 'done') this.failMove(m, `go:${r.outcomeCode ?? r.state}`);
    // done: the source lets the target take the camera; the target reports `switched`.
  }

  private onReleaseFinal(m: Move, r: CommandRow): void {
    if (m.phase !== 'copying' || r.proxyId !== m.sourceProxyId) return;
    // After the switch-over: the camera stays on the target; no automatic cancel (Task 6 owns a cancel back).
    if (r.state !== 'done') this.failMove(m, `release:${r.outcomeCode ?? r.state}`);
  }

  private onPhase(proxyId: string, accountId: string, ev: MovePhaseEvent): void {
    const m = this.store.get(ev.moveId);
    if (!m || m.accountId !== accountId) return;
    // Each side speaks for its own role only.
    if (proxyId !== (ev.role === 'source' ? m.sourceProxyId : m.targetProxyId)) return;
    // X15: an ended move stays ended; a re-emitted phase or failure changes nothing.
    if (m.endedAt !== null) return;
    if (!ev.ok || ev.phase === 'failed') return this.failMove(m, `${ev.role}:${ev.code ?? 'internal'}`);
    if (ev.role === 'target' && TARGET_SWITCHED.has(ev.phase) && m.phase === 'switching') return this.switchOver(m);
    if (ev.role === 'source' && ev.phase === 'released' && m.phase === 'copying') return this.released(m);
    // Other phases: Task 6 (copied, finished, cancelled), or nothing new.
  }

  // S §9.1 step 7: the target has the camera. The registry names the target
  // (its site's TLS name for the camera, the move id) and the source releases
  // the camera; the target copies right after `switched` (cam-proxy P12).
  private switchOver(m: Move): void {
    const tgt = this.d.registry.proxyById(m.targetProxyId);
    const cam = this.d.db.prepare('SELECT proxy_camera_id FROM cameras WHERE id = ?').get(m.cameraId) as { proxy_camera_id: string | null } | undefined;
    if (!tgt?.tlsSite || !cam?.proxy_camera_id) return this.failMove(m, 'switch:registry_incomplete');
    const proxyCameraId = cam.proxy_camera_id;
    try {
      tx(this.d.db, () => {
        this.d.registry.moveCamera('system', m.accountId, m.cameraId, { proxyId: tgt.id, proxyCameraId, tlsServername: `${proxyCameraId}.${tgt.tlsSite}.internal`, moveId: m.id });
        const mv = this.store.setPhase(m.id, 'copying');
        this.audit(mv, 'move-phase', 'ok', { phase: 'copying', switched: true });
        const r = this.sendRelease(mv);
        if (!r.ok && PERMANENT.has(r.code)) this.failMoveIn(mv, `release:${r.code}`);
      });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      this.failMove(m, `switch:${e.code}`);
    }
  }

  // The source let go of the camera (hidden live): the end of the switch-over, recorded once.
  private released(m: Move): void {
    const seen = this.d.db.prepare(`SELECT 1 FROM audit_log WHERE action = 'move-phase' AND target_id = ? AND json_extract(detail, '$.moveId') = ? AND json_extract(detail, '$.phase') = 'released' LIMIT 1`)
      .get(m.cameraId, m.id);
    if (seen) return;
    tx(this.d.db, () => this.audit(m, 'move-phase', 'ok', { phase: 'released' }, { actorType: 'proxy', actor: m.sourceProxyId }));
  }

  // A move that fails from approval on is terminal (X15). Before the camera
  // moved both sides are cancelled (S §10.2, A17): the source only closes its
  // journal (or, once move.go went out, takes the camera back expecting the
  // target's leaf), the target deletes what it took (copied 'delete').
  private failMove(m: Move, code: string): void {
    tx(this.d.db, () => this.failMoveIn(m, code));
  }
  private failMoveIn(m: Move, code: string): Move {
    const cancel = PRE_SWITCH.has(m.phase);
    const mv = this.store.setPhase(m.id, 'failed', { reason: code.slice(0, 64), ...(cancel ? { copiedChoice: 'delete' } : {}) });
    this.audit(mv, 'move-phase', 'failed', { phase: 'failed', from: m.phase, ...(cancel ? { cancel: 'both' } : {}) });
    if (cancel) {
      const goSent = m.leafFingerprint !== null && this.lastCommand(m, m.sourceProxyId, 'move.go') !== null;
      this.send(m.accountId, m.sourceProxyId, 'move.cancel', { v: 1, moveId: m.id, role: 'source', ...(goSent ? { expectedLeaf: m.leafFingerprint } : {}) });
      this.send(m.accountId, m.targetProxyId, 'move.cancel', { v: 1, moveId: m.id, role: 'target', copied: 'delete' });
    }
    return mv;
  }

  // --- endings ---------------------------------------------------------------------------------

  private reject(m: Move, reason: string): void {
    tx(this.d.db, () => {
      this.answer(m, { accept: false, reason });
      const mv = this.store.setPhase(m.id, 'rejected', { reason });
      this.audit(mv, 'move-offer', 'refused', { phase: 'rejected', accept: false, reason });
    });
  }

  private fail(m: Move, code: string, answerReason: string | null): void {
    tx(this.d.db, () => this.failIn(m, code, answerReason));
  }
  // Inside the caller's transaction.
  private failIn(m: Move, code: string, answerReason: string | null): Move {
    this.pending.delete(m.id);
    if (answerReason) this.answer(m, { accept: false, reason: answerReason });
    const mv = this.store.setPhase(m.id, 'failed', { reason: code.slice(0, 64) });
    this.audit(mv, 'move-phase', 'failed', { phase: 'failed', reason: mv.reason, ...(answerReason ? { answered: answerReason } : {}) });
    return mv;
  }

  private answer(m: Move, a: { accept: boolean; reason?: string; space?: Record<string, unknown>; estimateS?: number }): boolean {
    const t = this.d.registry.proxyById(m.targetProxyId);
    return this.send(m.accountId, m.sourceProxyId, 'move.answer', { v: 1, moveId: m.id, requestId: m.requestId, target: { proxyId: m.targetProxyId, name: t?.name ?? m.targetProxyId }, ...a }).ok;
  }

  private camsId(m: Move): string {
    return (this.d.db.prepare('SELECT cams_id FROM cameras WHERE id = ?').get(m.cameraId) as { cams_id: string } | undefined)?.cams_id ?? '';
  }

  // Detail: moveId, camsId, source, target, reason (never a token or its hash).
  private audit(m: Move, action: 'move-request' | 'move-offer' | 'move-phase' | 'move-approve', outcome: 'ok' | 'refused' | 'failed', extra: Record<string, unknown>, who?: { actorType: 'proxy' | 'system'; actor: string }): void {
    const camsId = this.camsId(m);
    this.d.audit.write({
      actorType: who?.actorType ?? 'system', actor: who?.actor ?? 'system', action, accountId: m.accountId, targetType: 'camera', targetId: m.cameraId, targetLabel: camsId, outcome,
      detail: { moveId: m.id, requestId: m.requestId, camsId, source: m.sourceProxyId, target: m.targetProxyId, reason: m.reason, ...extra },
    });
  }
}
