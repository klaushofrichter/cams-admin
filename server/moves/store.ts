import type { SQLInputValue } from 'node:sqlite';
import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import { newId } from '../ids';
import { ApiError } from '../registry';
import type { MoveBounds, MoveCheck } from './types';
import type { SpaceCheck } from './space';

// The move job's rows (plan Task 2). Every write is one transaction. Never
// holds a token, password, sealed blob or private key: tokenHash is
// 'sha256:<hex>' only. cameras.move_id and moves.switched_at are set by Registry.moveCamera at the switch-over; move_id is never cleared.

export type MovePhase = 'requested' | 'offered' | 'awaiting-approval' | 'approved' | 'switching' | 'copying' | 'cleaning' | 'done' | 'rejected' | 'cancelling' | 'cancelled' | 'failed' | 'returning' | 'returned';
export type ChunkStateName = 'pending' | 'copied' | 'verified' | 'skipped' | 'failed' | 'abandoned';
export interface ChunkState { id: string; state: ChunkStateName }

const ENDED: MovePhase[] = ['done', 'rejected', 'cancelled', 'failed', 'returned'];

export interface Move {
  id: string; accountId: string; cameraId: string; sourceProxyId: string; targetProxyId: string; requestId: string; phase: MovePhase;
  reason: string | null;
  // A refusal's detail in words (the target's, or cams-admin's own); null when there is none.
  detail: string | null;
  plan: unknown; summary: unknown; settings: unknown; tokenHash: string | null;
  targetIp: string | null; targetPublicKey: string | null; leafFingerprint: string | null; copiedChoice: string | null;
  offeredAt: number | null; approvedAt: number | null; budgetExceededAt: number | null;
  bytesTotal: number | null; bytesDone: number | null; rateBps: number | null; etaS: number | null;
  createdAt: number; updatedAt: number; endedAt: number | null; actor: string | null; version: number;
  // Done, but the source's cleanup (release, finish) has not landed yet (Task 6 ruling b).
  cleanupPending: boolean;
  // Done, but the target's finish has not landed yet (a move ended early while the target was away).
  targetCleanupPending: boolean;
  // The pre-approval bounds the request carried; null when it carried none.
  bounds: MoveBounds | null;
  // A copy back: the cancelled move it returns the content of (its row is phase 'returning' -> 'returned').
  returnOf: string | null;
  // The receiving side's completeness check; null until it reported one.
  check: MoveCheck | null;
  // Days the ended move is kept (the proxy's longest content retention); null = the default.
  keepDays: number | null;
  // An End transfer waiting for Archive to land.
  endRequested: { at: number; actorType: string; actor: string } | null;
  // The space the move needs against the target's reported profile, at request time; null without a profile.
  space: SpaceCheck | null;
}
export interface NewMove {
  accountId: string; cameraId: string; sourceProxyId: string; targetProxyId: string; requestId: string;
  reason?: string | null; detail?: string | null; plan?: unknown; summary?: unknown; settings?: unknown; tokenHash?: string | null;
  targetIp?: string | null; actor?: string | null; bounds?: MoveBounds | null; space?: SpaceCheck | null;
  // A return starts at 'returning' and names the cancelled move.
  returnOf?: string; phase?: 'requested' | 'returning';
}

export class MoveBusy extends Error {
  constructor() {
    super('busy');
  }
}

type Row = Record<string, unknown>;
const JSON_COLS = new Set(['plan', 'summary', 'settings', 'bounds', 'check_result', 'end_requested', 'space']);
// Patchable Move fields -> columns (id, account, camera, proxies, request id and timestamps are not patchable).
const PATCH_COLS: Record<string, string> = {
  reason: 'reason', detail: 'detail', plan: 'plan', summary: 'summary', settings: 'settings', tokenHash: 'token_hash', targetIp: 'target_ip',
  targetPublicKey: 'target_public_key', leafFingerprint: 'leaf_fingerprint', copiedChoice: 'copied_choice', offeredAt: 'offered_at',
  approvedAt: 'approved_at', budgetExceededAt: 'budget_exceeded_at', bytesTotal: 'bytes_total', bytesDone: 'bytes_done', rateBps: 'rate_bps',
  etaS: 'eta_s', actor: 'actor', cleanupPending: 'cleanup_pending', targetCleanupPending: 'target_cleanup_pending',
  check: 'check_result', keepDays: 'keep_days', endRequested: 'end_requested',
};
const enc = (col: string, v: unknown): SQLInputValue => (col === 'detail' ? detailOf(v) : v === undefined || v === null ? null : JSON_COLS.has(col) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue));
const dec = (v: unknown) => (v === null ? null : JSON.parse(v as string));

