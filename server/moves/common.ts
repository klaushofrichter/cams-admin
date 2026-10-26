import type { CommandRow } from '../commands/service';
import type { Proxy } from '../registry';
import type { ChunkState } from './store';

// What the two halves of the move job (Moves, Returns) share.

// A command's final states (`unknown`: the proxy never answered; for a move, final too).
export const FINAL_STATES = new Set(['done', 'refused', 'failed', 'expired', 'unknown']);
// A command that went unanswered (expired, or the proxy never said).
export const unanswered = (r: CommandRow) => r.state === 'expired' || r.state === 'unknown';
// A command the proxy answered (done, failed, refused).
export const answered = (r: CommandRow) => FINAL_STATES.has(r.state) && !unanswered(r);
// The verified chunks a (re)start skips (B34), newest last, at most this many.
export const DONE_MAX = 512;
export const verifiedDone = (chunks: ChunkState[]) => chunks.filter((c) => c.state === 'verified').map((c) => c.id).slice(-DONE_MAX);
// The source as move.offer and move.return.start name it.
export const sourceRef = (p: Proxy) => ({ proxyId: p.id, name: p.name, url: p.url, caFingerprints: p.caFingerprints.slice(0, 2), tlsServername: p.tlsServername });
// Another try is due: `since` lies BASE · 2^(attempts-1) back (capped at an hour).
export const RETRY_CAP_MS = 3600_000;
export const backoffDue = (base: number, attempts: number, since: number, now: number) => now - since >= Math.min(base * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);

// Who did it, as the audit row names it.
export type Who = { actorType: 'proxy' | 'system' | 'sysadmin'; actor: string };
