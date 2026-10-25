import { isIP } from 'net';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Logger } from '../log';
import type { Registry } from '../registry';
import type { CommandRow, Commands, WireCommand } from '../commands/service';
import { MOVE_KINDS } from '../../contract/build';
import type { ChunkState, Move, MoveStore } from './store';
import { moveToken, targetAddress, type Resolve } from './token';
import type { MoveCheck, MovePhaseEvent } from './types';

// The return move (step 4, spec §1; plan Task 15): the copy back after a cancel
// after the switch-over. Its own move row (return_of = the cancelled move,
// request_id = the cancelled move's id, ruling 14), roles swapped: the new
// proxy (the cancelled move's target) is the return's source, the original
// proxy its target. Created in the transaction that ends the cancel (the
// source has the camera back), so a cancelled switched-over move is never
// without its return (MoveStore.prune keeps a move a return names). Steps,
// each derived again from the commands (tick, a reconnect, a restart):
// move.return.open to the new proxy (retried while it answers wrong_phase, its
// cancel not landed yet) → move.return.start with the token to the original →
// the original's `copied` (with the check) → move.finish {return: true} to the
// original, then (once that one is final, the Task 16 order) to the new proxy →
// `returned`. Not cancellable, no End transfer, no budget (ruling 8): it
// retries until done (Give up is the exit). The token's plaintext is in
// memory only: after a restart the return is re-keyed (a new token, a new
// move.return.open, then a new move.return.start; ruling 20).

// Ruling 8: everything, all space; the budget only paces the copier (no move-budget-exceeded for a return).
export const RETURN_PLAN = { transfer: true, kinds: [...MOVE_KINDS], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 };
// Ruling 9: the original reports `copying` with code no_space while the next chunk doesn't fit.
export const NO_SPACE_REASON = 'paused:no_space';
// A step whose command could not be queued (the proxy paused, the entry off) is tried again this often.
export const RETURN_QUEUE_RETRY_MS = 60_000;

// A proxy on a cam-proxy release before the return refuses its commands (an unknown command: not_allowed; an unknown
// field: invalid_args; or unsupported_version): permanent for that command until the proxy reconnects (an update).
export const OLD_PROXY_CODES = ['not_allowed', 'invalid_args', 'unsupported_version'];
// The reason the return shows while one side needs the update (the return's role: source = new proxy, target = original).
export const updateReason = (role: 'source' | 'target') => `paused:proxy_update:${role}`;
export const isOldProxyRefusal = (r: CommandRow) => (r.state === 'refused' || r.state === 'failed') && OLD_PROXY_CODES.includes(r.outcomeCode ?? '');
const RETRY_CAP_MS = 3600_000;
const FINAL_STATES = new Set(['done', 'refused', 'failed', 'expired', 'unknown']);
const DONE_MAX = 512;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const unanswered = (r: CommandRow) => r.state === 'expired' || r.state === 'unknown';

// The host of a url when it is an address already (no lookup: usable inside a transaction); null otherwise.
export function literalAddress(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return isIP(host) ? host : null;
  } catch {
    return null;
  }
}

type Who = { actorType: 'proxy' | 'system' | 'sysadmin'; actor: string };
// What the return needs of Moves (its command, audit and progress helpers).
export interface ReturnHost {
  db: Db; clock: Clock; log: Logger; registry: Registry; commands: Commands; store: MoveStore; resolve?: Resolve;
  send(m: Move, proxyId: string, command: WireCommand, args: Record<string, unknown>): { ok: true; id: string } | { ok: false; code: string };
  audit(m: Move, action: 'move-return' | 'move-check', outcome: 'ok' | 'refused' | 'failed', extra: Record<string, unknown>, who?: Who): void;
  online(proxyId: string): boolean;
  retryDue(m: Move, proxyId: string, command: WireCommand, base: number, last: CommandRow): boolean;
  chunkStates(moveId: string): ChunkState[];
  flushIn(moveId: string): Partial<Move>;
}

// The plaintext token of a return and the commands sent with it (memory only).
// bytesFor: the open whose `bytes` went into bytesTotal (taken once per open; the copier's progress total wins after that).
export interface ReturnKey { token: string; openId: string | null; startId: string | null; bytesFor?: string }

export class Returns {
  // Commands that could not be queued, by moveId:command: when they were last tried.
  private blocked = new Map<string, number>();
  private resolving = new Set<string>();
  // A side's reported failure (memory: a restart re-keys, which sends open and start again anyway), by return id.
  private failures = new Map<string, { source?: number; target?: number }>();
  // moveId:proxyId of a proxy that reconnected while its return command was refused as by an old release: one more try.
  private liveRetry = new Set<string>();

  constructor(private h: ReturnHost, private keys: Map<string, ReturnKey>, private retryMs: number) {}