const toMove = (r: Row): Move => ({
  id: r.id as string, accountId: r.account_id as string, cameraId: r.camera_id as string, sourceProxyId: r.source_proxy_id as string,
  targetProxyId: r.target_proxy_id as string, requestId: r.request_id as string, phase: r.phase as MovePhase, reason: r.reason as string | null, detail: (r.detail ?? null) as string | null,
  plan: dec(r.plan), summary: dec(r.summary), settings: dec(r.settings), tokenHash: r.token_hash as string | null,
  targetIp: r.target_ip as string | null, targetPublicKey: r.target_public_key as string | null, leafFingerprint: r.leaf_fingerprint as string | null,
  copiedChoice: r.copied_choice as string | null, offeredAt: r.offered_at as number | null, approvedAt: r.approved_at as number | null,
  budgetExceededAt: r.budget_exceeded_at as number | null, bytesTotal: r.bytes_total as number | null, bytesDone: r.bytes_done as number | null,
  rateBps: r.rate_bps as number | null, etaS: r.eta_s as number | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
  endedAt: r.ended_at as number | null, actor: r.actor as string | null, version: r.version as number, cleanupPending: r.cleanup_pending === 1,
  targetCleanupPending: r.target_cleanup_pending === 1, bounds: dec(r.bounds),
  returnOf: r.return_of as string | null, check: dec(r.check_result), keepDays: r.keep_days as number | null, endRequested: dec(r.end_requested),
  space: dec(r.space ?? null),
});

// How long a cancelled switched-over move without a return waits past its keep time.
export const RETURN_GRACE_MS = 86_400_000;

// Both sides of a given-up return (a `moves` row in the outer query) are closed: each answered its abandoned finish
// (done, failed or refused), or the new proxy (the return's source) refused its latest move.return.open as a proxy
// without the return does (an old release: not_allowed, invalid_args, unsupported_version; or unknown_move: no
// record to close). Such a side never gets the finish: nothing is left there to close.
export const GIVE_UP_CLOSED_OPEN_CODES = ['not_allowed', 'invalid_args', 'unsupported_version', 'unknown_move'];
const abandonedAnswered = (proxyCol: string) => `EXISTS (SELECT 1 FROM commands c WHERE c.proxy_id = ${proxyCol} AND c.command = 'move.finish'
    AND json_extract(c.args, '$.moveId') = moves.id AND json_extract(c.args, '$.abandoned') = 1 AND c.state IN ('done', 'failed', 'refused'))`;
const openClosed = `COALESCE((SELECT c.state IN ('refused', 'failed') AND c.outcome_code IN (${GIVE_UP_CLOSED_OPEN_CODES.map((x) => `'${x}'`).join(', ')})
    FROM commands c WHERE c.proxy_id = moves.source_proxy_id AND c.command = 'move.return.open' AND json_extract(c.args, '$.moveId') = moves.id
    ORDER BY c.rowid DESC LIMIT 1), 0) = 1`;
export const GIVE_UP_CLOSED = `(${abandonedAnswered('moves.source_proxy_id')} OR ${openClosed}) AND ${abandonedAnswered('moves.target_proxy_id')}`;

// A refusal's detail as the column takes it: 1–300 characters, or null.
// Cut by code points (as JSON Schema maxLength and SQLite length() count), never inside a surrogate pair.
export const detailOf = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? Array.from(x.trim()).slice(0, 300).join('') : null);

export class MoveStore {
  // onChange: every write that creates, changes or deletes a move row names it (the live 'move' event); one place, so no transition is missed.
  constructor(private db: Db, private clock: Clock, private onChange: (moveId: string) => void = () => undefined) {}

