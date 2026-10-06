import express from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { Config } from '../config';
import type { Clock } from '../clock';
import type { Audit } from '../audit';
import type { LiveHub } from '../live';
import { authUrl, exchangeCode, verifyIdToken } from './google';
import { SESSION_COOKIE, SESSION_MS, sysadminAllowed, type Sessions } from './session';
import { normaliseEmail } from '../validate';
import { limiter } from '../rateLimit';
import { requireCsrf } from './middleware';
import { log } from '../log';
import { sha256Hex } from '../ids';

const STATE_COOKIE = 'cams_admin_oauth';
const STATE_MS = 10 * 60_000;

// __Host- needs Secure; browsers accept it on http://localhost too.
const COOKIE = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/plain.css"></head><body><main class="plain"><h1>${title}</h1>${body}</main></body></html>`;
const SIGNED_OUT = page('Signed out', '<p><a href="/auth/google/login">Sign in</a></p>');

export function authRoutes(d: { cfg: Config; sessions: Sessions; audit: Audit; clock: Clock; live: LiveHub | null }): express.Router {
  const r = express.Router();
  // Completed callbacks that failed, in total (before sign-in there is no
  // identity to key on, spec §7). Counted only after the state check and
  // never on success, so junk requests can't lock anyone out.
  const signinLimit = limiter({
    windowMs: 15 * 60_000, limit: d.cfg.limits.signinGlobal, key: () => 'signin', skipSuccessfulRequests: true,
    handler: (_req, res) => void res.status(429).type('html').send(page('Too many sign-ins', '<p>Try again in a few minutes.</p>')),
  });
  const loginLimit = limiter({ windowMs: 15 * 60_000, limit: d.cfg.limits.signinGlobal * 4, key: () => 'login' });

  // The cookie carries state, PKCE verifier and OIDC nonce: random, base64url.
  r.get('/auth/google/login', loginLimit, (_req, res) => {
    const [state, verifier, nonce] = [16, 32, 16].map((n) => randomBytes(n).toString('base64url'));
    res.cookie(STATE_COOKIE, `${state}.${verifier}.${nonce}`, { ...COOKIE, maxAge: STATE_MS });
    res.redirect(302, authUrl(d.cfg, state, verifier, nonce));
  });

  const checkState: express.RequestHandler = (req, res, next) => {
    const cookie = req.cookies?.[STATE_COOKIE];
    const state = req.query.state;
    res.clearCookie(STATE_COOKIE, COOKIE);
    const parts = typeof cookie === 'string' ? cookie.split('.') : [];
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]{16,64}$/.test(p)) || typeof state !== 'string' || parts[0].length !== state.length || !timingSafeEqual(Buffer.from(parts[0]), Buffer.from(state))) {
      return void res.status(400).type('html').send(page('Sign-in expired', '<p><a href="/auth/google/login">Sign in again</a></p>'));
    }
    res.locals.oauth = { verifier: parts[1], nonce: parts[2] };
    next();
  };

  r.get(d.cfg.google.callbackPath, checkState, signinLimit, async (req, res) => {
    if (typeof req.query.code !== 'string') return void res.status(400).type('html').send(page('Sign-in cancelled', '<p><a href="/auth/google/login">Sign in</a></p>'));
    let email: string;
    let verified: boolean;
    try {
      const { verifier, nonce } = res.locals.oauth as { verifier: string; nonce: string };
      const claims = await verifyIdToken(d.cfg, await exchangeCode(d.cfg, req.query.code, verifier), Date.now(), nonce); // Google's exp is wall-clock time
      email = normaliseEmail(claims.email);
      verified = claims.emailVerified;
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'signin_failed');
      return void res.status(502).type('html').send(page('Sign-in failed', '<p><a href="/auth/google/login">Try again</a></p>'));
    }
    if (!verified || !sysadminAllowed(email)) {
      // The email may be anyone's: only a hash prefix is recorded.
      d.audit.write({ actorType: 'system', actor: 'system', action: 'signin-refused', outcome: 'refused', detail: { emailHash: sha256Hex(email).slice(0, 12), verified } });
      return void res.status(403).type('html').send(page('Not allowed', '<p>This Google account is not a cams-admin system administrator.</p><p><a href="/auth/google/login">Use another account</a></p>'));
    }
    const s = d.sessions.create(email);
    d.audit.write({ actorType: 'sysadmin', actor: email, action: 'signin', outcome: 'ok' });
    res.cookie(SESSION_COOKIE, s.value, { ...COOKIE, maxAge: SESSION_MS });
    res.redirect(302, '/');
  });

  r.get('/auth/signed-out', (_req, res) => void res.status(200).type('html').send(SIGNED_OUT));

  // Logout really logs out: it lands on a 200 page with a sign-in link.
  r.post('/auth/logout', requireCsrf(d.cfg), (req, res) => {
    const value = req.cookies?.[SESSION_COOKIE];
    const s = d.sessions.get(value);
    d.sessions.destroy(value);
    if (s) {
      d.audit.write({ actorType: 'sysadmin', actor: s.email, action: 'signout', outcome: 'ok' });
      d.live?.endSession(s.idHash);
    }
    res.clearCookie(SESSION_COOKIE, COOKIE);
    res.status(200).type('html').send(SIGNED_OUT);
  });
  return r;
}