  // Inside the caller's transaction (the cancel's end): the return of a cancelled
  // switched-over move. null for a return (a return has no return). MoveBusy
  // (store.create) propagates: the caller's transaction rolls back (the move stays cancelling).
  createReturn(m: Move): Move | null {
    if (m.returnOf !== null) return null;
    const original = this.h.registry.proxyById(m.sourceProxyId);
    const { token, tokenHash } = moveToken();
    const r = this.h.store.create({
      accountId: m.accountId, cameraId: m.cameraId, sourceProxyId: m.targetProxyId, targetProxyId: m.sourceProxyId, requestId: m.id, returnOf: m.id, phase: 'returning',
      plan: RETURN_PLAN, tokenHash, targetIp: literalAddress(original?.url ?? null), actor: 'system',
    });
    this.keys.set(r.id, { token, openId: null, startId: null });
    this.h.audit(r, 'move-return', 'ok', { step: 'created', phase: 'returning', returnOf: m.id });
    return r;
  }

  // The next step of a returning move (resume: tick, a reconnect, a command's
  // result). Reads only unless something is due (tick calls it every RESUME_GAP_MS).
  step(m0: Move): void {
    const m = this.h.store.get(m0.id);
    if (!m || m.phase !== 'returning') return;
    if (!m.targetIp) return this.resolveAddress(m);
    if (this.finishing(m)) return this.finishStep(m);
    const key = this.keys.get(m.id) ?? this.rekey(m);
    if (!key) return;
    const sendOpen = () => this.queue(m, m.sourceProxyId, 'move.return.open', { v: 1, moveId: m.id, returnOf: m.returnOf, tokenHash: m.tokenHash, targetIp: m.targetIp }, (id) => {
      key.openId = id;
      key.startId = null;
    });
    const open = key.openId ? this.cmd(m, m.sourceProxyId, key.openId) : null;
    if (!open) return sendOpen();
    if (!FINAL_STATES.has(open.state)) return;
    if (open.state !== 'done') {
      if (isOldProxyRefusal(open)) return this.liveRetry.delete(`${m.id}:${m.sourceProxyId}`) ? sendOpen() : this.setReason(m, updateReason('source'));
      return void (this.again(m, m.sourceProxyId, 'move.return.open', open) && sendOpen());
    }
    if (m.reason === updateReason('source')) this.setReason(m, null);
    const failed = this.failures.get(m.id);
    // The new proxy failed after this open: open again (same key) after the backoff; the start follows that open.
    if (failed?.source !== undefined) {
      if (this.failureDue(m, m.sourceProxyId, 'move.return.open', failed.source)) {
        delete failed.source;
        sendOpen();
      }
      return;
    }
    const bytes = open.result?.bytes;
    if (key.bytesFor !== open.id) {
      key.bytesFor = open.id;
      if (isCount(bytes) && m.bytesTotal !== bytes) tx(this.h.db, () => this.h.store.setPhase(m.id, 'returning', { bytesTotal: bytes }));
    }
    const start = key.startId ? this.cmd(m, m.targetProxyId, key.startId) : null;
    if (start?.state === 'done' && m.reason === updateReason('target')) this.setReason(m, null);
    const startRetry = start !== null && isOldProxyRefusal(start) && this.liveRetry.delete(`${m.id}:${m.targetProxyId}`);
    if (start && isOldProxyRefusal(start) && !startRetry) return this.setReason(m, updateReason('target'));
    if (startRetry) {
      // The original reconnected (perhaps updated): one more start.
    } else if (start && start.state === 'done' && failed?.target !== undefined) {
      // The original failed after this start: start again (same token, `done` from the chunk states) after the backoff.
      if (!this.failureDue(m, m.targetProxyId, 'move.return.start', failed.target)) return;
      delete failed.target;
    } else if (start && (!FINAL_STATES.has(start.state) || start.state === 'done' || !this.again(m, m.targetProxyId, 'move.return.start', start))) return;
    const src = this.h.registry.proxyById(m.sourceProxyId);
    if (!src?.url || !src.tlsServername) {
      if (this.due(`${m.id}:registry`)) this.h.log.warn({ moveId: m.id }, 'move_return_source_registry_incomplete');
      return;
    }
    const done = this.h.chunkStates(m.id).filter((c) => c.state === 'verified').map((c) => c.id).slice(-DONE_MAX);
    this.queue(m, m.targetProxyId, 'move.return.start', {
      v: 1, moveId: m.id, returnOf: m.returnOf, token: key.token,
      source: { proxyId: src.id, name: src.name, url: src.url, caFingerprints: src.caFingerprints.slice(0, 2), tlsServername: src.tlsServername }, done,
    }, (id) => { key.startId = id; });
  }

