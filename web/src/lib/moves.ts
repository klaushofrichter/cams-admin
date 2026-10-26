// Camera moves between two proxies of one account: text for the Moves page.
import { bytes } from './format';
import { NO_PROFILE, PROFILE_SINCE, size, type SpaceCheck } from './profile';

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
// A given-up copy back did not copy back: its phase reads as the reason.
export const phaseText = (p: string, reason?: string | null): string => (p === 'returned' && reason === 'given_up' ? 'copy back given up' : PHASES[p] ?? p);

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
  moves_not_allowed: 'the proxy does not allow camera moves',
  camera_unreachable: 'the target cannot reach the camera',
  camera_limit: 'the target has no room for another camera',
  id_taken: 'the target already has a camera with that id',
  busy: 'a proxy is busy with another move',
  incompatible: "its configuration can't take this camera",
  no_site_ca: 'the target proxy has no site certificate authority',
  ca_does_not_cover_camera: "the site CA does not cover the camera's address",
  external_cert: 'a proxy uses an external certificate',
  other_account: 'the target is in another account',
  target_offline: 'the target is offline',
  not_routed: "the target can't be reached the same way as the source",
  host_overridden: "a cams instance overrides the camera's address",
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
  'paused:proxy_update:source': 'waiting: the new proxy needs the cam-proxy update',
  'paused:proxy_update:target': 'waiting: the original proxy needs the cam-proxy update',
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

// cams-admin's own refusals (its checks before any offer) where the reason reads differently than from the target.
const CAMS_ADMIN_REASONS: Record<string, string> = {
  incompatible: "the source's camera address or protocol differs from the registry",
  camera_limit: "the target's profile has no room for another camera (cameras or FTP ports)",
};

// Who refused a rejected move: the target proxy by name, or cams-admin's own checks; '' otherwise (or an older server).
export function refusedByText(m: { phase: string; refusedBy?: string | null; target: { name: string } }): string {
  if (m.phase !== 'rejected') return '';
  return m.refusedBy === 'target' ? `${m.target.name} refused` : m.refusedBy === 'cams-admin' ? 'cams-admin refused' : '';
}
// The refusal's reason in plain words, as the one who refused means it.
export const refusalReason = (m: { refusedBy?: string | null; reason: string | null }): string =>
  (m.refusedBy === 'cams-admin' && m.reason && CAMS_ADMIN_REASONS[m.reason]) || reasonText(m.reason);
// "Pi refused: its configuration can't take this camera" (the reason alone when who is not known).
export function refusalLine(m: { phase: string; refusedBy?: string | null; reason: string | null; target: { name: string } }): string {
  const who = refusedByText(m);
  const why = refusalReason(m);
  return who && why ? `${who}: ${why}` : who || why;
}

// A rejection is final: its record may be deleted (it holds no content).
export const canDelete = (phase: string): boolean => phase === 'rejected';

