import { createHash } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { Logger } from '../log';
import type { LiveHub } from '../live';
import type { CommandRow, Commands, WireCommand } from '../commands/service';
import { validateResultPayload } from '../contract';
import { MOVE_ANSWER_REASONS, MOVE_KINDS } from '../../contract/build';
import { newId } from '../ids';
import { GIVE_UP_CLOSED, GIVE_UP_CLOSED_OPEN_CODES, MoveBusy, MoveStore, type ChunkState, type ChunkStateName, type Move } from './store';
import { eligibleTargets, precheck, type Candidate, type EligibleTarget, type PrecheckDeps } from './precheck';
import { begin, type BeginResult } from './begin';
import type { CamsInstances } from '../cams/instances';
import { moveToken, targetAddress, type Resolve } from './token';
import { Returns, type ReturnKey } from './returns';
import type { MoveCheck, MoveApproveEvent, MoveCameraConn, MoveCancelEvent, MoveEvent, MovePhaseEvent, MoveProgressEvent, MoveRequestEvent, MoveTargetsEvent } from './types';

// The move job, its start (plan Task 4; S §4, §6, §7, §8.1): a source's
// move.targets and move.request events, cams-admin's precheck, move.open to the
// source, then (only once that is done, A15) move.offer to the target, and the
// target's answer relayed to the source as move.answer. Then (plan Task 5,
// S §7, §9.1, §10.2) the source's approval, move.start to the target, move.go
// with the target's key and leaf to the source, the registry switch-over at
// the target's `switched`, move.release, offer expiry and the automatic
// cancel when a side fails before the camera moved. Then (plan Task 6, S §8.3,
// §10.3, §10.4, §11) the target's progress (memory; persisted at most once a
// minute and at every phase change, R8), the time budget, `copied` →
// move.finish to both roles (A5) → done, a cancel (both roles, A17; also while
// awaiting approval, A35) with the registry back to the source, and ending the
// transfer early (the remaining chunks abandoned, A9). Events repeat (cam-proxy
// re-emits after every welcome, and again for a repeated finish or cancel):
// every handler here is idempotent, and `resume` re-derives the next command
// from the phase and the move's commands; tick() also derives the automatic
// cancels of ended moves until they are queued. Step 4 (Task 16): an End
// transfer waits while Archive is still being copied (End after Archive), and
// the source's move.finish goes out only once the target's is final.

// A25: the estimate before any plan exists: every kind of the source's summary,
// at the target's measured rate, plus a per-file overhead (one request, a hash,
// a catalog row), a per-chunk overhead (a manifest, a verify; a chunk is one
// kind's day) and a fixed switch-over overhead: the budget clock starts at the
// approval, so start, go, the certificate, FTP and `switched` count too (the
// local stack measured 40–60 s for 54 MB). Never under a minute. The probe
// reports 0 when it failed (the target still accepts): then a conservative
// 1 MB/s, well under any LAN path (100 Mbit/s ≈ 12 MB/s).
export const PER_FILE_OVERHEAD_MS = 150;
export const PER_CHUNK_OVERHEAD_MS = 1000;
export const SWITCH_OVERHEAD_S = 45;
export const MIN_ESTIMATE_S = 60;
export const FALLBACK_BPS = 1_000_000;
const DAY_MS = 86_400_000;
const SEEN_KEEP_MS = 60 * 60_000;
// S §7: an offer not approved within 30 minutes expires (cam-proxy closes its side itself after 35). A move still
// requested (move.open) or offered (move.offer) that long is stale too: it fails the same way (a lost result must
// not hold both proxies and the camera for good).
export const OFFER_EXPIRY_MS = 30 * 60_000;
const UNAPPROVED = new Set(['requested', 'offered', 'awaiting-approval']);
// tick() resumes each move at most this often (a command that can't be queued is not retried every second).
export const RESUME_GAP_MS = 10_000;
// A command that can never be queued for this move: retrying won't help.
const PERMANENT = new Set(['invalid_args', 'not_allowed_on_proxy', 'not_enrolled', 'not_found']);
// Phases before the camera moved: a failure there cancels both sides (S §10.2, A17; Task 4's open and offer phases too).
const PRE_SWITCH = new Set(['requested', 'offered', 'awaiting-approval', 'approved', 'switching']);
// A cancel (S §10.3 and A35): before the switch-over the move ends at once; in copying the camera comes back first (`cancelling`).
const CANCELLABLE = new Set(['awaiting-approval', 'approved', 'switching', 'copying']);
// R8: progress reaches the DB at most this often per move (and at every phase change).
export const PROGRESS_SAVE_MS = 60_000;
// Ended moves whose automatic cancels tick() still derives when one could not be queued (after that, a target's
// return still derives its cancel: onLive).
export const ENDED_RETRY_MS = 24 * 3600_000;
const GIVEN_UP = 'given_up';
// A cancelling move whose source took the cancel on without reporting `cancelled`: asked again this often (cam-proxy re-emits the terminal phase).
export const CANCEL_RECHECK_MS = 15 * 60_000;
// Backoff for a release (before the source's finish) or a cancel the proxy answered failed: base, doubling per attempt, capped.
export const RELEASE_RETRY_MS = 60_000;
export const CANCEL_RETRY_MS = 60_000;
// Ended moves age out at most hourly, after the proxy's keepDays (30 days when it reported none).
export const PRUNE_EVERY_MS = 3_600_000;
export const DEFAULT_KEEP_DAYS = 30;
const RETRY_CAP_MS = 3600_000;
// Chunk states that end a chunk (cam-proxy's `failed` is "copied with failures"); the others are abandoned at an end transfer.
const FINAL_CHUNK = new Set<ChunkStateName>(['verified', 'skipped', 'failed', 'abandoned']);
// The reason of a cleaning move ended early by a sysadmin (any other reason there is the failure that ended it).
const END_TRANSFER = 'end_transfer';
// The target's phases from the switch-over on: one of them while cams-admin is
// still `switching` means the `switched` event was missed (the target re-emits its current phase only).
const TARGET_SWITCHED = new Set(['switched', 'copying', 'copied']);
const FINAL_STATES = new Set(['done', 'refused', 'failed', 'expired', 'unknown']);
const DONE_MAX = 512;
const SEEN_MAX = 2000;

const ANSWER_REASONS = new Set<string>(MOVE_ANSWER_REASONS);
// Plans compared by value: key order and the order of the kinds are not meaning (like cam-proxy's canonical).
const canonical = (x: unknown): string => JSON.stringify(x, (_k, v) => {
  if (Array.isArray(v)) return v.every((e) => typeof e !== 'object') ? [...v].sort() : v;
  return v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v;
});
// The plan as move-approve audits it: kinds, space, budget, estimate and the setting paths only, never their values.
function planForAudit(plan: unknown): Record<string, unknown> {
  const p = (plan && typeof plan === 'object' ? plan : {}) as Record<string, unknown>;
  const ts = p.targetSettings;
  return {
    transfer: p.transfer, kinds: p.kinds, space: p.space, budgetS: p.budgetS, estimateS: p.estimateS,
    ...('targetSettings' in p ? { targetSettings: ts && typeof ts === 'object' ? Object.keys(ts).sort() : null } : {}),
  };
}
const samePlan = (a: unknown, b: unknown) => a !== null && a !== undefined && canonical(a) === canonical(b);
// The fingerprint of the target's X25519 public key (as cam-proxy audits it): never the key itself in an audit record.
const keyFingerprint = (spkiB64: string) => `SHA256:${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase()}`;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

