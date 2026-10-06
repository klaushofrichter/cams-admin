export function ago(t: number | null, now: number): string {
  if (t === null || t === undefined) return 'never';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function when(t: number | null): string {
  return t === null || t === undefined ? '—' : new Date(t).toLocaleString();
}

export function stateClass(s: string): string {
  if (s === 'online') return 'ok';
  if (s === 'offline' || s === 'rejected' || s === 'revoked') return 'bad';
  if (s === 'stopped') return 'warn';
  return '';
}

const LABELS: Record<string, string> = { 'never-connected': 'never connected', rejected: 'rejected (no key)', revoked: 'blocked' };
export const stateLabel = (s: string): string => LABELS[s] ?? s;

export function camClass(online: boolean | null): string {
  return online === true ? 'ok' : online === false ? 'bad' : '';
}

export const bytes = (n: number | null | undefined): string => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`);

// A proxy key: active, revoked, or pending (redeemed, no hello yet).
export function keyState(k: { revokedAt: number | null; revokedReason: string | null; pending?: 'waiting' | 'expired' | null }): string {
  if (k.revokedAt) return `revoked (${k.revokedReason})`;
  if (k.pending === 'waiting') return 'pending: waiting for its first connection';
  if (k.pending === 'expired') return 'pending, expired: never connected (unused enroll answer)';
  return 'active';
}
