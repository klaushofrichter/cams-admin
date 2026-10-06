// The browser side of /api/v1: JSON, and the CSRF header on every write (spec §7).
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, public field?: string) {
    super(field ? `${code} (${field})` : code);
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const write = method !== 'GET';
  const r = await fetch(`/api/v1${path}`, {
    method,
    headers: write ? { 'Content-Type': 'application/json', 'X-Cams-Admin': '1' } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 204) return undefined as T;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) onUnauthorized();
  if (!r.ok) throw new ApiFailure(r.status, j.error ?? `http_${r.status}`, j.field);
  return j as T;
}

export const errorText = (e: unknown): string => {
  if (!(e instanceof ApiFailure)) return String(e);
  const known: Record<string, string> = {
    duplicate_email: 'This email is already a user of this account.', duplicate_name: 'That name is taken.', duplicate_cams_id: 'That cams id is taken in this account.',
    duplicate_proxy_camera: 'That proxy camera id is already registered.', conflict: 'Someone changed this meanwhile: reload and try again.', confirm_mismatch: 'The typed name does not match.',
    invalid: 'Not valid', rate_limited: 'Too many requests: wait a moment.', proxy_blocked: 'The proxy is blocked.', not_reported: 'The proxy does not report that camera.',
  };
  return (known[e.code] ?? e.code) + (e.field && e.code === 'invalid' ? `: ${e.field}` : '');
};