  // A proxy (re)connected: a return command it refused as an old release would is tried once more.
  reconnected(m: Move, proxyId: string): void {
    if (m.phase === 'returning') this.liveRetry.add(`${m.id}:${proxyId}`);
  }

  // The reason shown on the return, written only when it changes.
  private setReason(m: Move, reason: string | null): void {
    if (m.reason === reason) return;
    tx(this.h.db, () => {
      const mv = this.h.store.setPhase(m.id, 'returning', { reason });
      if (reason?.startsWith('paused:proxy_update')) this.h.audit(mv, 'move-return', 'refused', { step: 'needs-update', phase: 'returning', role: reason.slice(reason.lastIndexOf(':') + 1) });
    });
    m.reason = reason;
  }

  // A return command's result: the start's acceptance is audited, then the next step.
  onFinal(m: Move, r: CommandRow): void {
    if (r.command === 'move.return.start' && r.state === 'done' && r.proxyId === m.targetProxyId && this.keys.get(m.id)?.startId === r.id) {
      tx(this.h.db, () => this.h.audit(m, 'move-return', 'ok', { step: 'started', phase: 'returning', rekeyed: this.count(m, m.targetProxyId, 'move.return.start') > 1 }, { actorType: 'proxy', actor: m.targetProxyId }));
    }
    this.step(m);
  }

  // A phase event for a returning move (each side for its own role; the caller checked).
  onPhase(m: Move, ev: MovePhaseEvent): void {
    if (!ev.ok || ev.phase === 'failed') {
      // The return retries until done: the failed side's step is sent again after a backoff (step), audited per failure.
      if (this.finishing(m)) return;
      const f = this.failures.get(m.id) ?? {};
      if (f[ev.role] !== undefined) return;
      f[ev.role] = this.h.clock.now();
      this.failures.set(m.id, f);
      this.h.log.warn({ moveId: m.id, role: ev.role, phase: ev.phase, code: ev.code }, 'move_return_side_failed');
      tx(this.h.db, () => this.h.audit(m, 'move-return', 'failed', { step: 'failed', phase: 'returning', role: ev.role, code: ev.code ?? null },
        { actorType: 'proxy', actor: ev.role === 'source' ? m.sourceProxyId : m.targetProxyId }));
      return;
    }
    if (ev.role === 'target' && ev.phase === 'copying') {
      const want = ev.code === 'no_space' ? NO_SPACE_REASON : null;
      if (m.reason === want) return;
      tx(this.h.db, () => {
        const mv = this.h.store.setPhase(m.id, 'returning', { ...this.h.flushIn(m.id), reason: want });
        this.h.audit(mv, 'move-return', 'ok', { step: want ? 'paused' : 'resumed', phase: 'returning' }, { actorType: 'proxy', actor: m.targetProxyId });
      });
      return;
    }
    if (ev.role === 'target' && ev.phase === 'copied') return this.copied(m, ev.check ?? null);
    if (ev.phase === 'finished') return this.step(m);
  }

  // The original copied everything back: the check stored, move.finish {return} to the original.
  private copied(m: Move, check: MoveCheck | null): void {
    if (this.finishing(m)) return this.step(m);
    tx(this.h.db, () => {
      const mv = this.h.store.setPhase(m.id, 'returning', { ...this.h.flushIn(m.id), check, reason: null });
      if (check) this.h.audit(mv, 'move-check', check.complete ? 'ok' : 'failed', { check }, { actorType: 'proxy', actor: m.targetProxyId });
      this.finishCommand(mv, 'target');
    });
    this.step(m);
  }

  // From the original's `copied` on: its finish exists (or the check was stored and the finish could not be queued yet).
  private finishing(m: Move): boolean {
    return m.check !== null || this.last(m, m.targetProxyId, 'move.finish') !== null;
  }

  // move.finish {return} to the original, then, once that one is answered, to the new proxy; both answered → returned.
  private finishStep(m: Move): void {
    const target = this.finishCommand(m, 'target');
    if (!target || !FINAL_STATES.has(target.state) || unanswered(target)) return;
    const source = this.finishCommand(m, 'source');
    if (!source || !FINAL_STATES.has(source.state) || unanswered(source)) return;
    tx(this.h.db, () => {
      const cur = this.h.store.get(m.id);
      if (cur?.phase !== 'returning') return;
      const mv = this.h.store.setPhase(m.id, 'returned', { ...this.h.flushIn(m.id) });
      this.h.audit(mv, 'move-return', 'ok', {
        step: 'returned', phase: 'returned', returnOf: m.returnOf, check: cur.check, targetFinish: target.state, sourceFinish: source.state,
        bytesDone: mv.bytesDone, bytesTotal: mv.bytesTotal,
      });
    });
    this.keys.delete(m.id);
    this.failures.delete(m.id);
  }

