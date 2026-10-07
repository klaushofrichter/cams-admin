// P4: a cams instance's state as the dashboard and its page show it, and
// the importer's result in a few counted lines.

export type InstanceState = 'ok' | 'stale' | 'diverged' | 'held' | 'shadow-diff' | 'never';
export interface InstanceRow { lastPullAt: number | null; mode: string | null; held: number; keptOld: number; shadowDifferences: number | null }

// cams pulls every 30–60 s; five minutes without a pull is stale.
export const STALE_MS = 5 * 60_000;

export function instanceState(r: InstanceRow, now: number): InstanceState {
  if (r.lastPullAt === null) return 'never';
  if (now - r.lastPullAt > STALE_MS) return 'stale';
  if (r.keptOld > 0) return 'diverged';
  if (r.held > 0) return 'held';
  if (r.mode === 'shadow' && (r.shadowDifferences ?? 0) > 0) return 'shadow-diff';
  return 'ok';
}

const TEXT: Record<InstanceState, string> = {
  never: 'never pulled', stale: 'no pull for 5 minutes', diverged: 'an admin kept old connection data', held: 'holds changed connection data until an admin confirms',
  'shadow-diff': 'shadow differences', ok: 'ok',
};
export const stateText = (s: InstanceState): string => TEXT[s];
export const stateClass = (s: InstanceState): string => (s === 'ok' ? 'ok' : s === 'never' ? '' : s === 'stale' || s === 'diverged' ? 'bad' : 'warn');

const LABELS: [string, string][] = [
  ['proxy-matched', 'proxies matched'], ['proxy-new', 'new proxies'], ['route-add', 'routes added'], ['route-change', 'routes changed'], ['route-hide', 'proxies hidden for this instance'],
  ['camera-new', 'new cameras'], ['camera-change', 'changed cameras'], ['pins-set', 'pins set'], ['proxy-tls-name', 'proxy TLS names'], ['token-external', 'external tokens'],
  ['registry-only', 'in the registry, not in the file'],
];

export function importSummary(r: { changes: { kind: string }[]; mismatches: unknown[] }): { label: string; count: number }[] {
  const out = LABELS.map(([k, label]) => ({ label, count: r.changes.filter((c) => c.kind === k).length })).filter((x) => x.count > 0);
  if (r.mismatches.length) out.push({ label: 'mismatches', count: r.mismatches.length });
  return out;
}
