import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config';
import type { Clock } from '../clock';
import { SESSION_COOKIE, type Sessions } from './session';
import { Buckets } from '../channel/limits';

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
