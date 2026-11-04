import type { OpsScope } from './tokens';

// The write routes an operations token may use, and the scope each needs.
// Paths in Express syntax, relative to /api/v1. A route not listed here is
// session-only: a token gets 403 `scope` there (test/ops-auth.test.ts walks
// the router, so a new route never accepts tokens by accident).

// bodyKeys: a route a token may use for part of its body only. A key outside the
// list is refused like a route outside the table (403 `scope`), so a token can't
// reach what the route also does for a session.
export interface OpsRoute { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; scope: OpsScope; bodyKeys?: readonly string[] }

const proxyBase = '/accounts/:accountId/proxies/:proxyId';
const tokenBase = `${proxyBase}/tokens`;
export const OPS_ROUTES: readonly OpsRoute[] = [
  { method: 'POST', path: `${tokenBase}/:tokenId/revoke`, scope: 'tokens' },
  { method: 'POST', path: `${tokenBase}/:tokenId/retire`, scope: 'tokens' },
  { method: 'POST', path: `${tokenBase}/apply`, scope: 'tokens' },
  { method: 'PUT', path: '/cams-instances/:instanceId/routes/:proxyId', scope: 'routes' },
  { method: 'DELETE', path: '/cams-instances/:instanceId/routes/:proxyId', scope: 'routes' },
  { method: 'DELETE', path: '/cams-instances/:instanceId/camera-overrides/:cameraId', scope: 'routes' },
  { method: 'POST', path: '/moves', scope: 'moves' },
  { method: 'POST', path: '/moves/:moveId/cancel', scope: 'moves' },
  { method: 'POST', path: '/moves/:moveId/end-transfer', scope: 'moves' },
  { method: 'DELETE', path: '/moves/:moveId', scope: 'moves' },
  // Editing (never creating or deleting) a proxy or a camera: TLS site, CA
  // pins, host, TLS name. A cams viewer still holds a changed endpoint until confirmed.
  { method: 'PATCH', path: '/accounts/:accountId/proxies/:proxyId', scope: 'registry' },
  { method: 'PATCH', path: '/accounts/:accountId/cameras/:cameraId', scope: 'registry' },
  // A cams instance's name, address and notes. `accounts` stays with a sign-in: it decides which accounts'
  // users and cameras the instance is sent, and dropping one revokes the tokens it holds there.
  { method: 'PATCH', path: '/cams-instances/:instanceId', scope: 'registry', bodyKeys: ['name', 'displayName', 'baseUrl', 'notes', 'version'] },
  // The proxy's reported site-CA pins into its row (a change of existing pins; a proxy without pins takes them itself).
  { method: 'POST', path: `${proxyBase}/pins/from-report`, scope: 'registry' },
  // Onboarding: adopting a camera the proxy reports and the registry lacks (host from-proxy, model from the
  // report). A plain POST /accounts/:accountId/cameras stays session-only.
  { method: 'POST', path: `${proxyBase}/adopt`, scope: 'onboard' },
  // Camera actions, renames and proxy restarts (cam-proxy onboarding design §5); each still stops at the proxy's
  // own allow-list, and the disruptive ones still need the typed confirm and pass the fleet gate.
  { method: 'POST', path: `${proxyBase}/actions`, scope: 'actions' },
  { method: 'POST', path: `${proxyBase}/cameras/:camera/name`, scope: 'actions' },
  { method: 'POST', path: `${proxyBase}/restart`, scope: 'actions' },
  { method: 'POST', path: `${proxyBase}/cameras/:camera/onboarding/refresh`, scope: 'actions' },
  // Proxy settings: preview, then apply by preview id (the remote-settable ones only).
  { method: 'POST', path: `${proxyBase}/config/refresh`, scope: 'config' },
  { method: 'POST', path: `${proxyBase}/config/preview`, scope: 'config' },
  { method: 'POST', path: `${proxyBase}/config/apply`, scope: 'config' },
  { method: 'POST', path: `${proxyBase}/config/rollback/preview`, scope: 'config' },
  { method: 'POST', path: `${proxyBase}/config/rollback/apply`, scope: 'config' },
  // Removing a camera from its account (offboarding). Enrolling a proxy stays with a sign-in (§10.4).
  { method: 'DELETE', path: '/accounts/:accountId/cameras/:cameraId', scope: 'offboard' },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each :param is one non-empty segment without '/'; the rest matches literally.
const compiled = OPS_ROUTES.map((r) => ({
  method: r.method, scope: r.scope, bodyKeys: r.bodyKeys,
  re: new RegExp('^' + r.path.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : escape(s))).join('/') + '$'),
}));

const match = (method: string, path: string) => compiled.find((r) => r.method === method && r.re.test(path));

// The scope a request needs, or null (session-only, or not a write).
export function opsScopeFor(method: string, path: string): OpsScope | null {
  return match(method, path)?.scope ?? null;
}

// Whether a token may send this body. Only a route with bodyKeys limits it; a body
// that is no object changes nothing, and the route itself answers 400.
export function opsBodyAllowed(method: string, path: string, body: unknown): boolean {
  const keys = match(method, path)?.bodyKeys;
  if (!keys || typeof body !== 'object' || body === null || Array.isArray(body)) return true;
  return Object.keys(body).every((k) => keys.includes(k));
}
