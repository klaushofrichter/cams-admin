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
import type { MoveCameraConn, MoveEvent, MoveRequestEvent, MoveTargetsEvent } from './types';

// The move job, its start (plan Task 4; S §4, §6, §7, §8.1): a source's
// move.targets and move.request events, cams-admin's precheck, move.open to the
// source, then (only once that is done, A15) move.offer to the target, and the
// target's answer relayed to the source as move.answer. The later phases are
// Tasks 5–6. Events repeat (cam-proxy re-emits after every welcome): every
// handler here is idempotent.

// A25: the estimate before any plan exists: every kind of the source's summary,
// at the target's measured rate, plus a per-file overhead (one request, a hash,
// a catalog row). The probe reports 0 when it failed (the target still accepts):
// then a conservative 1 MB/s, well under any LAN path (100 Mbit/s ≈ 12 MB/s).
export const PER_FILE_OVERHEAD_MS = 50;
export const FALLBACK_BPS = 1_000_000;
const SEEN_KEEP_MS = 60 * 60_000;
const SEEN_MAX = 2000;

const ANSWER_REASONS = new Set<string>(MOVE_ANSWER_REASONS);
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
      default:
        return; // approve, cancel, phase, progress: Tasks 5–6
    }
  }

  tick(): void {
    const now = this.d.clock.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_KEEP_MS) this.seen.delete(k);
    for (const id of this.pending.keys()) if (this.store.get(id)?.phase !== 'requested') this.pending.delete(id);
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
    if (r.command !== 'move.open' && r.command !== 'move.offer') return;
    const moveId = r.args.moveId;
    const m = typeof moveId === 'string' ? this.store.get(moveId) : null;
    if (!m) return;
    if (r.command === 'move.open') this.onOpenFinal(m, r);
    else this.onOfferFinal(m, r);
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
  private audit(m: Move, action: 'move-request' | 'move-offer' | 'move-phase', outcome: 'ok' | 'refused' | 'failed', extra: Record<string, unknown>, who?: { actorType: 'proxy' | 'system'; actor: string }): void {
    const camsId = this.camsId(m);
    this.d.audit.write({
      actorType: who?.actorType ?? 'system', actor: who?.actor ?? 'system', action, accountId: m.accountId, targetType: 'camera', targetId: m.cameraId, targetLabel: camsId, outcome,
      detail: { moveId: m.id, requestId: m.requestId, camsId, source: m.sourceProxyId, target: m.targetProxyId, reason: m.reason, ...extra },
    });
  }
}
