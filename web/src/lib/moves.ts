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
  returning: 'copying back',
  returned: 'copied back',
};
export const phaseText = (p: string): string => PHASES[p] ?? p;

export function phaseClass(p: string): string {
  return p === 'done' ? 'ok' : p === 'failed' || p === 'rejected' ? 'bad' : p === 'cancelled' || p === 'cancelling' || p === 'returning' ? 'warn' : '';
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
  given_up: 'copy back given up',
  'paused:no_space': 'paused: no room on the original proxy',
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

export const canGiveUp = (phase: string): boolean => phase === 'returning';

// The receiving side's completeness check in a line: "Complete", or the counts per kind ("2 stills missing, 1 Archive failed").
interface Check { complete: boolean; missing?: Record<string, number>; recovered?: Record<string, number>; failed?: Record<string, number>; expired?: Record<string, number> }
export function checkText(c: Check | null | undefined): string {
  if (!c) return '';
  if (c.complete) return 'Complete';
  const kind = (k: string) => (k === 'archive' ? 'Archive' : k);
  const part = (counts: Record<string, number> | undefined, what: string) => Object.entries(counts ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${kind(k)} ${what}`);
  const parts = [...part(c.missing, 'missing'), ...part(c.failed, 'failed'), ...part(c.expired, 'expired')];
  return parts.length ? parts.join(', ') : 'Incomplete';
}

// The End transfer button while Archive may still be copying: it waits for Archive, and once asked it is only waiting.
export function endLabel(m: { archivePending: boolean; endRequested: boolean }): string {
  if (m.endRequested) return 'Ending after Archive';
  return m.archivePending ? 'End after Archive…' : 'End transfer…';
}

// What the request was pre-approved within (the bounds it carried), for the move detail.
export function boundsText(b: { transfer: boolean; kinds: string[]; space: string; maxBudgetS: number } | null): string {
  if (!b) return 'Approval on the source proxy';
  const what = b.transfer ? `${b.kinds.join(', ')}; space ${b.space}` : 'no content';
  return `Auto-approved within: ${what}; at most ${Math.ceil(b.maxBudgetS / 60)} min`;
}

// The Start move form: the request body with the default bounds (copy everything, space as it fits, one day).
export function startBody(sourceProxyId: string, targetProxyId: string, cameraId: string) {
  return {
    sourceProxyId, targetProxyId, cameraId,
    bounds: { transfer: true, kinds: ['clips', 'stills', 'events', 'checks', 'archive'], space: 'fit', maxBudgetS: 86400 },
  };
}

const REFUSALS: Record<string, string> = {
  not_found: 'the proxy or the camera was not found',
  camera_not_on_source: 'the camera is not on the source proxy',
  source_offline: 'the source is offline',
  target_registry_incomplete: "the target's registry entry has no address",
  invalid: 'the request is not valid',
};
// Why a Start move request was refused: the failed precheck rules (their detail, else the reason in words), else the error code in words.
export function refusalText(answer: unknown): string {
  const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { error?: unknown; report?: { rules?: { ok?: boolean; reason?: string; rule?: string; detail?: string }[] } };
  const failed = (a.report?.rules ?? []).filter((r) => r.ok === false).map((r) => r.detail || reasonText(r.reason) || r.rule || '');
  if (failed.filter(Boolean).length) return failed.filter(Boolean).join('; ');
  const code = typeof a.error === 'string' ? a.error : '';
  return code ? (REFUSALS[code] ?? reasonText(code)) : 'the move was refused';
}

// A camera in the Start move list: its name, then its alias (camsId), the
// proxy's own id when that differs, and its address unless it is reached
// through the proxy ("from-proxy").
export function cameraLabel(c: { name?: string | null; camsId: string; proxyCameraId?: string | null; host?: string | null }): string {
  const extra = [c.camsId, c.proxyCameraId && c.proxyCameraId !== c.camsId ? c.proxyCameraId : null, c.host && c.host !== 'from-proxy' ? c.host : null].filter(Boolean);
  if (!c.name) return [c.camsId, ...extra.slice(1)].join(', ');
  return `${c.name} (${extra.join(', ')})`;
}

// The moves still under way (not ended): the menu's marker and the Dashboard line.
export function activeMoves<T extends { endedAt: number | null }>(items: T[] | undefined): T[] {
  return (items ?? []).filter((m) => m.endedAt === null);
}

// One move in a line: "Backyard: Mini PC → een, copying 25%".
export function activeLine(m: { cameraName?: string | null; camsId: string; source: { name: string }; target: { name: string }; phase: string; bytesDone: number | null; bytesTotal: number | null }): string {
  const pct = (m.phase === 'copying' || m.phase === 'returning') && m.bytesTotal ? ` ${Math.min(100, Math.round(((m.bytesDone ?? 0) / m.bytesTotal) * 100))}%` : '';
  return `${m.cameraName || m.camsId}: ${m.source.name} → ${m.target.name}, ${phaseText(m.phase)}${pct}`;
}
