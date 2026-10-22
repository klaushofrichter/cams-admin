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
};
export const reasonText = (r: string | null | undefined): string => (r ? REASONS[r] ?? r : '');

export const cancelable = (phase: string): boolean => ['awaiting-approval', 'approved', 'switching', 'copying'].includes(phase);
