import type { CommandRow } from '../commands/service';
import type { Proxy } from '../registry';
import type { ChunkState } from './store';
import { COMMAND_STATES, isOpen } from '../commands/states';

// What the two halves of the move job (Moves, Returns) share.

// A command's final states (`unknown`: the proxy never answered; for a move, final too).
export const FINAL_STATES: ReadonlySet<string> = new Set(COMMAND_STATES.filter((s) => !isOpen(s)));
// A command that went unanswered (expired, or the proxy never said).
export const unanswered = (r: CommandRow) => r.state === 'expired' || r.state === 'unknown';
// A command the proxy answered (done, failed, refused).
export const answered = (r: CommandRow) => FINAL_STATES.has(r.state) && !unanswered(r);
// The verified chunks a (re)start skips (B34), newest last, at most this many.
export const DONE_MAX = 512;
export const verifiedDone = (chunks: ChunkState[]) => chunks.filter((c) => c.state === 'verified').map((c) => c.id).slice(-DONE_MAX);
// The source as move.offer and move.return.start name it.
// The source's TLS name in an offer. A plain-http source without one (the Pi, no site CA) names its url's
// host: the contract needs a name, and the target pins and checks it only for an https source.
export const sourceTlsName = (p: Proxy): string | null =>
  p.tlsServername ?? (p.url?.startsWith('http://') ? new URL(p.url).hostname : null);
export const sourceRef = (p: Proxy) => ({ proxyId: p.id, name: p.name, url: p.url, caFingerprints: p.caFingerprints.slice(0, 2), tlsServername: sourceTlsName(p) });
// Another try is due: `since` lies BASE · 2^(attempts-1) back (capped at an hour).
export const RETRY_CAP_MS = 3600_000;
export const backoffDue = (base: number, attempts: number, since: number, now: number) => now - since >= Math.min(base * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);

// Who did it, as the audit row names it.
export type Who = { actorType: 'proxy' | 'system' | 'sysadmin'; actor: string };

// A target's settingsProposal (cam-proxy #240): its settings when it names any, else null (the payload check validated the shape).
export function proposalSettings(x: unknown): Record<string, unknown> | null {
  const st = (x as { settings?: unknown } | null | undefined)?.settings;
  return st && typeof st === 'object' && !Array.isArray(st) && Object.keys(st).length ? (st as Record<string, unknown>) : null;
}
// The proposal as move.answer relays it: its settings and its firewall note (when it has one).
export function answerProposal(x: unknown): { settings: Record<string, unknown>; firewall?: string } | null {
  const settings = proposalSettings(x);
  if (!settings) return null;
  const firewall = (x as { firewall?: unknown }).firewall;
  return { settings, ...(typeof firewall === 'string' && firewall ? { firewall } : {}) };
}
