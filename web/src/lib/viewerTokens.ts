import qrcode from 'qrcode-generator';

// Viewer tokens (design 2026-11-05): the validity choices and the QR code of
// the sign-in link (byte mode, level M, a 4-module quiet zone).

export const VALIDITY = [
  { days: 1, label: '1 day' }, { days: 7, label: '1 week' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: '365 days' },
] as const;
export const DEFAULT_VALIDITY_DAYS = 7;
export const QUIET_ZONE = 4;

export const stateClass = (s: string): string => (s === 'valid' ? 'ok' : s === 'revoked' ? 'bad' : 'warn');

// The QR code as one SVG path of 1×1 dark squares, plus its size with the quiet zone (the viewBox).
export function qrPath(text: string): { size: number; modules: number; path: string } {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
  }
  return { size: n + 2 * QUIET_ZONE, modules: n, path };
}

// The link's host, for the words under the code.
export const linkHost = (link: string): string => {
  try { return new URL(link).host; } catch { return ''; }
};

// A token's role (spec 2026-11-08 A4/B6): viewer (default) or admin of each of its accounts in cams.
export const ROLES = [{ role: 'viewer', label: 'viewer' }, { role: 'admin', label: 'admin' }] as const;
export const ADMIN_WARNING = 'An admin token can confirm held cameras and change settings in each of its accounts in cams, like a Google admin of the account.';
export const roleClass = (role: string): string => (role === 'admin' ? 'warn' : '');
