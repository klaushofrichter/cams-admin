import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Config } from '../config';
import type { Clock } from '../clock';
import type { Audit } from '../audit';
import type { LiveHub } from '../live';
import { authUrl, exchangeCode, verifyIdToken } from './google';
import { SESSION_COOKIE, SESSION_MS, sysadminAllowed, type Sessions } from './session';
import { normaliseEmail } from '../validate';
import { Buckets } from '../channel/limits';
import { requireCsrf } from './middleware';
import { log } from '../log';

const STATE_COOKIE = 'cams_admin_oauth';
const STATE_MS = 10 * 60_000;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/plain.css"></head><body><main class="plain"><h1>${title}</h1>${body}</main></body></html>`;

export function authRoutes(d: { cfg: Config; sessions: Sessions; audit: Audit; clock: Clock; live: LiveHub | null }): express.Router {
  const r = express.Router();
  const secure = true; // __Host- needs Secure; browsers accept it on http://localhost too
  const signins = new Buckets({ capacity: d.cfg.limits.signinGlobal, windowMs: 15 * 60_000 });

  r.get('/auth/google/login', (_req, res) => {
    const nonce = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, nonce, { httpOnly: true, secure, sameSite: 'lax', maxAge: STATE_MS, path: '/' });
    res.redirect(302, authUrl(d.cfg, nonce));
  });

  r.get('/auth/google/callback', async (req, res) => {
    // In total: before sign-in there is no identity to key on (spec §7).
    const t = signins.take('global', d.clock.now());
    if (!t.ok) return void res.status(429).set('Retry-After', String(t.retryAfterS)).type('html').send(page('Too many sign-ins', '<p>Try again in a few minutes.</p>'));
    const cookie = req.cookies?.[STATE_COOKIE];
    const state = req.query.state;
    res.clearCookie(STATE_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    if (typeof cookie !== 'string' || typeof state !== 'string' || cookie.length !== state.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(state))) {
      return void res.status(400).type('html').send(page('Sign-in expired', '<p><a href="/auth/google/login">Sign in again</a></p>'));
    }
    if (typeof req.query.code !== 'string') return void res.status(400).type('html').send(page('Sign-in cancelled', '<p><a href="/auth/google/login">Sign in</a></p>'));
    let email: string;
    let verified: boolean;
    try {
      const claims = await verifyIdToken(d.cfg, await exchangeCode(d.cfg, req.query.code), Date.now()); // Google's exp is wall-clock time
      email = normaliseEmail(claims.email);
      verified = claims.emailVerified;
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'signin_failed');
      return void res.status(502).type('html').send(page('Sign-in failed', '<p><a href="/auth/google/login">Try again</a></p>'));
    }
    if (!verified || !sysadminAllowed(email)) {
      // The email may be anyone's: only a hash prefix is recorded.
      d.audit.write({ actorType: 'system', actor: 'system', action: 'signin-refused', outcome: 'refused', detail: { emailHash: createHash('sha256').update(email).digest('hex').slice(0, 12), verified } });
      return void res.status(403).type('html').send(page('Not allowed', '<p>This Google account is not a cams-admin system administrator.</p><p><a href="/auth/google/login">Use another account</a></p>'));
    }
    const s = d.sessions.create(email);
    d.audit.write({ actorType: 'sysadmin', actor: email, action: 'signin', outcome: 'ok' });
    res.cookie(SESSION_COOKIE, s.value, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_MS });
    res.redirect(302, '/');
  });

  // Logout really logs out: it lands on a 200 page with a sign-in link.
  r.post('/auth/logout', requireCsrf(d.cfg), (req, res) => {
    const value = req.cookies?.[SESSION_COOKIE];
    const s = d.sessions.get(value);
    d.sessions.destroy(value);
    if (s) {
      d.audit.write({ actorType: 'sysadmin', actor: s.email, action: 'signout', outcome: 'ok' });
      d.live?.endSession(s.idHash);
    }
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    res.status(200).type('html').send(page('Signed out', '<p><a href="/auth/google/login">Sign in</a></p>'));
  });
  return r;
}
