// Camera moves between two proxies of one account: text for the Moves page.
import { bytes } from './format';

const PHASES: Record<string, string> = {
  requested: 'requested',
  offered: 'offered to the target',
  'awaiting-approval': 'waiting for approval',
  approved: 'approved',
  switching: 'switching over',
  copying: 'copying',
  cleaning: 'cleaning up',
  done: 'done',
  rejected: 'rejected',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  failed: 'failed',
};
export const phaseText = (p: string): string => PHASES[p] ?? p;

export function phaseClass(p: string): string {
  return p === 'done' ? 'ok' : p === 'failed' || p === 'rejected' ? 'bad' : p === 'cancelled' || p === 'cancelling' ? 'warn' : '';
}

export function progressText(v: { bytesDone: number | null; bytesTotal: number | null }): string {
  if (v.bytesTotal === null || v.bytesTotal === undefined) return v.bytesDone === null || v.bytesDone === undefined ? '' : bytes(v.bytesDone);
  if (v.bytesTotal === 0) return 'nothing to copy';
  const done = v.bytesDone ?? 0;
  return `${bytes(done)} of ${bytes(v.bytesTotal)} (${Math.min(100, Math.round((done / v.bytesTotal) * 100))}%)`;
}

export function etaText(s: number | null | undefined): string {
  if (s === null || s === undefined) return '';
  if (s < 60) return `about ${Math.round(s)} s left`;
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${Math.round(s / 3600)} h left`;
}

const REASONS: Record<string, string> = {
  moves_not_allowed: 'the proxy does not allow moves',
  camera_unreachable: 'the target cannot reach the camera',
  camera_limit: 'the target has no room for another camera',
  id_taken: 'the target already has a camera with that id',
  busy: 'a proxy is busy with another move',
  incompatible: 'the proxies are not compatible',
  no_site_ca: 'a proxy has no site certificate authority',
  ca_does_not_cover_camera: "the site CA does not cover the camera's address",
  external_cert: 'a proxy uses an external certificate',
  other_account: 'the target is in another account',
  target_offline: 'the target is offline',
  not_routed: 'the target is not routed to the same cams instances',
  host_overridden: 'a cams instance overrides the camera address',
  target_failed: 'the target failed',
  offer_expired: 'the offer expired unanswered',
  end_transfer: 'the transfer was ended early',
  not_registered: 'the camera is not in the registry',
  internal: 'an internal error',
  token_lost: 'cams-admin restarted before the offer went out',
  source_registry_incomplete: "the source's registry entry has no address or TLS name",
  bad_result: 'a proxy answered something unexpected',
  unknown: 'no answer',
  expired: 'not delivered in time',
};
// A failure code is `<step>:<code>` (the step that failed, the proxy's code or the command's end state).
const STEPS: Record<string, string> = {
  open: 'the source could not open the move',
  offer: 'the offer could not be sent',
  start: 'the target could not start',
  go: 'the source could not hand the camera over',
  switch: 'the switch-over failed',
  release: 'the source could not release the camera',
  source: 'the source failed',
  target: 'the target failed',
};
export function reasonText(r: string | null | undefined): string {
  if (!r) return '';
  if (REASONS[r]) return REASONS[r];
  const i = r.indexOf(':');
  const step = i > 0 ? STEPS[r.slice(0, i)] : undefined;
  if (!step) return r;
  const code = r.slice(i + 1);
  return `${step}: ${REASONS[code] ?? code}`;
}

export const cancelable = (phase: string): boolean => ['awaiting-approval', 'approved', 'switching', 'copying'].includes(phase);

// What the request was pre-approved within (the bounds it carried), for the move detail.
export function boundsText(b: { transfer: boolean; kinds: string[]; space: string; maxBudgetS: number } | null): string {
  if (!b) return 'Approval on the source proxy';
  const what = b.transfer ? `${b.kinds.join(', ')}; space ${b.space}` : 'no content';
  return `Auto-approved within: ${what}; at most ${Math.ceil(b.maxBudgetS / 60)} min`;
}
