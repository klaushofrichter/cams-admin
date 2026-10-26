import type { Db } from '../db/open';
import type { MoveBounds, MoveCheck } from './types';
import type { Move, ChunkState, ChunkStateName } from './store';
import type { SpaceCheck } from './space';
import { isCount } from '../validate';

// What the API shows of a move. Never the token, its hash, the target's
// public key, the leaf fingerprint or the target's address: fields are named
// one by one, nothing is spread from the row.
export interface MoveView {
  id: string; requestId: string; accountId: string; camsId: string; cameraName: string; source: { id: string; name: string }; target: { id: string; name: string };
  phase: string; reason: string | null;
  // A rejected move: who refused (the target, or cams-admin's own checks before any offer) and the refusal's detail in words.
  refusedBy: 'target' | 'cams-admin' | null; detail: string | null;
  plan: unknown; bytesTotal: number | null; bytesDone: number | null; rateBps: number | null; etaS: number | null;
  budgetExceeded: boolean; cleanupPending: boolean; targetCleanupPending: boolean; autoApprove: boolean; bounds: MoveBounds | null; createdAt: number; updatedAt: number; endedAt: number | null;
  // A cancelled move's copy back (returnId) and a copy back's cancelled move (returnOf); the receiving side's check; Archive still to copy; End waiting for it.
  returnOf: string | null; returnId: string | null; check: MoveCheck | null; archivePending: boolean; endRequested: boolean; keepDays: number | null;
  // The space the move needs against the target's profile when the request arrived (null: the target reported none).
  space: SpaceCheck | null;
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
    target: { id: m.targetProxyId, name: name(m.targetProxyId) }, phase: m.phase, reason: m.reason,
    refusedBy: m.phase === 'rejected' ? (m.offeredAt !== null ? 'target' : 'cams-admin') : null, detail: m.detail, plan: m.plan, bytesTotal: m.bytesTotal, bytesDone: m.bytesDone,
    rateBps: m.rateBps, etaS: m.etaS, budgetExceeded: m.budgetExceededAt !== null, cleanupPending: m.cleanupPending, targetCleanupPending: m.targetCleanupPending, autoApprove: m.bounds !== null, bounds: m.bounds, createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
    returnOf: m.returnOf, returnId: ret?.id ?? null, check: m.check, archivePending, endRequested: m.endRequested !== null, keepDays: m.keepDays,
    space: m.space ?? null,
  };
}

export function chunkCounts(chunks: ChunkState[]): ChunkCounts {
  const out: ChunkCounts = { pending: 0, copied: 0, verified: 0, skipped: 0, failed: 0, abandoned: 0 };
  for (const c of chunks) out[c.state]++;
  return out;
}

// The content checklist of the move detail: each kind included or left out (by the approved plan, else by the
// pre-approval bounds; null when neither decided yet), its size (the target's per-kind space need when its offer
// named one, else the source's summary), its database rows (events and checks are rows, not files; the summary's
// `rows`) and its copy progress from the chunk states (a chunk is one kind's day).
export interface ContentKind { kind: string; included: boolean | null; files: number | null; bytes: number | null; rows: number | null; chunks: { total: number; done: number; failed: number; abandoned: number } }
export interface Content { basis: 'plan' | 'bounds' | null; kinds: ContentKind[] }
// The order the Moves page shows them in (as cams-admin's Start move bounds list them).
const KIND_ORDER = ['clips', 'stills', 'events', 'checks', 'archive'] as const;
const count = (x: unknown): number | null => (isCount(x) ? x : null);
export function moveContent(m: Pick<Move, 'plan' | 'bounds' | 'summary'>, chunks: ChunkState[], perKind: Record<string, unknown> = {}): Content {
  const plan = m.plan && typeof m.plan === 'object' && Array.isArray((m.plan as { kinds?: unknown }).kinds) ? (m.plan as { transfer?: unknown; kinds: unknown[] }) : null;
  const pick = plan ? { transfer: plan.transfer !== false, kinds: plan.kinds } : m.bounds ? { transfer: m.bounds.transfer, kinds: m.bounds.kinds as unknown[] } : null;
  const summary = (m.summary && typeof m.summary === 'object' ? m.summary : {}) as Record<string, { files?: unknown; bytes?: unknown; rows?: unknown } | undefined>;
  return {
    basis: plan ? 'plan' : m.bounds ? 'bounds' : null,
    kinds: KIND_ORDER.map((k) => {
      const own = chunks.filter((c) => c.id.startsWith(`${k}:`));
      return {
        kind: k, included: pick ? pick.transfer && pick.kinds.includes(k) : null,
        files: count(summary[k]?.files), bytes: count(perKind[k]) ?? count(summary[k]?.bytes), rows: count(summary[k]?.rows),
        chunks: { total: own.length, done: own.filter((c) => c.state === 'verified' || c.state === 'skipped').length, failed: own.filter((c) => c.state === 'failed').length, abandoned: own.filter((c) => c.state === 'abandoned').length },
      };
    }),
  };
}
