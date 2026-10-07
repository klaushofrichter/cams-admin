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
  ['camera-new', 'new cameras'], ['camera-change', 'changed cameras'], ['camera-override', 'camera overrides for this instance'], ['pins-set', 'pins set'], ['proxy-tls-name', 'proxy TLS names'], ['token-external', 'external tokens'],
  ['registry-only', 'in the registry, not in the file'], ['camera-kept', 'cameras with values kept for another instance'],
];

export function importSummary(r: { changes: { kind: string }[]; mismatches: unknown[] }): { label: string; count: number }[] {
  const out = LABELS.map(([k, label]) => ({ label, count: r.changes.filter((c) => c.kind === k).length })).filter((x) => x.count > 0);
  if (r.mismatches.length) out.push({ label: 'mismatches', count: r.mismatches.length });
  return out;
}

const FIELD_LABEL: Record<string, string> = { cameraUser: 'camera user', proxyId: 'proxy', proxyCameraId: "proxy's camera id", tlsServername: 'TLS name', webUiUrl: 'web UI URL', webUiNote: 'web UI note' };
const fieldsText = (fields: Record<string, any>) => Object.entries(fields)
  .map(([k, v]) => `${FIELD_LABEL[k] ?? k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}${'override' in v && v.override === null ? " (the camera's value)" : ''}`).join(', ');

// One importer change as a line of the dry run.
export function describeChange(c: any): string {
  switch (c.kind) {
    case 'proxy-matched': return `proxy ${c.name}: matched by ${c.by}`;
    case 'proxy-new': return `new proxy ${c.name} (${c.url})`;
    case 'route-add': return `route ${c.name} → ${c.url ?? '(registered URL)'}`;
    case 'route-change': return `route ${c.name}: ${c.was ?? '(hidden)'} → ${c.url ?? '(registered URL)'}`;
    case 'route-hide': return `hide ${c.name} for this instance`;
    case 'camera-new': return `new camera ${c.camsId}`;
    case 'camera-change': return `camera ${c.camsId}: ${fieldsText(c.fields)}`;
    case 'camera-override': return `camera ${c.camsId}: override for ${c.instance}: ${fieldsText(c.fields)}`;
    case 'camera-kept': return `camera ${c.camsId}: kept, ${c.servedTo.join(', ')} uses them: ${Object.entries(c.fields).map(([k, v]) => `${FIELD_LABEL[k] ?? k} ${JSON.stringify(v)}`).join(', ')}`;
    case 'pins-set': return `pins of ${c.name}: ${c.to.join(', ')}`;
    case 'proxy-tls-name': return `TLS name of ${c.name}: ${c.to}`;
    case 'token-external': return `external ${c.tokenKind} token on ${c.name} (${c.hashPrefix})`;
    case 'registry-only': return `camera ${c.camsId}: in the registry, not in the file (kept)`;
    default: return c.kind;
  }
}
