// The camera page's onboarding texts (cam-proxy onboarding design §5): the proxy's steps (§4.5 order), what is
// still missing, and one line per viewer. The server's view is server/onboarding/view.ts.

export const STEP_LABEL: Record<string, string> = {
  reachable: 'Reachable', login: 'Camera login', trust: 'Certificate trusted', capabilities: 'Capabilities read', stream: 'Video stream', events: 'Events',
  ftp: 'Clip upload (FTP)', time: 'Time', name: 'Name', poe: 'PoE port', profile: "Within the proxy's profile",
};
// A newer proxy's step reads as its name.
export const stepLabel = (step: string): string => STEP_LABEL[step] ?? step;

export interface ViewerState {
  instanceId: string; name: string; state: string; lastSeenAt: number | null; reportAt: number | null; hidden: boolean; applied: boolean | null;
  held: string[]; heldProxy: string[]; keptOld: string[]; problems: { code: string; detail: string | null }[];
}

const VIEWER_GAP: Record<string, string> = {
  held: 'holds a change (confirm it in that viewer)', 'kept-old': 'kept the old value (confirm it in that viewer)',
  'not-applied': 'has not applied the current configuration yet', 'no-report': 'no report yet',
};

export function missingText(m: string): string {
  if (m === 'proxy-offline') return 'The proxy is offline';
  if (m === 'proxy:onboarding-unreported') return 'The proxy reports no onboarding status for this camera (older cam-proxy?)';
  if (m === 'proxy:not-ready') return 'Proxy: not ready yet';
  if (m === 'not-registered') return 'Not in the account yet';
  if (m.startsWith('proxy:')) return `Proxy: ${stepLabel(m.slice(6))} missing`;
  const v = /^viewer:(.+):([a-z-]+)$/.exec(m);
  if (v && VIEWER_GAP[v[2]]) return `Viewer ${v[1]}: ${VIEWER_GAP[v[2]]}`;
  return m;
}

export function viewerLine(v: ViewerState): string {
  if (v.hidden) return 'hidden here';
  if (v.applied === null) return 'no report yet';
  const held = [...v.held, ...v.heldProxy];
  if (held.length) return `holds: ${held.join(', ')}`;
  if (v.keptOld.length) return `kept old: ${v.keptOld.join(', ')}`;
  return v.applied ? 'applied' : 'not applied yet';
}
