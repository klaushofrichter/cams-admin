import type { Db } from '../db/open';
import type { Move, ChunkState, ChunkStateName } from './store';

// What the API shows of a move. Never the token, its hash, the target's
// public key, the leaf fingerprint or the target's address: fields are named
// one by one, nothing is spread from the row.
export interface MoveView {
  id: string; accountId: string; camsId: string; cameraName: string; source: { id: string; name: string }; target: { id: string; name: string };
  phase: string; reason: string | null; plan: unknown; bytesTotal: number | null; bytesDone: number | null; rateBps: number | null; etaS: number | null;
  budgetExceeded: boolean; cleanupPending: boolean; createdAt: number; updatedAt: number; endedAt: number | null;
}
export type ChunkCounts = Record<ChunkStateName, number>;

export function moveView(db: Db, m: Move): MoveView {
  const cam = db.prepare('SELECT cams_id, name FROM cameras WHERE id = ?').get(m.cameraId) as { cams_id: string; name: string } | undefined;
  const px = db.prepare('SELECT name FROM proxies WHERE id = ?');
  const name = (id: string) => (px.get(id) as { name: string } | undefined)?.name ?? id;
  return {
    id: m.id, accountId: m.accountId, camsId: cam?.cams_id ?? '', cameraName: cam?.name ?? '', source: { id: m.sourceProxyId, name: name(m.sourceProxyId) },
    target: { id: m.targetProxyId, name: name(m.targetProxyId) }, phase: m.phase, reason: m.reason, plan: m.plan, bytesTotal: m.bytesTotal, bytesDone: m.bytesDone,
    rateBps: m.rateBps, etaS: m.etaS, budgetExceeded: m.budgetExceededAt !== null, cleanupPending: m.cleanupPending, createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
  };
}

export function chunkCounts(chunks: ChunkState[]): ChunkCounts {
  const out: ChunkCounts = { pending: 0, copied: 0, verified: 0, skipped: 0, failed: 0, abandoned: 0 };
  for (const c of chunks) out[c.state]++;
  return out;
}