export function estimateS(summary: unknown, probeBps: number): number {
  let bytes = 0;
  let files = 0;
  let chunks = 0;
  const s = (summary && typeof summary === 'object' ? summary : {}) as Record<string, { bytes?: unknown; files?: unknown; oldest?: unknown; newest?: unknown } | undefined>;
  for (const k of MOVE_KINDS) {
    const e = s[k];
    if (isCount(e?.bytes)) bytes += e.bytes;
    if (!isCount(e?.files) || e.files === 0) continue;
    files += e.files;
    // The kind's days (its chunks), from oldest to newest; never more than its files.
    const days = isCount(e.oldest) && isCount(e.newest) && e.newest >= e.oldest ? Math.floor(e.newest / DAY_MS) - Math.floor(e.oldest / DAY_MS) + 1 : 1;
    chunks += Math.min(days, e.files);
  }
  const bps = isCount(probeBps) && probeBps > 0 ? probeBps : FALLBACK_BPS;
  return Math.max(MIN_ESTIMATE_S, Math.ceil(bytes / bps + (files * PER_FILE_OVERHEAD_MS + chunks * PER_CHUNK_OVERHEAD_MS) / 1000 + SWITCH_OVERHEAD_S));
}
// A camera host's hostname: lowercase, without a port (an IPv6 address without its brackets).
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const i = h.indexOf(':');
  return i >= 0 && h.indexOf(':', i + 1) < 0 ? h.slice(0, i) : h;
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

// camsInstances: a getter (built after the moves; only begin() uses it, for the route and override fixes).
export interface MovesDeps { db: Db; clock: Clock; audit: Audit; registry: Registry; status: StatusStore; commands: Commands; log: Logger; camsInstances: () => CamsInstances; resolve?: Resolve; live?: LiveHub }