  // The newest finish for this role, created when there is none and again when it went unanswered while its proxy is online.
  private finishCommand(m: Move, role: 'source' | 'target'): CommandRow | null {
    const proxyId = role === 'target' ? m.targetProxyId : m.sourceProxyId;
    const last = this.last(m, proxyId, 'move.finish');
    if (last && !(unanswered(last) && this.h.online(proxyId))) return last;
    this.queue(m, proxyId, 'move.finish', { v: 1, moveId: m.id, role, abandoned: false, return: true });
    return this.last(m, proxyId, 'move.finish');
  }

  // A new token after a restart (the plaintext is gone): its hash on the row; move.return.open goes out again with it.
  private rekey(m: Move): ReturnKey {
    const { token, tokenHash } = moveToken();
    tx(this.h.db, () => this.h.store.setPhase(m.id, 'returning', { tokenHash }));
    m.tokenHash = tokenHash;
    const key = { token, openId: null, startId: null };
    this.keys.set(m.id, key);
    return key;
  }

  // A failed command is due again: unanswered while its proxy is online; answered failed or refused (wrong_phase: the
  // new proxy's cancel not landed yet) with the doubling backoff, capped at an hour.
  private again(m: Move, proxyId: string, command: WireCommand, last: CommandRow): boolean {
    if (unanswered(last)) return this.h.online(proxyId);
    return this.h.retryDue(m, proxyId, command, this.retryMs, last);
  }

  // A side's reported failure is due for another try: retryMs doubling with the tries of that command so far, capped.
  private failureDue(m: Move, proxyId: string, command: WireCommand, at: number): boolean {
    const n = this.count(m, proxyId, command);
    return this.h.clock.now() - at >= Math.min(this.retryMs * 2 ** Math.max(0, n - 1), RETRY_CAP_MS);
  }

  private queue(m: Move, proxyId: string, command: WireCommand, args: Record<string, unknown>, sent?: (id: string) => void): void {
    const k = `${m.id}:${proxyId}:${command}`;
    const at = this.blocked.get(k);
    if (at !== undefined && this.h.clock.now() - at < RETURN_QUEUE_RETRY_MS) return;
    const r = this.h.send(m, proxyId, command, args);
    if (!r.ok) {
      this.blocked.set(k, this.h.clock.now());
      return;
    }
    this.blocked.delete(k);
    sent?.(r.id);
  }

  // The original's address when its url names a host (looked up once, outside a transaction).
  // Also for a given-up return (Give up opens on the new proxy, which needs the address too): `then` follows the write.
  resolveAddress(m: Move, then: () => void = () => this.step(m)): void {
    if (this.resolving.has(m.id) || !this.due(`${m.id}:resolve`)) return;
    this.resolving.add(m.id);
    const original = this.h.registry.proxyById(m.targetProxyId);
    targetAddress(original?.url ?? null, this.h.resolve).then((ip) => {
      this.resolving.delete(m.id);
      if (!ip) return void this.h.log.warn({ moveId: m.id }, 'move_return_target_address');
      tx(this.h.db, () => {
        const cur = this.h.store.get(m.id);
        if (cur) this.h.store.setPhase(m.id, cur.phase, { targetIp: ip });
      });
      then();
    }).catch((e) => {
      this.resolving.delete(m.id);
      this.h.log.error({ err: e, moveId: m.id }, 'move_return_resolve_failed');
    });
  }

  // At most once per RETURN_QUEUE_RETRY_MS per key.
  private due(k: string): boolean {
    const at = this.blocked.get(k);
    if (at !== undefined && this.h.clock.now() - at < RETURN_QUEUE_RETRY_MS) return false;
    this.blocked.set(k, this.h.clock.now());
    return true;
  }

  private cmd(m: Move, proxyId: string, id: string): CommandRow | null {
    try {
      return this.h.commands.get(m.accountId, proxyId, id);
    } catch {
      return null;
    }
  }

  private last(m: Move, proxyId: string, command: WireCommand): CommandRow | null {
    const r = this.h.db.prepare(`SELECT id FROM commands WHERE proxy_id = ? AND command = ? AND json_extract(args, '$.moveId') = ? ORDER BY rowid DESC LIMIT 1`)
      .get(proxyId, command, m.id) as { id: string } | undefined;
    return r ? this.cmd(m, proxyId, r.id) : null;
  }

  private count(m: Move, proxyId: string, command: WireCommand): number {
    return (this.h.db.prepare(`SELECT COUNT(*) AS n FROM commands WHERE proxy_id = ? AND command = ? AND json_extract(args, '$.moveId') = ?`).get(proxyId, command, m.id) as { n: number }).n;
  }
}
