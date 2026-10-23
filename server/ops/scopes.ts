import type { OpsScope } from './tokens';

// The write routes an operations token may use, and the scope each needs.
// Paths in Express syntax, relative to /api/v1. A route not listed here is
// session-only: a token gets 403 `scope` there (test/ops-auth.test.ts walks
// the router, so a new route never accepts tokens by accident).

export interface OpsRoute { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; scope: OpsScope }

const tokenBase = '/accounts/:accountId/proxies/:proxyId/tokens';
export const OPS_ROUTES: readonly OpsRoute[] = [
  { method: 'POST', path: `${tokenBase}/:tokenId/revoke`, scope: 'tokens' },
  { method: 'POST', path: `${tokenBase}/:tokenId/retire`, scope: 'tokens' },
  { method: 'POST', path: `${tokenBase}/apply`, scope: 'tokens' },
  { method: 'PUT', path: '/cams-instances/:instanceId/routes/:proxyId', scope: 'routes' },
  { method: 'DELETE', path: '/cams-instances/:instanceId/routes/:proxyId', scope: 'routes' },
  { method: 'DELETE', path: '/cams-instances/:instanceId/camera-overrides/:cameraId', scope: 'routes' },
  { method: 'POST', path: '/moves/:moveId/cancel', scope: 'moves' },
  { method: 'POST', path: '/moves/:moveId/end-transfer', scope: 'moves' },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each :param is one non-empty segment without '/'; the rest matches literally.
const compiled = OPS_ROUTES.map((r) => ({
  method: r.method, scope: r.scope,
  re: new RegExp('^' + r.path.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : escape(s))).join('/') + '$'),
}));

// The scope a request needs, or null (session-only, or not a write).
export function opsScopeFor(method: string, path: string): OpsScope | null {
  return compiled.find((r) => r.method === method && r.re.test(path))?.scope ?? null;
}
