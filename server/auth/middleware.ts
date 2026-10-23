import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config';
import type { Clock } from '../clock';
import { SESSION_COOKIE, type Sessions } from './session';
import { Buckets } from '../channel/limits';
import type { Audit } from '../audit';
import type { OpsScope, OpsTokens } from '../ops/tokens';
import { opsScopeFor } from '../ops/scopes';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function securityHeaders(cfg: Config): RequestHandler {
  const https = cfg.publicUrl.startsWith('https://');
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// 401 without a valid session; res.locals.session otherwise.
export function requireSysadmin(sessions: Sessions): RequestHandler {
  return (req, res, next) => {
    const s = sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!s) return void res.status(401).json({ error: 'unauthorized' });
    res.locals.session = s;
    next();
  };
}

// Spec §7: writes carry JSON, X-Cams-Admin: 1, and a same-origin Origin.
// A cross-site form can't set the header; a cross-site fetch with it needs a
// CORS preflight that is never granted.
export function requireCsrf(cfg: Config): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE.has(req.method)) return next();
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const origin = req.headers.origin;
    if (req.headers['x-cams-admin'] !== '1' || ct !== 'application/json' || (origin !== undefined && origin !== cfg.publicOrigin)) {
      return void res.status(403).json({ error: 'csrf' });
    }
    next();
  };
}

// 120 writes per minute per session (never per address).
export function writeLimiter(cfg: Config, clock: Clock): RequestHandler {
  const b = new Buckets({ capacity: cfg.limits.writesPerSessionPerMin, windowMs: 60_000 });
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const t = b.take(`session:${res.locals.session.idHash}`, clock.now());
    if (!t.ok) return void res.status(429).set('Retry-After', String(t.retryAfterS)).json({ error: 'rate_limited', retryAfterS: t.retryAfterS });
    next();
  };
}

// The token of a `Bearer <token>` header, else null. Only that is a token
// attempt (here and on the diag API): a bare or malformed Bearer header, or an
// ingress's Basic header, carries no credential, so the session decides.
export function bearerOf(req: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

type AuthDeps = { sessions: Sessions; ops: OpsTokens; audit: Audit; cfg: Config; clock: Clock };

// A bad token: 401, never keyed on the client address (one throttled record for all refusals).
function refuseToken(audit: Audit, res: Response): void {
  audit.throttled('ops-auth-refused', { actorType: 'system', actor: 'system', action: 'ops-auth-refused', outcome: 'refused' });
  res.status(401).json({ error: 'unauthorized' });
}

// A valid token outside its scopes: 403, one throttled record per token. The
// method and the scope needed only, never the path's ids or the body.
function refuseScope(audit: Audit, res: Response, t: { id: string; hashPrefix: string }, method: string, scope: OpsScope | null): void {
  audit.throttled(`ops-scope-refused:${t.id}`, { actorType: 'system', actor: `ops-token:${t.hashPrefix}`, action: 'ops-scope-refused', outcome: 'refused', detail: { method, scope } });
  res.status(403).json({ error: 'scope' });
}

// The API's auth: a sysadmin session (with the CSRF check and its write
// limit), or an operations token on a write route its scopes cover. With a
// Bearer header the token decides; a session cookie is ignored. Sets
// res.locals.actor (the e-mail, or ops-token:<8hex>).
export function requireAuth(d: AuthDeps): RequestHandler[] {
  // 60 writes a minute per token (bearer only: no CSRF check to pass).
  const tokenWrites = new Buckets({ capacity: 60, windowMs: 60_000 });
  const auth: RequestHandler = (req, res, next) => {
    const token = bearerOf(req);
    if (token === null) {
      const s = d.sessions.get(req.cookies?.[SESSION_COOKIE]);
      if (!s) return void res.status(401).json({ error: 'unauthorized' });
      res.locals.session = s;
      res.locals.actor = s.email;
      return next();
    }
    const t = d.ops.verifyScoped(token);
    if (!t) return refuseToken(d.audit, res);
    // Writes only; reads use the diag token.
    const scope = SAFE.has(req.method) ? null : opsScopeFor(req.method, req.path);
    if (!scope || !t.scopes.includes(scope)) return refuseScope(d.audit, res, t, req.method, scope);
    const b = tokenWrites.take(`ops:${t.id}`, d.clock.now());
    if (!b.ok) return void res.status(429).set('Retry-After', String(b.retryAfterS)).json({ error: 'rate_limited', retryAfterS: b.retryAfterS });
    res.locals.actor = `ops-token:${t.hashPrefix}`;
    next();
  };
  // The session's own checks; a token request passed its own above.
  const sessionOnly = (m: RequestHandler): RequestHandler => (req, res, next) => (res.locals.session ? m(req, res, next) : next());
  return [auth, sessionOnly(requireCsrf(d.cfg)), sessionOnly(writeLimiter(d.cfg, d.clock))];
}

// Before a route's own big body parser (the import's 1 MiB): a token request
// is refused unread (401, or 403 `scope`: no token opens such a route), and a
// session must be signed in. requireAuth runs after the body.
export function sessionBeforeBody(d: AuthDeps): RequestHandler {
  const session = requireSysadmin(d.sessions);
  return (req, res, next) => {
    const token = bearerOf(req);
    if (token === null) return session(req, res, next);
    const t = d.ops.verifyScoped(token);
    if (!t) return refuseToken(d.audit, res);
    refuseScope(d.audit, res, t, req.method, null);
  };
}