// The content checklist of the move detail (GET /moves/:id content).
export interface ContentKind { kind: string; included: boolean | null; files: number | null; bytes: number | null; rows?: number | null; chunks: { total: number; done: number; failed: number; abandoned: number } }
const KIND_LABEL: Record<string, string> = { clips: 'Clips', stills: 'Stills', events: 'Events', checks: 'Checks', archive: 'Archive' };
// Events and checks are database rows, not files: counted by rows ("654 events"), with a size only when one is known.
const ROW_KINDS: Record<string, [string, string]> = { events: ['event', 'events'], checks: ['check', 'checks'] };
function rowSize(k: ContentKind, [one, many]: [string, string]): string[] {
  const rows = k.rows ?? null;
  if (rows === 0) return ['nothing to copy'];
  return [rows !== null ? `${rows} ${rows === 1 ? one : many}` : '', k.bytes ? bytes(k.bytes) : ''].filter(Boolean);
}
// A kind's size: rows for events and checks, files and bytes for the others ("nothing to copy" when empty).
function sizeParts(k: Pick<ContentKind, 'kind' | 'files' | 'bytes' | 'rows'>): string[] {
  if (ROW_KINDS[k.kind]) return rowSize(k as ContentKind, ROW_KINDS[k.kind]);
  return k.files === 0 ? ['nothing to copy'] : [k.files !== null ? `${k.files} ${k.files === 1 ? 'file' : 'files'}` : '', k.bytes !== null ? bytes(k.bytes) : ''].filter(Boolean);
}
// "Clips: included, 12 files, 3.0 KiB; 1 of 3 days copied, 1 with failures"; "Events: included, 654 events".
export function contentLine(k: ContentKind): string {
  const name = KIND_LABEL[k.kind] ?? k.kind;
  if (k.included === null && !k.chunks.total) return `${name}: not decided yet`;
  const head = [k.included === null ? 'not decided yet' : k.included ? 'included' : 'left out', ...sizeParts(k)].join(', ');
  if (!k.chunks.total) return `${name}: ${head}`;
  const c = k.chunks;
  const progress = [`${c.done} of ${c.total} ${c.total === 1 ? 'day' : 'days'} copied`, c.failed ? `${c.failed} with failures` : '', c.abandoned ? `${c.abandoned} left behind` : ''].filter(Boolean).join(', ');
  return `${name}: ${head}; ${progress}`;
}
// The content before a move (the Start move form, move.summary): one line per kind, as the move detail counts it.
export interface KindSummary { files: number; bytes: number; rows: number; oldest: number | null; newest: number | null }
const KIND_ORDER = ['stills', 'clips', 'events', 'checks', 'archive'];
export function presummaryLines(summary: Partial<Record<string, KindSummary>>): { kind: string; text: string }[] {
  return KIND_ORDER.filter((kind) => summary[kind]).map((kind) => {
    const s = summary[kind]!;
    return { kind, text: `${KIND_LABEL[kind]}: ${sizeParts({ kind, files: s.files, bytes: s.bytes, rows: s.rows }).join(', ')}` };
  });
}
// The target's free budget against what the move needs (now, before the move); why it is unknown otherwise.
export function presummarySpaceText(target: { name: string; profile: boolean } | null, s: SpaceCheck | null): string {
  if (!target) return '';
  if (!s) return target.profile ? `${target.name} reports no storage budget: whether it fits is unknown.` : `${target.name}: ${NO_PROFILE}; its free budget is unknown.`;
  const head = `The move needs ${size(s.needBytes)}; ${target.name} has ${size(s.leftBytes)} of its ${size(s.budgetBytes)} budget left (${size(s.usedBytes)} used).`;
  const caps = s.overCaps.map((c) => `${c.kind} ${size(c.bytes)} is over its ${size(c.capBytes)} cap`).join('; ');
  return `${head}${caps ? ` ${caps[0].toUpperCase()}${caps.slice(1)}.` : ''} ${s.fits ? 'It fits.' : 'It does not all fit.'}`;
}
const PRESUMMARY_ERRORS: Record<string, string> = {
  proxy_update_needed: `the proxy needs cam-proxy ${PROFILE_SINCE} or later`,
  source_offline: 'the source proxy is offline',
  timeout: 'the source proxy did not answer in time',
  not_allowed_on_proxy: 'the source proxy does not allow camera moves (move.send)',
  unsupported_by_proxy: 'the source proxy takes no commands',
  paused_on_proxy: 'commands are paused on the source proxy',
  unknown_camera: 'the source proxy does not know this camera',
  camera_not_on_proxy: 'the camera is on no proxy',
  bad_result: 'the source proxy answered something unexpected',
  rate_limited: 'too many requests: wait a moment',
  busy: 'the source proxy is busy',
};
// Why the content is not available (the answer of GET …/move-summary), in words.
export function presummaryErrorText(answer: unknown): string {
  const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { error?: unknown; detail?: unknown };
  const code = typeof a.error === 'string' ? a.error : '';
  const detail = typeof a.detail === 'string' && a.detail ? a.detail : '';
  if (!code) return 'no answer';
  if (code === 'proxy_update_needed' && detail) return detail;
  if (code === 'proxy_failed') return `the source proxy failed${detail ? `: ${detail}` : ''}`;
  return PRESUMMARY_ERRORS[code] ?? code;
}

export function contentBasisText(basis: string | null): string {
  return basis === 'plan' ? 'As approved' : basis === 'bounds' ? 'Within the pre-approval bounds' : 'Not approved yet: sizes as the source reported them';
}

// The reason beside the phase text; none when the phase text already says it (a given-up copy back).
export const phaseReason = (p: string, reason: string | null | undefined): string => (!reason || (p === 'returned' && reason === 'given_up') ? '' : reasonText(reason));

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
  move_pending: 'a move of this camera was just requested or is under way',
};
// Why a Start move request was refused: the failed precheck rules (their detail, else the reason in words), else the error code in words.
export function refusalText(answer: unknown): string {
  const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { error?: unknown; report?: { rules?: { ok?: boolean; reason?: string; rule?: string; detail?: string }[] } };
  const failed = (a.report?.rules ?? []).filter((r) => r.ok === false).map((r) => r.detail || reasonText(r.reason) || r.rule || '');
  if (failed.filter(Boolean).length) return failed.filter(Boolean).join('; ');
  const code = typeof a.error === 'string' ? a.error : '';
  // move_pending names the camera in its detail ("a move of cam3 was just requested").
  const detail = (a as { detail?: unknown }).detail;
  if (code === 'move_pending' && typeof detail === 'string' && detail) return detail;
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
