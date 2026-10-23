import type { Db } from '../db/open';
import type { MoveBounds, MoveCheck } from './types';
import type { Move, ChunkState, ChunkStateName } from './store';

// What the API shows of a move. Never the token, its hash, the target's
// public key, the leaf fingerprint or the target's address: fields are named
// one by one, nothing is spread from the row.
export interface MoveView {
  id: string; requestId: string; accountId: string; camsId: string; cameraName: string; source: { id: string; name: string }; target: { id: string; name: string };
  phase: string; reason: string | null; plan: unknown; bytesTotal: number | null; bytesDone: number | null; rateBps: number | null; etaS: number | null;
  budgetExceeded: boolean; cleanupPending: boolean; targetCleanupPending: boolean; autoApprove: boolean; bounds: MoveBounds | null; createdAt: number; updatedAt: number; endedAt: number | null;
  // A cancelled move's copy back (returnId) and a copy back's cancelled move (returnOf); the receiving side's check; Archive still to copy; End waiting for it.
  returnOf: string | null; returnId: string | null; check: MoveCheck | null; archivePending: boolean; endRequested: boolean; keepDays: number | null;
}
export type ChunkCounts = Record<ChunkStateName, number>;

// archivePending comes from the move service (it knows the chunks); a caller without it shows false.
export function moveView(db: Db, m: Move, archivePending = false): MoveView {
  const ret = db.prepare('SELECT id FROM moves WHERE return_of = ? ORDER BY created_at DESC LIMIT 1').get(m.id) as { id: string } | undefined;
  const cam = db.prepare('SELECT cams_id, name FROM cameras WHERE id = ?').get(m.cameraId) as { cams_id: string; name: string } | undefined;
  const px = db.prepare('SELECT name, display_name FROM proxies WHERE id = ?');
  const name = (id: string) => {
    const r = px.get(id) as { name: string; display_name: string } | undefined;
    return r?.display_name || r?.name || id;
  };
  return {
    id: m.id, requestId: m.requestId, accountId: m.accountId, camsId: cam?.cams_id ?? '', cameraName: cam?.name ?? '', source: { id: m.sourceProxyId, name: name(m.sourceProxyId) },
    target: { id: m.targetProxyId, name: name(m.targetProxyId) }, phase: m.phase, reason: m.reason, plan: m.plan, bytesTotal: m.bytesTotal, bytesDone: m.bytesDone,
    rateBps: m.rateBps, etaS: m.etaS, budgetExceeded: m.budgetExceededAt !== null, cleanupPending: m.cleanupPending, targetCleanupPending: m.targetCleanupPending, autoApprove: m.bounds !== null, bounds: m.bounds, createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
    returnOf: m.returnOf, returnId: ret?.id ?? null, check: m.check, archivePending, endRequested: m.endRequested !== null, keepDays: m.keepDays,
  };
}

export function chunkCounts(chunks: ChunkState[]): ChunkCounts {
  const out: ChunkCounts = { pending: 0, copied: 0, verified: 0, skipped: 0, failed: 0, abandoned: 0 };
  for (const c of chunks) out[c.state]++;
  return out;
}
