// The browser side of /api/v1: JSON, and the CSRF header on every write (spec §7).
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, public field?: string, public body?: unknown) {
    super(field ? `${code} (${field})` : code);
  }
}

// Every write: JSON plus the header a cross-site form can't send. Reads carry the header too: a read that sends
// a proxy command (the Start move form's move-summary) refuses a request without it.
export const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Cams-Admin': '1' } as const;
const READ_HEADERS = { 'X-Cams-Admin': '1' } as const;

let onUnauthorized: () => void = () => undefined;
export const setUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const write = method !== 'GET';
  const r = await fetch(`/api/v1${path}`, {
    method,
    headers: write ? WRITE_HEADERS : READ_HEADERS,
    body: write ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 204) return undefined as T;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) onUnauthorized();
  if (!r.ok) throw new ApiFailure(r.status, j.error ?? `http_${r.status}`, j.field, j);
  return j as T;
}

const known: Record<string, string> = {
    duplicate_email: 'This email is already a user of this account.', duplicate_name: 'That name is taken.', duplicate_cams_id: 'That cams id is taken in this account.',
    duplicate_proxy_camera: 'That proxy camera id is already registered.', rename_at_camera: "This camera is behind a proxy: a new name goes to the camera. Reload, and edit it again.",
    proxy_offline: 'The proxy is offline: a rename needs it connected. Try again when it is online.', not_allowed_on_proxy: 'The proxy does not allow this (its allow list).', conflict: 'Someone changed this meanwhile: reload and try again.', confirm_mismatch: 'The typed name does not match.',
    invalid: 'Not valid', fleet_busy: "Another proxy's disruptive action is still running: wait until it reports back (at most 15 min).", rate_limited: 'Too many requests: wait a moment.', proxy_blocked: 'The proxy is blocked.', not_reported: 'The proxy does not report that camera.',
    viewer_tokens_unconfigured: 'Tokens are off: this server has no viewer token key.', too_many_tokens: 'Too many valid tokens for an account (at most 50).', token_unreadable: "This token can't be read with the server's key: make a new one.",
    // PoE switches and camera power.
    switch_taken: 'That switch (by its serial number) is already registered under another name.',
    switch_mismatch: 'The device at this address is a different switch than the one registered (another serial number).',
    switch_busy: 'Another step on this switch is still running: wait until it finishes.',
    switch_operated: 'The proxy operates a PoE switch: move or remove the switch first.',
    save_failed: 'The switch answered, but the change could not be saved: nothing was changed.',
    not_poe: 'This camera is not powered by a PoE port (data only, or a power adapter): it cannot be power-cycled from here.',
    power_unknown: 'Where this camera gets its power is not known yet: verify or find it first.',
    trunk_port: 'That port leads to another switch (a configuration issue): cams-admin does not power-cycle it.',
    host_unknown: "The camera's address is not known to cams-admin: set its host first.",
    not_verified: 'The camera was not found on that port: nothing was cut. Verify it, or find it again.',
    password_unset: "The proxy has no password for this switch (it is tied to the address): set it again on the proxy's Proxy settings, PoE switches.",
    no_switch: 'No active PoE switch to ask: add a switch and test it first.',
    switch_unavailable: 'The camera\'s switch is not active.',
    switch_not_active: 'Test the switch first: it is not active yet.',
    busy: 'A check or power-cycle is already running on this camera.',
    not_on_port: 'The camera was not found on that port.',
    forbidden: 'Only a system administrator can do this.',
  };
export const codeText = (code: string): string | undefined => known[code];
export const errorText = (e: unknown): string => {
  if (!(e instanceof ApiFailure)) return String(e);
  if (e.code === 'fleet_limit') return `Fleet limit: at most 3 disruptive actions in 10 minutes across all proxies${e.field ? `; ${e.field}` : ''}.`;
  const message = (e.body as { message?: unknown } | undefined)?.message;
  if (e.code === 'invalid' && typeof message === 'string') return `Not valid: ${message}.`;
  return (known[e.code] ?? e.code) + (e.field && e.code === 'invalid' ? `: ${e.field}` : '');
};
