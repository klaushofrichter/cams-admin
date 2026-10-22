import type { SQLInputValue } from 'node:sqlite';
import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import { newId } from '../ids';
import { ApiError } from '../registry';

// The move job's rows (plan Task 2). Every write is one transaction. Never
// holds a token, password, sealed blob or private key: tokenHash is
// 'sha256:<hex>' only. cameras.move_id is set by markCamera at the switch-over and never cleared.

export type MovePhase = 'requested' | 'offered' | 'awaiting-approval' | 'approved' | 'switching' | 'copying' | 'cleaning' | 'done' | 'rejected' | 'cancelling' | 'cancelled' | 'failed';
export type ChunkStateName = 'pending' | 'copied' | 'verified' | 'skipped' | 'failed' | 'abandoned';
export interface ChunkState { id: string; state: ChunkStateName }

const ENDED: MovePhase[] = ['done', 'rejected', 'cancelled', 'failed'];

export interface Move {
  id: string; accountId: string; cameraId: string; sourceProxyId: string; targetProxyId: string; requestId: string; phase: MovePhase;
  reason: string | null; plan: unknown; summary: unknown; settings: unknown; tokenHash: string | null;
  targetIp: string | null; targetPublicKey: string | null; leafFingerprint: string | null; copiedChoice: string | null;
  offeredAt: number | null; approvedAt: number | null; budgetExceededAt: number | null;
  bytesTotal: number | null; bytesDone: number | null; rateBps: number | null; etaS: number | null;
  createdAt: number; updatedAt: number; endedAt: number | null; actor: string | null; version: number;
}
export interface NewMove {
  accountId: string; cameraId: string; sourceProxyId: string; targetProxyId: string; requestId: string;
  reason?: string | null; plan?: unknown; summary?: unknown; settings?: unknown; tokenHash?: string | null;
  targetIp?: string | null; actor?: string | null;
}

export class MoveBusy extends Error {
  constructor() {
    super('busy');
  }
}

type Row = Record<string, unknown>;
const JSON_COLS = new Set(['plan', 'summary', 'settings']);
// Patchable Move fields -> columns (id, account, camera, proxies, request id and timestamps are not patchable).
const PATCH_COLS: Record<string, string> = {
  reason: 'reason', plan: 'plan', summary: 'summary', settings: 'settings', tokenHash: 'token_hash', targetIp: 'target_ip',
  targetPublicKey: 'target_public_key', leafFingerprint: 'leaf_fingerprint', copiedChoice: 'copied_choice', offeredAt: 'offered_at',
  approvedAt: 'approved_at', budgetExceededAt: 'budget_exceeded_at', bytesTotal: 'bytes_total', bytesDone: 'bytes_done', rateBps: 'rate_bps',
  etaS: 'eta_s', actor: 'actor',
};
const enc = (col: string, v: unknown): SQLInputValue => (v === undefined || v === null ? null : JSON_COLS.has(col) ? JSON.stringify(v) : (v as SQLInputValue));
const dec = (v: unknown) => (v === null ? null : JSON.parse(v as string));

const toMove = (r: Row): Move => ({
  id: r.id as string, accountId: r.account_id as string, cameraId: r.camera_id as string, sourceProxyId: r.source_proxy_id as string,
  targetProxyId: r.target_proxy_id as string, requestId: r.request_id as string, phase: r.phase as MovePhase, reason: r.reason as string | null,
  plan: dec(r.plan), summary: dec(r.summary), settings: dec(r.settings), tokenHash: r.token_hash as string | null,
  targetIp: r.target_ip as string | null, targetPublicKey: r.target_public_key as string | null, leafFingerprint: r.leaf_fingerprint as string | null,
  copiedChoice: r.copied_choice as string | null, offeredAt: r.offered_at as number | null, approvedAt: r.approved_at as number | null,
  budgetExceededAt: r.budget_exceeded_at as number | null, bytesTotal: r.bytes_total as number | null, bytesDone: r.bytes_done as number | null,
  rateBps: r.rate_bps as number | null, etaS: r.eta_s as number | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
  endedAt: r.ended_at as number | null, actor: r.actor as string | null, version: r.version as number,
});

export class MoveStore {
  constructor(private db: Db, private clock: Clock) {}

  create(m: NewMove): Move {
    return tx(this.db, () => {
      const id = newId('mv');
      const now = this.clock.now();
      try {
        this.db.prepare(
          `INSERT INTO moves (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, reason, plan, summary, settings, token_hash, target_ip, created_at, updated_at, actor, version)
           VALUES (?,?,?,?,?,?,'requested',?,?,?,?,?,?,?,?,?,1)`,
        ).run(id, m.accountId, m.cameraId, m.sourceProxyId, m.targetProxyId, m.requestId, m.reason ?? null, enc('plan', m.plan), enc('summary', m.summary),
          enc('settings', m.settings), m.tokenHash ?? null, m.targetIp ?? null, now, now, m.actor ?? null);
      } catch (e) {
        if (/UNIQUE constraint failed: moves\.|moves: proxy busy/.test(String((e as Error).message))) throw new MoveBusy();
        throw e;
      }
      return this.get(id)!;
    });
  }

  // Called at the switch-over (with the registry change): the camera now
  // names this move. Never cleared; the next move overwrites it.
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

  setPhase(id: string, phase: MovePhase, patch: Partial<Move> = {}): Move {
    return tx(this.db, () => {
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