  create(m: NewMove): Move {
    return this.insert(m, m.phase ?? 'requested', null);
  }

  // A request refused before it became a move (cams-admin's own checks): written ended, so it never holds a proxy
  // or the camera (the busy trigger and the unique indexes skip ended rows) and shows in the list with its reason.
  createRejected(m: Omit<NewMove, 'phase' | 'returnOf'> & { reason: string; detail: string | null }): Move {
    return this.insert(m, 'rejected', this.clock.now());
  }

  private insert(m: NewMove, phase: MovePhase, endedAt: number | null): Move {
    const mv = tx(this.db, () => {
      const id = newId('mv');
      const now = this.clock.now();
      try {
        this.db.prepare(
          `INSERT INTO moves (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, reason, detail, plan, summary, settings, token_hash, target_ip, created_at, updated_at, ended_at, actor, bounds, return_of, space, version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        ).run(id, m.accountId, m.cameraId, m.sourceProxyId, m.targetProxyId, m.requestId, phase, m.reason ?? null, detailOf(m.detail), enc('plan', m.plan), enc('summary', m.summary),
          enc('settings', m.settings), m.tokenHash ?? null, m.targetIp ?? null, now, now, endedAt, m.actor ?? null, enc('bounds', m.bounds), m.returnOf ?? null, enc('space', m.space));
      } catch (e) {
        if (/UNIQUE constraint failed: moves\.|moves: proxy busy/.test(String((e as Error).message))) throw new MoveBusy();
        throw e;
      }
      return this.get(id)!;
    });
    this.onChange(mv.id);
    return mv;
  }

  // Deletes a rejected move (a refusal is final; its row holds no content) with its chunk rows (ON DELETE CASCADE).
  // False when there is no such move or it is not rejected.
  deleteRejected(id: string): boolean {
    const n = tx(this.db, () => Number(this.db.prepare(`DELETE FROM moves WHERE id = ? AND phase = 'rejected'`).run(id).changes));
    if (n) this.onChange(id);
    return n > 0;
  }

  // Names the move on the camera (cameras.move_id; never cleared, the next move
  // overwrites it). Production does this in Registry.moveCamera, which also sets
  // switched_at; this one is used by tests only and does not stamp switched_at.
  markCamera(moveId: string): void {
    tx(this.db, () => {
      const m = this.get(moveId);
      if (!m) throw new ApiError(404, 'not_found');
      this.db.prepare('UPDATE cameras SET move_id = ? WHERE id = ?').run(moveId, m.cameraId);
    });
  }

  get(id: string): Move | null {
    const r = this.db.prepare('SELECT * FROM moves WHERE id = ?').get(id) as Row | undefined;
    return r ? toMove(r) : null;
  }

  active(): Move[] {
    return (this.db.prepare('SELECT * FROM moves WHERE ended_at IS NULL ORDER BY created_at, id').all() as Row[]).map(toMove);
  }

  // The non-ended move this proxy takes part in, as source or target.
  byProxy(proxyId: string): Move | null {
    const r = this.db.prepare('SELECT * FROM moves WHERE ended_at IS NULL AND (source_proxy_id = ? OR target_proxy_id = ?)').get(proxyId, proxyId) as Row | undefined;
    return r ? toMove(r) : null;
  }

  // The move made for a source's request, ended or not (repeated request events).
  byRequest(sourceProxyId: string, requestId: string): Move | null {
    const r = this.db.prepare('SELECT * FROM moves WHERE source_proxy_id = ? AND request_id = ? ORDER BY created_at LIMIT 1').get(sourceProxyId, requestId) as Row | undefined;
    return r ? toMove(r) : null;
  }

  // The return (copy back) of a cancelled move, ended or not; the latest if there were several.
  returnFor(moveId: string): Move | null {
    const r = this.db.prepare('SELECT * FROM moves WHERE return_of = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(moveId) as Row | undefined;
    return r ? toMove(r) : null;
  }

  // Ended moves past their keepDays (defaultDays when the proxy reported none);
  // never one whose source or target cleanup is pending or that a return names, nor a given-up return
  // whose abandoned finishes are not yet answered on both sides (Give up, however long a proxy was away).
  // A cancelled move that was switched over and has no return is kept for a day
  // more: Task 15 creates the return in the cancel's own transaction, so that
  // state means the return was pruned first (it goes on the next run) or is
  // missing; the grace keeps a not-yet-created return from losing its original.
  // Nor a failed or cancelled move whose target has not taken its cancel on (onLive asks it again on its return: the
  // target must let go of the camera, and it needs the row for that).
  private static readonly PRUNABLE = `FROM moves WHERE ended_at IS NOT NULL AND cleanup_pending = 0 AND target_cleanup_pending = 0
         AND ended_at + COALESCE(keep_days, ?) * 86400000 + (CASE WHEN phase = 'cancelled' AND switched_at IS NOT NULL AND return_of IS NULL THEN ${RETURN_GRACE_MS} ELSE 0 END) < ?
         AND NOT EXISTS (SELECT 1 FROM moves r WHERE r.return_of = moves.id)
         AND NOT (COALESCE(reason, '') = 'given_up' AND NOT (${GIVE_UP_CLOSED}))
         AND NOT (phase IN ('failed', 'cancelled') AND (copied_choice IS NOT NULL OR switched_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.proxy_id = moves.target_proxy_id AND c.command = 'move.cancel' AND c.state = 'done' AND json_extract(c.args, '$.moveId') = moves.id))`;

  // A read: the ids prune(now, defaultDays) would delete.
  prunable(now: number, defaultDays: number): string[] {
    return (this.db.prepare(`SELECT id ${MoveStore.PRUNABLE}`).all(defaultDays, now) as Row[]).map((r) => r.id as string);
  }

  // Deletes the prunable ended moves. Chunk states go with the row (ON DELETE
  // CASCADE). Returns the deleted ids; writes nothing (no epoch bump) when
  // there are none. cameras.move_id may keep naming a pruned move (it has no FK).
  prune(now: number, defaultDays: number): string[] {
    if (!this.prunable(now, defaultDays).length) return [];
    const ids = tx(this.db, () => (this.db.prepare(`DELETE ${MoveStore.PRUNABLE} RETURNING id`).all(defaultDays, now) as Row[]).map((r) => r.id as string));
    for (const id of ids) this.onChange(id);
    return ids;
  }

  setPhase(id: string, phase: MovePhase, patch: Partial<Move> = {}): Move {
    const mv = tx(this.db, () => {
      const cur = this.get(id);
      if (!cur) throw new ApiError(404, 'not_found');
      const now = this.clock.now();
      const sets = ['phase = ?', 'updated_at = ?', 'version = version + 1'];
      const args: SQLInputValue[] = [phase, now];
      for (const [k, col] of Object.entries(PATCH_COLS)) {
        if (!(k in patch)) continue;
        sets.push(`${col} = ?`);
        args.push(enc(col, (patch as Record<string, unknown>)[k]));
      }
      if (ENDED.includes(phase) && cur.endedAt === null) {
        sets.push('ended_at = ?');
        args.push(now);
      }
      this.db.prepare(`UPDATE moves SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      return this.get(id)!;
    });
    this.onChange(id);
    return mv;
  }

  // Upsert; chunks not named stay. One transaction.
  saveChunks(id: string, chunks: ChunkState[]): void {
    if (!chunks.length) return;
    tx(this.db, () => {
      const st = this.db.prepare(
        `INSERT INTO move_chunks (move_id, chunk_id, state) VALUES (?,?,?) ON CONFLICT (move_id, chunk_id) DO UPDATE SET state = excluded.state`,
      );
      for (const c of chunks) st.run(id, c.id, c.state);
    });
  }

  chunks(id: string): ChunkState[] {
    return (this.db.prepare('SELECT chunk_id, state FROM move_chunks WHERE move_id = ? ORDER BY chunk_id').all(id) as Row[]).map((r) => ({ id: r.chunk_id as string, state: r.state as ChunkStateName }));
  }

  list(accountId?: string, limit = 100): Move[] {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM moves WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(accountId, limit)
      : this.db.prepare('SELECT * FROM moves ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toMove);
  }
}