// The target's latest progress (R8): memory, saved by `flushIn`.
interface Progress { chunks: Map<string, ChunkStateName>; dirty: Set<string>; bytesDone: number; bytesTotal: number; rateBps: number; etaS: number; savedAt: number; changed: boolean }
type Who = { actorType: 'proxy' | 'system' | 'sysadmin'; actor: string };
const SYSTEM: Who = { actorType: 'system', actor: 'system' };

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
  // Copy progress per move (R8).
  private prog = new Map<string, Progress>();
  // Automatic commands that can never be queued (moveId:proxyId:command): not tried again.
  private gaveUp = new Set<string>();
  // When pruneEnded last ran from tick() (memory).
  private prunedAt = 0;
  // A return's token (plaintext, memory only; a restart re-keys) and the commands sent with it, by return id.
  readonly returnTokens = new Map<string, ReturnKey>();
  private returns: Returns;

  constructor(private d: MovesDeps) {
    this.store = new MoveStore(d.db, d.clock);
    this.returns = new Returns({
      db: d.db, clock: d.clock, log: d.log, registry: d.registry, commands: d.commands, store: this.store, resolve: d.resolve,
      send: (m, proxyId, command, args) => {
        const r = this.send(m.accountId, proxyId, command, args);
        const last = r.ok ? this.lastCommand(m, proxyId, command) : null;
        return r.ok && last ? { ok: true, id: last.id } : { ok: false, code: r.ok ? 'not_found' : r.code };
      },
      audit: (m, action, outcome, extra, who) => this.audit(m, action, outcome, extra, who),
      online: (proxyId) => this.online(proxyId),
      retryDue: (m, proxyId, command, base, last) => this.retryDue(m, proxyId, command, base, last),
      chunkStates: (id) => this.chunkStates(id),
      flushIn: (id) => this.flushIn(id),
      publish: (id) => this.publish(id),
    }, this.returnTokens, CANCEL_RETRY_MS);
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

  // A move started from cams-admin (move.begin plan Task 3): the fixable precheck failures fixed, move.begin queued to the source.
  begin(actor: string, body: unknown): BeginResult {
    return begin({ ...this.pd, audit: this.d.audit, commands: this.d.commands, camsInstances: this.d.camsInstances() }, actor, body);
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
      case 'move.cancel':
        return this.onCancelEvent(proxyId, accountId, ev);
      case 'move.progress':
        return this.onProgress(proxyId, accountId, ev);
    }
  }

  tick(): void {
    const now = this.d.clock.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_KEEP_MS) this.seen.delete(k);
    for (const id of this.pending.keys()) if (this.store.get(id)?.phase !== 'requested') this.pending.delete(id);
    const active = this.store.active();
    // Recently ended moves whose automatic cancel went out (copied_choice set, or switched over: a cancel after the
    // switch-over stores no choice): a cancel that could not be queued is derived again.
    const ended = (this.d.db.prepare(`SELECT id FROM moves WHERE ended_at >= ? AND phase IN ('failed', 'cancelled') AND (copied_choice IS NOT NULL OR switched_at IS NOT NULL)`)
      .all(now - ENDED_RETRY_MS) as { id: string }[]).map((r) => r.id);
    const ids = new Set([...active.map((m) => m.id), ...ended]);
    for (const id of this.resumedAt.keys()) if (!ids.has(id)) this.resumedAt.delete(id);
    for (const id of this.prog.keys()) if (!active.some((m) => m.id === id)) this.prog.delete(id);
    for (const m of active) {
      try {
        if (UNAPPROVED.has(m.phase) && this.expired(m)) this.failMove(m, 'offer_expired');
        else {
          const p = this.prog.get(m.id);
          if ((m.phase === 'copying' || m.phase === 'returning') && p?.changed && now - p.savedAt >= PROGRESS_SAVE_MS) this.saveProgress(m);
          if (now - (this.resumedAt.get(m.id) ?? 0) >= RESUME_GAP_MS) {
            this.maybeEndAfterArchive(m);
            this.resume(m.id);
          }
        }
      } catch (e) {
        this.d.log.error({ err: e, moveId: m.id }, 'move_tick_failed');
      }
    }
    // Done moves whose source cleanup has not landed (ruling b): worked on only while the source is online (nothing is queued to an absent one).
    for (const r of this.d.db.prepare('SELECT id, source_proxy_id FROM moves WHERE cleanup_pending = 1').all() as { id: string; source_proxy_id: string }[]) {
      if (!this.online(r.source_proxy_id) || now - (this.resumedAt.get(r.id) ?? 0) < RESUME_GAP_MS) continue;
      this.resumedAt.set(r.id, now);
      ids.add(r.id);
      try {
        const m = this.store.get(r.id);
        if (m) this.cleanupStep(m);
      } catch (e) {
        this.d.log.error({ err: e, moveId: r.id }, 'move_tick_failed');
      }
    }
    // Done moves whose target finish has not landed: likewise, only while the target is online.
    for (const r of this.d.db.prepare('SELECT id, target_proxy_id FROM moves WHERE target_cleanup_pending = 1').all() as { id: string; target_proxy_id: string }[]) {
      const key = `t:${r.id}`;
      if (!this.online(r.target_proxy_id) || now - (this.resumedAt.get(key) ?? 0) < RESUME_GAP_MS) continue;
      this.resumedAt.set(key, now);
      ids.add(key);
      try {
        const m = this.store.get(r.id);
        if (m) this.targetCleanupStep(m);
      } catch (e) {
        this.d.log.error({ err: e, moveId: r.id }, 'move_tick_failed');
      }
    }
    // Given-up returns whose finishes were not queued or went unanswered: derived again.
    for (const m of this.givenUp()) {
      try {
        this.giveUpFinishes(m);
      } catch (e) {
        this.d.log.error({ err: e, moveId: m.id }, 'move_tick_failed');
      }
    }
    if (now - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = now;
      try {
        this.pruneEnded();
      } catch (e) {
        this.d.log.error({ err: e }, 'move_prune_failed');
      }
    }
    for (const id of ended) {
      if (now - (this.resumedAt.get(id) ?? 0) < RESUME_GAP_MS) continue;
      this.resumedAt.set(id, now);
      try {
        // No outer transaction: tx() writes (the epoch) even when nothing changed; each command is its own.
        const m = this.store.get(id);
        if (m) this.ensureCancels(m);
      } catch (e) {
        this.d.log.error({ err: e, moveId: id }, 'move_tick_failed');
      }
    }
  }

  // Deletes the ended moves past their keep time, with one audit row {count, ids}; writes nothing when none is due.
  pruneEnded(): number {
    const now = this.d.clock.now();
    if (!this.store.prunable(now, DEFAULT_KEEP_DAYS).length) return 0;
    return tx(this.d.db, () => {
      const accounts = new Set(this.store.prunable(now, DEFAULT_KEEP_DAYS).map((id) => this.store.get(id)!.accountId));
      const ids = this.store.prune(now, DEFAULT_KEEP_DAYS);
      if (ids.length) {
        this.d.audit.write({ actorType: 'system', actor: 'system', action: 'moves-pruned', accountId: accounts.size === 1 ? [...accounts][0] : null, outcome: 'ok', detail: { count: ids.length, ids } });
      }
      return ids.length;
    });
  }

  // The hub's "proxy live" hook: the move this proxy takes part in re-derives its next step.
  onLive(proxyId: string): void {
    const m = this.store.byProxy(proxyId);
    if (m?.phase === 'returning') this.returns.reconnected(m, proxyId);
    if (m) this.resume(m.id);
    for (const g of this.givenUp(proxyId)) this.giveUpFinishes(g);
    // A source back with a done move's cleanup still pending (ruling b).
    for (const r of this.d.db.prepare('SELECT id FROM moves WHERE cleanup_pending = 1 AND source_proxy_id = ?').all(proxyId) as { id: string }[]) {
      const mv = this.store.get(r.id);
      if (mv) this.cleanupStep(mv);
    }
    // A target back with a done move's finish still pending.
    for (const r of this.d.db.prepare('SELECT id FROM moves WHERE target_cleanup_pending = 1 AND target_proxy_id = ?').all(proxyId) as { id: string }[]) {
      const mv = this.store.get(r.id);
      if (mv) this.targetCleanupStep(mv);
    }
    // A target back with an ended move's cancel not taken on (also after the ended sweep's ENDED_RETRY_MS): the
    // target must let go of the camera, or it runs on both proxies.
    const cancelsDue = this.d.db.prepare(`SELECT m.id FROM moves m WHERE m.target_proxy_id = ? AND m.phase IN ('failed', 'cancelled') AND (m.copied_choice IS NOT NULL OR m.switched_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.proxy_id = m.target_proxy_id AND c.command = 'move.cancel' AND c.state = 'done' AND json_extract(c.args, '$.moveId') = m.id)`).all(proxyId) as { id: string }[];
    for (const r of cancelsDue) {
      const mv = this.store.get(r.id);
      if (mv) this.ensureTargetCancel(mv);
    }
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
    // A step's command is created with the phase itself (move.open with the row, move.offer with `offered`): none means it could not be queued, and the move already failed.
    const none = () => undefined;
    if (UNAPPROVED.has(m.phase) && this.expired(m)) return this.failMove(m, 'offer_expired');
    switch (m.phase) {
      case 'requested':
        return step(m.sourceProxyId, 'move.open', none, (r) => this.onOpenFinal(m, r));
      case 'offered':
        return step(m.targetProxyId, 'move.offer', none, (r) => this.onOfferFinal(m, r));
      case 'awaiting-approval':
        return;
      case 'approved':
        return step(m.targetProxyId, 'move.start', () => this.queueStep(m, 'start', () => this.sendStart(m)), (r) => this.onStartFinal(m, r));
      case 'switching':
        return step(m.sourceProxyId, 'move.go', () => this.queueStep(m, 'go', () => this.sendGo(m)), (r) => this.onGoFinal(m, r));
      case 'copying':
        return step(m.sourceProxyId, 'move.release', () => this.queueStep(m, 'release', () => this.sendRelease(m)), (r) => this.onReleaseFinal(m, r));
      case 'cleaning':
        return this.checkCleaning(m);
      case 'cancelling':
        return this.cancellingStep(m);
      case 'returning':
        return this.returns.step(m);
      default:
        return;
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

  // From the offer (offered, awaiting approval) or, before it went out, from the request.
  private expired(m: Move): boolean {
    const from = m.phase === 'requested' ? m.createdAt : m.offeredAt;
    return from !== null && this.d.clock.now() - from > OFFER_EXPIRY_MS;
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
    const cam = this.d.db.prepare('SELECT id, cams_id, host, protocol FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?')
      .get(accountId, proxyId, ev.camera.proxyCameraId) as { id: string; cams_id: string; host: string | null; protocol: string | null } | undefined;
    const ctx = { proxyId, accountId, ev, cameraId: cam?.id ?? null, camsId: cam?.cams_id ?? null };
    // Not in the registry: no move row can name it; the source is told so at once (not_registered), not left to wait.
    if (!cam) return this.refuse(ctx, 'not_registered');
    // The offer hands the target the camera's address and protocol as the source reports them: they must be the
    // registry's. A NULL registry host or protocol, and a host "from-proxy", are whatever the source reports; hosts
    // compare by hostname only (case-insensitive, port ignored). Otherwise the proxies disagree: incompatible.
    if (cam.host !== null && cam.host !== 'from-proxy' && hostnameOf(cam.host) !== hostnameOf(ev.camera.host)) return this.refuse(ctx, 'incompatible', 'camera_host');
    if (cam.protocol !== null && cam.protocol !== ev.camera.protocol) return this.refuse(ctx, 'incompatible', 'camera_protocol');
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
          tokenHash, targetIp, actor: `${ev.actor.origin}:${ev.actor.label}`.slice(0, 100), bounds: ev.bounds ?? null,
        });
        this.audit(mv, 'move-request', 'ok', { phase: 'requested', by: ev.actor, autoApprove: (ev.bounds ?? null) !== null }, { actorType: 'proxy', actor: proxyId });
        const open = this.send(accountId, proxyId, 'move.open', { v: 1, moveId: mv.id, requestId: ev.requestId, camera: ev.camera.proxyCameraId, tokenHash, targetIp });
        if (!open.ok) return this.failIn(mv, `open:${open.code}`, 'internal');
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
    // move.begin has no move yet (the source's move.request makes it): a refusal or failure is audited only (A10), the fixes stay.
    // Attributed like its ok row: the requester (the command's actor) and the camera.
    if (r.command === 'move.begin') {
      if (r.state !== 'done') {
        const cam = this.d.db.prepare('SELECT id, cams_id FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?')
          .get(r.accountId, r.proxyId, String(r.args.camera)) as { id: string; cams_id: string } | undefined;
        this.d.audit.write({
          actorType: 'sysadmin', actor: r.actor, action: 'move-begin', accountId: r.accountId, targetType: 'camera', targetId: cam?.id ?? null, targetLabel: cam?.cams_id ?? null, outcome: 'failed',
          detail: { cmdId: r.id, source: r.proxyId, code: r.outcomeCode ?? r.state },
        });
      }
      // The link from the command to its move: the source answered {requestId}, the move.request carries the same id.
      else {
        const requestId = typeof r.result?.requestId === 'string' ? r.result.requestId : null;
        const cam = this.d.db.prepare('SELECT id, cams_id FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?')
          .get(r.accountId, r.proxyId, String(r.args.camera)) as { id: string; cams_id: string } | undefined;
        this.d.audit.write({
          actorType: 'sysadmin', actor: r.actor, action: 'move-begin', accountId: r.accountId, targetType: 'camera', targetId: cam?.id ?? null, targetLabel: cam?.cams_id ?? null, outcome: 'ok',
          detail: { cmdId: r.id, source: r.proxyId, requestId },
        });
      }
      return;
    }
    if (!['move.open', 'move.offer', 'move.start', 'move.go', 'move.release', 'move.finish', 'move.cancel', 'move.return.open', 'move.return.start'].includes(r.command)) return;
    const moveId = r.args.moveId;
    const m = typeof moveId === 'string' ? this.store.get(moveId) : null;
    if (!m) return;
    if (m.returnOf !== null) {
      if (m.phase === 'returning') return this.returns.onFinal(m, r);
      // A given-up return: its open reached the new proxy (or not), the finishes follow.
      if (m.reason === GIVEN_UP) this.giveUpFinishes(m);
      return;
    }
    switch (r.command) {
      case 'move.open': return this.onOpenFinal(m, r);
      case 'move.offer': return this.onOfferFinal(m, r);
      case 'move.start': return this.onStartFinal(m, r);
      case 'move.go': return this.onGoFinal(m, r);
      case 'move.release':
      case 'move.finish':
        // The source's finish follows its release (cam-proxy refuses it before); a done move may still have its cleanup pending.
        if (r.command === 'move.release' && m.phase === 'copying') return this.onReleaseFinal(m, r);
        if (m.phase === 'cleaning') return this.checkCleaning(m);
        if (m.cleanupPending && r.proxyId === m.sourceProxyId) return this.cleanupStep(m);
        if (r.command === 'move.finish' && m.targetCleanupPending && r.proxyId === m.targetProxyId) {
          this.targetCleanupStep(m);
          // The source's finish waited for this one (ruling 6).
          if (m.cleanupPending) this.cleanupStep(m);
        }
        return;
      case 'move.cancel':
        if (r.state === 'done') return;
        this.d.log.warn({ moveId: m.id, proxyId: r.proxyId, state: r.state, code: r.outcomeCode }, 'move_cancel_not_done');
        // While cancelling (and a target's after the move ended) a cancel the proxy did not take on is asked again
        // with a backoff (ensureCancels); each failure audited (throttled).
        if ((r.state === 'failed' || r.state === 'refused') && (m.phase === 'cancelling' || (r.proxyId === m.targetProxyId && m.endedAt !== null))) {
          const role = r.proxyId === m.sourceProxyId ? 'source' : 'target';
          this.d.audit.throttled(`move-cancel-failed:${m.id}:${role}`, {
            actorType: 'system', actor: 'system', action: 'move-cancel', accountId: m.accountId, targetType: 'camera', targetId: m.cameraId, targetLabel: this.camsId(m), outcome: 'failed',
            detail: { moveId: m.id, camsId: this.camsId(m), source: m.sourceProxyId, target: m.targetProxyId, role, phase: m.phase, state: r.state, code: r.outcomeCode, attempts: this.commandCount(m, r.proxyId!, 'move.cancel') },
          });
        }
        return;
    }
  }

  private onOpenFinal(m: Move, r: CommandRow): void {
    // Late or repeated (an unknown command answered after all): the move has moved on.
    if (m.phase !== 'requested' || r.proxyId !== m.sourceProxyId) return;
    const p = this.pending.get(m.id);
    this.pending.delete(m.id);
    if (r.state !== 'done') {
      // The source didn't open its side: the move fails. Its answer names the source's own refusal when it is one the
      // panel can show (busy, no_site_ca, moves_not_allowed, external_cert); any other failure, and a move.open that
      // ended unknown or expired, is `internal` (the source's side, not the target's) so its page doesn't wait.
      const code = r.outcomeCode ?? r.state;
      this.fail(m, `open:${code}`, ANSWER_REASONS.has(code) && code !== 'not_registered' ? code : 'internal');
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
      this.audit(mv, 'move-approve', 'ok', { phase: 'approved', plan: planForAudit(ev.plan) }, { actorType: 'proxy', actor: proxyId });
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
    // After the switch-over the camera stays on the target: a failure the source answered ends the transfer (failMoveIn), never an automatic cancel.
    if (r.state === 'failed' || r.state === 'refused') return this.failMove(m, `release:${r.outcomeCode ?? r.state}`);
    // Expired or unanswered (the source away): the copy goes on; the release is sent again once the source is online (now, or resume: tick, its return).
    if ((r.state === 'expired' || r.state === 'unknown') && this.online(m.sourceProxyId)) this.queueStep(m, 'release', () => this.sendRelease(m));
  }

  // The camera holder's keepDays (how long the records of an ended move stay): `finished` from the target, `cancelled` from the source.
  // Runs before the ended guard: the event may come after the move is done.
  private noteKeepDays(m: Move, ev: MovePhaseEvent): void {
    if (ev.keepDays === undefined || !ev.ok) return;
    const holder = (ev.role === 'target' && ev.phase === 'finished') || (ev.role === 'source' && ev.phase === 'cancelled');
    if (!holder || m.keepDays === ev.keepDays) return;
    this.store.setPhase(m.id, m.phase, { keepDays: ev.keepDays });
  }

  private onPhase(proxyId: string, accountId: string, ev: MovePhaseEvent): void {
    const m = this.store.get(ev.moveId);
    if (!m || m.accountId !== accountId) return;
    // Each side speaks for its own role only.
    if (proxyId !== (ev.role === 'source' ? m.sourceProxyId : m.targetProxyId)) return;
    this.noteKeepDays(m, ev);
    // X15: an ended move stays ended; a re-emitted phase or failure changes nothing.
    if (m.endedAt !== null) return;
    // A return (copy back) has its own steps; it never fails or cancels.
    if (m.phase === 'returning') return this.returns.onPhase(m, ev);
    // A cancel after the switch-over ends when the source has the camera back (cam-proxy reports it only then).
    if (m.phase === 'cancelling') return ev.role === 'source' && ev.phase === 'cancelled' && ev.ok ? this.cancelledBack(m) : undefined;
    // The end is under way: the finish answers decide; a side's `finished` may come before its answer.
    if (m.phase === 'cleaning') return ev.phase === 'finished' ? this.checkCleaning(m) : undefined;
    if (!ev.ok || ev.phase === 'failed') return this.failMove(m, `${ev.role}:${ev.code ?? 'internal'}`);
    if (ev.role === 'target' && TARGET_SWITCHED.has(ev.phase) && m.phase === 'switching') {
      this.switchOver(m);
      const mv = this.store.get(m.id);
      // `copied` while cams-admin missed `switched`: both steps.
      if (ev.phase === 'copied' && mv?.phase === 'copying') this.copied(mv, ev.check ?? null);
      return;
    }
    if (ev.role === 'source' && ev.phase === 'released' && m.phase === 'copying') return this.released(m);
    if (ev.role === 'target' && ev.phase === 'copied' && m.phase === 'copying') return this.copied(m, ev.check ?? null);
    // Other phases: nothing new.
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
  // target's leaf), the target deletes what it took (copied 'delete'). After
  // the switch-over (copying) the camera already works on the target: the
  // transfer ends instead (move.finish abandoned to both, move-done with the
  // failure). While the end is under way (cleaning, cancelling) a failure
  // changes nothing: the finish and cancel answers end the move.
  private failMove(m: Move, code: string): void {
    tx(this.d.db, () => this.failMoveIn(m, code));
  }
  private failMoveIn(m: Move, code: string): Move {
    if (m.phase === 'copying') return this.endTransferIn(m, code, SYSTEM);
    if (m.phase === 'cleaning' || m.phase === 'cancelling' || m.phase === 'returning' || m.endedAt !== null) {
      this.d.log.warn({ moveId: m.id, phase: m.phase, code }, 'move_failure_ignored');
      return m;
    }
    const cancel = PRE_SWITCH.has(m.phase);
    const mv = this.store.setPhase(m.id, 'failed', { reason: code.slice(0, 64), ...(cancel ? { copiedChoice: 'delete' } : {}) });
    this.audit(mv, 'move-phase', 'failed', { phase: 'failed', from: m.phase, ...(cancel ? { cancel: 'both' } : {}) });
    if (cancel) this.ensureCancels(mv);
    return mv;
  }

  // --- progress, budget (plan Task 6, S §8.3, R8) ---------------------------------------------

  // The move with the target's latest progress (memory) over the stored row.
  current(moveId: string): Move | null {
    const m = this.store.get(moveId);
    const p = m ? this.prog.get(m.id) : undefined;
    return m && p ? { ...m, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, rateBps: p.rateBps, etaS: p.etaS } : m;
  }

  // Every chunk's state: the stored ones with the memory's newer ones over them.
  chunkStates(moveId: string): ChunkState[] {
    const all = new Map(this.store.chunks(moveId).map((c) => [c.id, c.state]));
    for (const [id, st] of this.prog.get(moveId)?.chunks ?? []) all.set(id, st);
    return [...all].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, state]) => ({ id, state }));
  }

  // The target's move.progress: memory and the live view at once; the DB at most once a minute (R8), and once when the budget runs out.
  private onProgress(proxyId: string, accountId: string, ev: MoveProgressEvent): void {
    const m = this.store.get(ev.moveId);
    if (!m || m.accountId !== accountId || proxyId !== m.targetProxyId || (m.phase !== 'copying' && m.phase !== 'returning')) return;
    const now = this.d.clock.now();
    let p = this.prog.get(m.id);
    if (!p) {
      p = { chunks: new Map(), dirty: new Set(), bytesDone: 0, bytesTotal: 0, rateBps: 0, etaS: 0, savedAt: now, changed: false };
      this.prog.set(m.id, p);
    }
    for (const c of ev.chunks) {
      if (p.chunks.get(c.id) === c.state) continue;
      p.chunks.set(c.id, c.state);
      p.dirty.add(c.id);
    }
    Object.assign(p, { bytesDone: ev.bytesDone, bytesTotal: ev.bytesTotal, rateBps: ev.rateBps, etaS: ev.etaS, changed: true });
    const budgetS = (m.plan as { budgetS?: unknown } | null)?.budgetS;
    // A return has no budget (ruling 8): its plan's budgetS only paces the copier.
    if (m.returnOf === null && m.budgetExceededAt === null && m.approvedAt !== null && isCount(budgetS) && now > m.approvedAt + budgetS * 1000 && p.bytesDone < p.bytesTotal) {
      // S §8.3: the copy goes on (never faster); audited once.
      tx(this.d.db, () => {
        const mv = this.store.setPhase(m.id, m.phase, { ...this.flushIn(m.id), budgetExceededAt: now });
        this.audit(mv, 'move-budget-exceeded', 'ok', { phase: mv.phase, budgetS, approvedAt: m.approvedAt, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, rateBps: p.rateBps, etaS: p.etaS });
      });
    } else if (now - p.savedAt >= PROGRESS_SAVE_MS) this.saveProgress(m);
    this.maybeEndAfterArchive(m);
    this.publish(m.id);
  }

  private saveProgress(m: Move): void {
    tx(this.d.db, () => this.store.setPhase(m.id, m.phase, this.flushIn(m.id)));
  }

  // Inside a transaction: the memory's changed chunk states into the DB; the
  // byte counts come back as a setPhase patch (every phase change carries them).
  private flushIn(moveId: string): Partial<Move> {
    const p = this.prog.get(moveId);
    if (!p) return {};
    this.store.saveChunks(moveId, [...p.dirty].map((id) => ({ id, state: p.chunks.get(id)! })));
    p.dirty.clear();
    p.changed = false;
    p.savedAt = this.d.clock.now();
    return { bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, rateBps: p.rateBps, etaS: p.etaS };
  }

  private publish(moveId: string): void {
    this.d.live?.publishRegistry('move', moveId);
  }

  private online(proxyId: string): boolean {
    return this.d.status.row(proxyId)?.connected === true;
  }

  // The newest command for this step, created when there is none (or, with `again`, when the last one calls for another).
  // A command that can never be queued is not tried again; a passing refusal waits for the next resume (tick, a reconnect).
  private ensure(m: Move, proxyId: string, command: WireCommand, args: Record<string, unknown>, again?: (last: CommandRow) => boolean): CommandRow | null {
    const last = this.lastCommand(m, proxyId, command);
    if (last && !(again && FINAL_STATES.has(last.state) && again(last))) return last;
    const key = `${m.id}:${proxyId}:${command}`;
    if (this.gaveUp.has(key)) return last;
    const r = this.send(m.accountId, proxyId, command, args);
    if (!r.ok && PERMANENT.has(r.code)) this.gaveUp.add(key);
    return r.ok ? this.lastCommand(m, proxyId, command) : last;
  }

  // A cancel goes to both roles (A17): the target with the choice for copied
  // content, the source (with the target's leaf once move.go went out).
  // Each is created until it is queued (tick, resume); one that expired unsent is sent again while its proxy is online.
  // While cancelling (after the switch-over) nothing goes out until the source
  // is online (ruling a): the camera keeps working on the target, which lets go
  // only when the source can take it back. A cancel answered failed or refused
  // there is asked again with a backoff.
  // A target cancel answered failed or refused is also asked again after the
  // move ended (the source's `cancelled` came first, or an automatic cancel):
  // the target must let go of the camera (the ended sweep, ENDED_RETRY_MS).
  private ensureCancels(m: Move): void {
    const cancelling = m.phase === 'cancelling';
    if (cancelling && !this.online(m.sourceProxyId)) return;
    const { unsent, failedAgain } = this.cancelRetry(m);
    const goSent = m.leafFingerprint !== null && this.lastCommand(m, m.sourceProxyId, 'move.go') !== null;
    this.ensureTargetCancel(m);
    this.ensure(m, m.sourceProxyId, 'move.cancel', { v: 1, moveId: m.id, role: 'source', ...(goSent ? { expectedLeaf: m.leafFingerprint } : {}) }, (r) =>
      unsent(m.sourceProxyId)(r) || failedAgain(m.sourceProxyId)(r) || (cancelling && r.state === 'done' && this.d.clock.now() - (r.finishedAt ?? 0) >= CANCEL_RECHECK_MS && this.online(m.sourceProxyId)));
  }

  // When a cancel is asked again: one that went unanswered (expired, unknown) while its proxy is online; one answered
  // failed or refused while cancelling (and a target's after the move ended), with a backoff.
  private cancelRetry(m: Move) {
    const cancelling = m.phase === 'cancelling';
    const unsent = (p: string) => (r: CommandRow) => (r.state === 'expired' || r.state === 'unknown') && this.online(p);
    const retrying = (p: string) => cancelling || (p === m.targetProxyId && m.endedAt !== null);
    const failedAgain = (p: string) => (r: CommandRow) => retrying(p) && (r.state === 'failed' || r.state === 'refused') && this.online(p) && this.retryDue(m, p, 'move.cancel', CANCEL_RETRY_MS, r);
    return { unsent, failedAgain };
  }

  // The target's cancel, with the choice for copied content (no outer transaction: reads only unless one is due).
  // No choice stored (a cancel after the switch-over: the content is copied back) → 'age-out', the safe one should
  // a proxy not yet know the return.
  private ensureTargetCancel(m: Move): void {
    if (m.phase === 'cancelling' && !this.online(m.sourceProxyId)) return;
    const { unsent, failedAgain } = this.cancelRetry(m);
    this.ensure(m, m.targetProxyId, 'move.cancel', { v: 1, moveId: m.id, role: 'target', copied: m.copiedChoice === 'delete' ? 'delete' : 'age-out' }, (r) => unsent(m.targetProxyId)(r) || failedAgain(m.targetProxyId)(r));
  }

  private commandCount(m: Move, proxyId: string, command: WireCommand): number {
    return (this.d.db.prepare(`SELECT COUNT(*) AS n FROM commands WHERE proxy_id = ? AND command = ? AND json_extract(args, '$.moveId') = ?`).get(proxyId, command, m.id) as { n: number }).n;
  }

  // Another try is due: the last one ended BASE · 2^(attempts-1) ago (capped at an hour).
  private retryDue(m: Move, proxyId: string, command: WireCommand, base: number, last: CommandRow): boolean {
    const n = this.commandCount(m, proxyId, command);
    const wait = Math.min(base * 2 ** Math.max(0, n - 1), RETRY_CAP_MS);
    return this.d.clock.now() - (last.finishedAt ?? last.createdAt) >= wait;
  }

  // --- cancel (S §10.3, A17, A35) ---------------------------------------------------------------

  // The sysadmin's cancel (the API). 404 unknown, 409 outside awaiting-approval|approved|switching|copying (a return
  // is never cancellable). In copying `copied` is ignored (ruling 18: the content is copied back), so not checked.
  cancel(actor: string, moveId: string, copied: unknown): Move {
    const m = this.store.get(moveId);
    if (m?.phase !== 'copying' && copied !== 'delete' && copied !== 'age-out') throw new ApiError(400, 'invalid_copied');
    if (!m) throw new ApiError(404, 'not_found');
    if (!CANCELLABLE.has(m.phase)) throw new ApiError(409, 'wrong_phase');
    return tx(this.d.db, () => this.cancelIn(m, copied as 'delete' | 'age-out', { actorType: 'sysadmin', actor }));
  }

  // The source page's cancel (cam-proxy's POST /control/moves/:id/cancel). Only the source may; outside the phases refused (audited, throttled).
  private onCancelEvent(proxyId: string, accountId: string, ev: MoveCancelEvent): void {
    const m = this.store.get(ev.moveId);
    if (!m || m.accountId !== accountId || proxyId !== m.sourceProxyId || !CANCELLABLE.has(m.phase)) {
      const reason = !m || m.accountId !== accountId ? 'unknown_move' : proxyId !== m.sourceProxyId ? 'not_source' : 'wrong_phase';
      this.d.audit.throttled(`move-cancel:${proxyId}:${ev.moveId}:${reason}`, {
        actorType: 'proxy', actor: proxyId, action: 'move-cancel', accountId, targetType: 'camera', targetId: m && m.accountId === accountId ? m.cameraId : null, outcome: 'refused',
        detail: { moveId: ev.moveId, reason, ...(m && m.accountId === accountId ? { phase: m.phase } : {}) },
      });
      return;
    }
    tx(this.d.db, () => this.cancelIn(m, ev.copied, { actorType: 'proxy', actor: proxyId }));
  }

  // Before the switch-over the registry still names the source: the move ends
  // at once (`cancelled`), the cancels go out. In copying the camera comes back
  // first (`cancelling`); the registry follows the source's `cancelled`, and a
  // return copies back what the target captured: the copied choice is ignored
  // there (stored as null, ruling 18; the target's cancel says 'age-out', and
  // cam-proxy keeps everything after the switch-over anyway).
  private cancelIn(m: Move, copied: 'delete' | 'age-out', who: Who): Move {
    const back = m.phase === 'copying';
    const mv = this.store.setPhase(m.id, back ? 'cancelling' : 'cancelled', { ...this.flushIn(m.id), copiedChoice: back ? null : copied });
    this.audit(mv, 'move-cancel', 'ok', { phase: mv.phase, from: m.phase, copied: back ? null : copied, ...(back ? { copyBack: true } : {}) }, who);
    this.ensureCancels(mv);
    this.publish(m.id);
    return mv;
  }

  // Reads only unless a command is missing (no outer transaction: tx() always writes).
  private cancellingStep(m: Move): void {
    this.ensureCancels(m);
  }

  // The source has the camera back (its `cancelled`): the registry names the
  // source again under its own site's TLS name (move_id stays, A16); the move is
  // cancelled and its return (the copy back) created in the same transaction: a
  // cancelled switched-over move is never without its return (prune keeps it).
  private cancelledBack(m: Move): void {
    const src = this.d.registry.proxyById(m.sourceProxyId);
    const cam = this.d.db.prepare('SELECT proxy_camera_id FROM cameras WHERE id = ?').get(m.cameraId) as { proxy_camera_id: string | null } | undefined;
    if (!src || !cam?.proxy_camera_id) return void this.d.log.error({ moveId: m.id }, 'move_cancel_registry_incomplete');
    const proxyCameraId = cam.proxy_camera_id;
    let ret: Move | null;
    try {
      ret = tx(this.d.db, () => {
        this.d.registry.moveCamera('system', m.accountId, m.cameraId, { proxyId: src.id, proxyCameraId, tlsServername: src.tlsSite ? `${proxyCameraId}.${src.tlsSite}.internal` : null, moveId: m.id });
        const mv = this.store.setPhase(m.id, 'cancelled');
        this.audit(mv, 'move-phase', 'ok', { phase: 'cancelled', from: 'cancelling', switchedBack: true }, { actorType: 'proxy', actor: m.sourceProxyId });
        return this.returns.createReturn(mv);
      });
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof MoveBusy)) throw e;
      // Stays cancelling: the source's next `cancelled` (a re-asked cancel) tries again.
      this.d.log.error({ moveId: m.id, code: e instanceof ApiError ? e.code : 'busy' }, 'move_cancel_registry_failed');
      return;
    }
    this.publish(m.id);
    if (ret) {
      this.publish(ret.id);
      this.resume(ret.id);
    }
  }

  // --- finish, end transfer, done (S §10.4, §11, A5, A9) ----------------------------------------

  // The target copied everything: cleaning, move.finish to both roles (the source purges, the target closes).
  private copied(m: Move, check: MoveCheck | null): void {
    tx(this.d.db, () => {
      const mv = this.store.setPhase(m.id, 'cleaning', { ...this.flushIn(m.id), check });
      if (check) this.audit(mv, 'move-check', check.complete ? 'ok' : 'failed', { check }, { actorType: 'proxy', actor: m.targetProxyId });
      this.audit(mv, 'move-phase', 'ok', { phase: 'cleaning' }, { actorType: 'proxy', actor: m.targetProxyId });
      this.ensureFinishes(mv);
    });
    this.publish(m.id);
  }

  // The sysadmin ends the transfer early (S §10.4): only in copying. While
  // Archive is still being copied the end waits for it ("End after Archive",
  // step-4 §2, ruling 12): the request is stored (once) and the move stays
  // copying; maybeEndAfterArchive ends it when the Archive chunks are final.
  endTransfer(actor: string, moveId: string): Move {
    const m = this.store.get(moveId);
    if (!m) throw new ApiError(404, 'not_found');
    if (m.phase !== 'copying') throw new ApiError(409, 'wrong_phase');
    if (this.archivePending(m)) {
      if (m.endRequested) return m;
      return tx(this.d.db, () => {
        const mv = this.store.setPhase(m.id, 'copying', { ...this.flushIn(m.id), endRequested: { at: this.d.clock.now(), actorType: 'sysadmin', actor } });
        this.audit(mv, 'move-end-after-archive', 'ok', { phase: 'copying', archiveChunks: this.archiveChunks(m.id).length }, { actorType: 'sysadmin', actor });
        this.publish(m.id);
        return mv;
      });
    }
    return tx(this.d.db, () => this.endTransferIn(m, END_TRANSFER, { actorType: 'sysadmin', actor }));
  }

  // Give up copy back (ruling 11, spec decision 3): the sysadmin ends a return that cannot finish. The return is
  // `returned` with reason given_up; move.finish {return, abandoned} goes to both sides (each while online, derived
  // again by tick and onLive until answered). Nothing is deleted: the content on either proxy stays as it is.
  giveUp(actor: string, moveId: string): Move {
    const m = this.store.get(moveId);
    if (!m) throw new ApiError(404, 'not_found');
    if (m.phase !== 'returning') throw new ApiError(409, 'wrong_phase');
    const mv = tx(this.d.db, () => {
      const v = this.store.setPhase(m.id, 'returned', { ...this.flushIn(m.id), reason: GIVEN_UP });
      this.audit(v, 'move-give-up', 'ok', { phase: 'returned', returnOf: m.returnOf, bytesDone: v.bytesDone, bytesTotal: v.bytesTotal }, { actorType: 'sysadmin', actor });
      return v;
    });
    this.returnTokens.delete(m.id);
    this.giveUpFinishes(mv);
    this.publish(m.id);
    return mv;
  }

  // move.finish {return, abandoned} to both sides of a given-up return, until each is answered (no time bound, like
  // target_cleanup_pending). Only to an online side, and a new one only when the last went unanswered (expired,
  // unknown: the command's own expiry paces it) or is not an abandoned finish (a normal return finish queued by
  // the return before Give up: the abandoned one goes out after it, M1).
  private giveUpFinishes(m: Move): void {
    for (const [proxyId, role] of [[m.sourceProxyId, 'source'], [m.targetProxyId, 'target']] as const) {
      // The new proxy (the return's source) finds its record only by a return id it has seen in move.return.open:
      // an open that never got `done` there is sent first (a fresh token, only its hash kept), the finish follows it.
      if (proxyId === m.sourceProxyId && this.giveUpOpened(m) !== 'opened') continue;
      const last = this.lastCommand(m, proxyId, 'move.finish');
      const abandoned = last?.args.abandoned === true;
      if (last && abandoned && !(last.state === 'expired' || last.state === 'unknown')) continue;
      if (!this.online(proxyId)) continue;
      const key = `${m.id}:${proxyId}:move.finish:give-up`;
      if (this.gaveUp.has(key)) continue;
      const r = this.send(m.accountId, proxyId, 'move.finish', { v: 1, moveId: m.id, role, abandoned: true, return: true });
      if (!r.ok && PERMANENT.has(r.code)) this.gaveUp.add(key);
    }
  }

  // 'opened': the new proxy answered the return's move.return.open `done`. 'closed': it refused the latest one as a
  // proxy without the return (an old release) or has no record of it (unknown_move): nothing to close there, the side
  // counts as closed (GIVE_UP_CLOSED). Otherwise one is sent (when due; the original's address resolved first when it
  // never was) and 'waiting' returned.
  private giveUpOpened(m: Move): 'opened' | 'closed' | 'waiting' {
    const proxyId = m.sourceProxyId;
    const last = this.lastCommand(m, proxyId, 'move.return.open');
    if (last?.state === 'done') return 'opened';
    if (last && (last.state === 'refused' || last.state === 'failed') && GIVE_UP_CLOSED_OPEN_CODES.includes(last.outcomeCode ?? '')) return 'closed';
    if (!this.online(proxyId)) return 'waiting';
    if (!m.targetIp) {
      this.returns.resolveAddress(m, () => {
        const mv = this.store.get(m.id);
        if (mv) this.giveUpFinishes(mv);
      });
      return 'waiting';
    }
    if (last) {
      if (!FINAL_STATES.has(last.state)) return 'waiting';
      const unanswered = last.state === 'expired' || last.state === 'unknown';
      if (!unanswered && !this.retryDue(m, proxyId, 'move.return.open', CANCEL_RETRY_MS, last)) return 'waiting';
    }
    const key = `${m.id}:${proxyId}:move.return.open:give-up`;
    if (this.gaveUp.has(key)) return 'waiting';
    const { tokenHash } = moveToken();
    const mv = tx(this.d.db, () => this.store.setPhase(m.id, 'returned', { tokenHash }));
    const r = this.send(m.accountId, proxyId, 'move.return.open', { v: 1, moveId: m.id, returnOf: m.returnOf, tokenHash: mv.tokenHash, targetIp: m.targetIp });
    if (!r.ok && PERMANENT.has(r.code)) this.gaveUp.add(key);
    return 'waiting';
  }

  // Given-up returns where a side is not closed yet (no answered abandoned finish, nor a refused open that closes it), however long ago.
  private givenUp(proxyId?: string): Move[] {
    const rows = this.d.db.prepare(`SELECT id FROM moves WHERE phase = 'returned' AND reason = ?${proxyId ? ' AND (source_proxy_id = ? OR target_proxy_id = ?)' : ''}
      AND NOT (${GIVE_UP_CLOSED})`)
      .all(...(proxyId ? [GIVEN_UP, proxyId, proxyId] : [GIVEN_UP])) as { id: string }[];
    return rows.map((r) => this.store.get(r.id)).filter((x): x is Move => x !== null);
  }

  private archiveChunks(moveId: string): ChunkState[] {
    return this.chunkStates(moveId).filter((c) => c.id.startsWith('archive:'));
  }

  // Archive still to be copied: the plan copies it, the source's summary has Archive files, and an Archive chunk is
  // not final yet (or none is known yet: the target lists them as it goes).
  archivePending(m: Move): boolean {
    const kinds = (m.plan as { kinds?: unknown } | null)?.kinds;
    if (!Array.isArray(kinds) || !kinds.includes('archive')) return false;
    const files = (m.summary as { archive?: { files?: unknown } } | null)?.archive?.files;
    if (!isCount(files) || files === 0) return false;
    const chunks = this.archiveChunks(m.id);
    return chunks.length === 0 || chunks.some((c) => !FINAL_CHUNK.has(c.state));
  }

  // A stored End transfer whose Archive is now final: the transfer ends, by the one who asked (from onProgress and tick).
  private maybeEndAfterArchive(m0: Move): void {
    const m = this.store.get(m0.id);
    if (!m || m.phase !== 'copying' || !m.endRequested || this.archivePending(m)) return;
    const { actorType, actor } = m.endRequested;
    const who: Who = { actorType: actorType === 'sysadmin' || actorType === 'proxy' ? actorType : 'system', actor };
    tx(this.d.db, () => this.endTransferIn(m, END_TRANSFER, who));
  }

  // Inside a transaction: the chunks not final yet are abandoned (stored as
  // such, A9), cleaning with the reason (end_transfer, or the failure that
  // ended it), move.finish {abandoned} to the target and, when it is online, to the source.
  private endTransferIn(m: Move, reason: string, who: Who): Move {
    const patch = this.flushIn(m.id);
    const left: ChunkState[] = this.chunkStates(m.id).filter((c) => !FINAL_CHUNK.has(c.state)).map((c) => ({ id: c.id, state: 'abandoned' }));
    this.store.saveChunks(m.id, left);
    const p = this.prog.get(m.id);
    for (const c of left) p?.chunks.set(c.id, 'abandoned');
    const mv = this.store.setPhase(m.id, 'cleaning', { ...patch, reason: reason.slice(0, 64) });
    const failure = reason === END_TRANSFER ? null : mv.reason;
    this.audit(mv, 'move-end-transfer', failure ? 'failed' : 'ok', { phase: 'cleaning', abandoned: left.length, sourceOnline: this.online(m.sourceProxyId), ...(failure ? { failure } : {}) }, who);
    this.ensureFinishes(mv);
    this.publish(m.id);
    return mv;
  }

  // move.finish to both roles (A5), each until queued; one that went
  // unanswered (expired, unknown) is sent again once its proxy is online.
  private ensureFinishes(m: Move): { source: CommandRow | null; target: CommandRow | null } {
    const unsent = (p: string) => (r: CommandRow) => (r.state === 'expired' || r.state === 'unknown') && this.online(p);
    const target = this.ensure(m, m.targetProxyId, 'move.finish', { v: 1, moveId: m.id, role: 'target', abandoned: m.reason !== null }, unsent(m.targetProxyId));
    return { source: this.sourceFinish(m), target };
  }

  // The source's finish, sent only once the source has released the camera
  // (cam-proxy refuses it before: wrong_phase) and the target's finish is
  // final (ruling 6, every move: the target's outcome, its keep list, lands on
  // the source before the source deletes). Until then the release is
  // derived: created when missing, again with a backoff when it failed or went
  // unanswered. Nothing is queued to an offline source (it would only expire).
  private sourceFinish(m: Move): CommandRow | null {
    const src = m.sourceProxyId;
    const last = this.lastCommand(m, src, 'move.finish');
    if (last && !((last.state === 'expired' || last.state === 'unknown') && this.online(src))) return last;
    if (!this.online(src)) return last;
    if (!this.targetFinishFinal(m)) return last;
    const rel = this.lastCommand(m, src, 'move.release');
    if (rel?.state !== 'done') {
      if (!rel || (FINAL_STATES.has(rel.state) && this.retryDue(m, src, 'move.release', RELEASE_RETRY_MS, rel))) this.ensure(m, src, 'move.release', { v: 1, moveId: m.id }, () => true);
      return last;
    }
    return this.ensure(m, src, 'move.finish', { v: 1, moveId: m.id, role: 'source', abandoned: m.reason !== null }, () => true);
  }

  // The target's newest finish is final: answered (done, failed, refused) or gone unanswered (expired, unknown); or it
  // can never be queued (the allow entry gone).
  private targetFinishFinal(m: Move): boolean {
    const t = this.lastCommand(m, m.targetProxyId, 'move.finish');
    return t ? FINAL_STATES.has(t.state) : this.gaveUp.has(`${m.id}:${m.targetProxyId}:move.finish`);
  }

  // The source's release failed or went unanswered (the last one is final, not done).
  private releaseFailing(m: Move): boolean {
    const rel = this.lastCommand(m, m.sourceProxyId, 'move.release');
    return rel !== null && FINAL_STATES.has(rel.state) && rel.state !== 'done';
  }

  // The move is done once both finishes are final. A move ended early (end
  // transfer, a failure after the switch-over) does not wait for a source that
  // is offline or has not released: it is done with the source cleanup pending
  // (ruling b), which tick keeps deriving. Reads only until then (tick calls it
  // every RESUME_GAP_MS; tx() always writes).
  private checkCleaning(m0: Move): void {
    const m = this.store.get(m0.id);
    if (!m || m.phase !== 'cleaning') return;
    const { source, target } = this.ensureFinishes(m);
    // A finish counts only once answered: one that expired or went unanswered is sent again (now, or once its proxy is back).
    const unanswered = (r: CommandRow | null) => r !== null && (r.state === 'expired' || r.state === 'unknown');
    const answered = (r: CommandRow | null) => r !== null && FINAL_STATES.has(r.state) && !unanswered(r);
    // A finish that can never be queued (the allow entry gone) does not hold the move open.
    const never = (proxyId: string) => this.gaveUp.has(`${m.id}:${proxyId}:move.finish`);
    // A move ended early does not wait for an absent target: done with the target cleanup pending (onLive and tick derive its finish).
    const targetDone = answered(target) || never(m.targetProxyId);
    const targetPending = !targetDone && m.reason !== null && unanswered(target);
    if (!targetDone && !targetPending) return;
    const sourceDone = answered(source) || never(m.sourceProxyId);
    const pending = !sourceDone && m.reason !== null && (!this.online(m.sourceProxyId) || this.releaseFailing(m) || unanswered(source));
    if (!sourceDone && !pending) return;
    tx(this.d.db, () => {
      if (this.store.get(m.id)?.phase === 'cleaning') this.done(m, pending ? null : source, pending, targetPending);
    });
  }

  // Inside a transaction: done, audited move-done with the totals from the chunk states (S §12).
  private done(m: Move, src: CommandRow | null, pending: boolean, targetPending: boolean): void {
    const counts = { copied: 0, skipped: 0, failed: 0, abandoned: 0, pending: 0 };
    for (const c of this.chunkStates(m.id)) {
      if (c.state === 'verified') counts.copied++;
      else if (c.state === 'skipped' || c.state === 'failed' || c.state === 'abandoned') counts[c.state]++;
      else counts.pending++;
    }
    const abandoned = m.reason !== null;
    const failure = abandoned && m.reason !== END_TRANSFER ? m.reason : null;
    const mv = this.store.setPhase(m.id, 'done', { cleanupPending: pending, targetCleanupPending: targetPending });
    const durationS = Math.max(0, Math.round((this.d.clock.now() - (m.approvedAt ?? m.createdAt)) / 1000));
    this.audit(mv, 'move-done', failure ? 'failed' : 'ok', {
      phase: 'done', abandoned, ...this.cleanupDetail(src, pending), ...(targetPending ? { targetCleanup: 'pending' } : {}), ...(failure ? { failure } : {}), chunks: counts, bytesDone: mv.bytesDone, bytesTotal: mv.bytesTotal, durationS,
    });
    this.publish(m.id);
  }

  private cleanupDetail(src: CommandRow | null, pending: boolean): Record<string, unknown> {
    if (pending) return { cleanup: 'pending' };
    const deleted = src?.state === 'done' && src.result?.deleted && typeof src.result.deleted === 'object' ? src.result.deleted : undefined;
    const cleanupCode = !src ? 'not_queued' : src.state !== 'done' ? (src.outcomeCode ?? src.state) : null;
    return { cleanup: src?.state === 'done' ? 'done' : 'not-done', ...(cleanupCode ? { cleanupCode } : {}), ...(deleted ? { deleted } : {}) };
  }

  // A done move's pending source cleanup (ruling b): release, then finish;
  // when the finish is answered the marker goes and a follow-up move-done
  // records when (and what) the cleanup landed. Reads only until something is due.
  private cleanupStep(m0: Move): void {
    const m = this.store.get(m0.id);
    if (!m || !m.cleanupPending || !this.online(m.sourceProxyId)) return;
    const fin = this.sourceFinish(m);
    if (!fin || !FINAL_STATES.has(fin.state) || fin.state === 'expired' || fin.state === 'unknown') return;
    tx(this.d.db, () => {
      if (!this.store.get(m.id)?.cleanupPending) return;
      const mv = this.store.setPhase(m.id, 'done', { cleanupPending: false });
      this.audit(mv, 'move-done', 'ok', { phase: 'done', followUp: true, role: 'source', cleanupAt: this.d.clock.now(), ...this.cleanupDetail(fin, false) }, { actorType: 'proxy', actor: m.sourceProxyId });
    });
    this.publish(m.id);
  }

  // A done move's pending target finish: sent again while the target is online; once answered the marker goes and a
  // follow-up move-done records it. Reads only until something is due.
  private targetCleanupStep(m0: Move): void {
    const m = this.store.get(m0.id);
    if (!m || !m.targetCleanupPending || !this.online(m.targetProxyId)) return;
    const fin = this.ensure(m, m.targetProxyId, 'move.finish', { v: 1, moveId: m.id, role: 'target', abandoned: m.reason !== null }, (r) => r.state === 'expired' || r.state === 'unknown');
    if (!fin || !FINAL_STATES.has(fin.state) || fin.state === 'expired' || fin.state === 'unknown') return;
    tx(this.d.db, () => {
      if (!this.store.get(m.id)?.targetCleanupPending) return;
      const mv = this.store.setPhase(m.id, 'done', { targetCleanupPending: false });
      this.audit(mv, 'move-done', 'ok', {
        phase: 'done', followUp: true, role: 'target', cleanupAt: this.d.clock.now(), targetCleanup: fin.state === 'done' ? 'done' : 'not-done', ...(fin.state !== 'done' ? { targetCleanupCode: fin.outcomeCode ?? fin.state } : {}),
      }, { actorType: 'proxy', actor: m.targetProxyId });
    });
    this.publish(m.id);
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
  // Both roles get a cancel (A17): the source closes its journal, the target an offer it may hold (cam-proxy answers ok for an unknown move).
  private failIn(m: Move, code: string, answerReason: string | null): Move {
    this.pending.delete(m.id);
    if (answerReason) this.answer(m, { accept: false, reason: answerReason });
    const mv = this.store.setPhase(m.id, 'failed', { reason: code.slice(0, 64), copiedChoice: 'delete' });
    this.audit(mv, 'move-phase', 'failed', { phase: 'failed', reason: mv.reason, cancel: 'both', ...(answerReason ? { answered: answerReason } : {}) });
    this.ensureCancels(mv);
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
  private audit(m: Move, action: 'move-request' | 'move-offer' | 'move-phase' | 'move-approve' | 'move-budget-exceeded' | 'move-cancel' | 'move-end-transfer' | 'move-done' | 'move-check' | 'move-return' | 'move-give-up' | 'move-end-after-archive' | 'moves-pruned', outcome: 'ok' | 'refused' | 'failed', extra: Record<string, unknown>, who?: Who): void {
    const camsId = this.camsId(m);
    this.d.audit.write({
      actorType: who?.actorType ?? 'system', actor: who?.actor ?? 'system', action, accountId: m.accountId, targetType: 'camera', targetId: m.cameraId, targetLabel: camsId, outcome,
      detail: { moveId: m.id, requestId: m.requestId, camsId, source: m.sourceProxyId, target: m.targetProxyId, reason: m.reason, ...extra },
    });
  }
}
