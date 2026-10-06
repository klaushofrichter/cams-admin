import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { openDb } from '../server/db/open';
import { Audit } from '../server/audit';
import { loadConfig } from '../server/config';
import { Sessions, SESSION_COOKIE } from '../server/auth/session';
import { authRoutes } from '../server/auth/routes';
import { requireCsrf, requireSysadmin, securityHeaders, writeLimiter } from '../server/auth/middleware';
import { fakeClock } from './helpers/clock';
import { tmpDir } from './helpers/tmp';
import { fakeGoogleEnv, startFakeGoogle, type FakeGoogle } from './fakeGoogle';

let g: FakeGoogle;
beforeAll(async () => { g = await startFakeGoogle(); });
afterAll(async () => { await g.close(); });

let n = 0;
function setup(dir: string, env: Record<string, string> = {}) {
  process.env.SYSADMIN_EMAILS = 'Admin@Example.com, other@example.com';
  const db = openDb(join(dir, `a${n++}.db`));
  const clock = fakeClock(Date.now());
  const audit = new Audit(db, clock);
  const cfg = loadConfig({ PUBLIC_URL: 'https://cams-admin.example.net', ...fakeGoogleEnv(g), ...env });
  const sessions = new Sessions(db, clock);
  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeaders(cfg));
  app.use(cookieParser());
  app.use(authRoutes({ cfg, sessions, audit, clock, live: null }));
  const api = express.Router();
  api.use(requireSysadmin(sessions), requireCsrf(cfg), writeLimiter(cfg, clock));
  api.get('/me', (req, res) => res.json({ email: res.locals.session.email }));
  api.post('/thing', (_req, res) => res.json({ ok: true }));
  app.use('/api/v1', api);
  return { db, clock, audit, cfg, sessions, app };
}

// Follows the sign-in through the fake Google and back.
async function signIn(app: express.Express, xff?: string) {
  const login = await request(app).get('/auth/google/login');
  expect(login.status).toBe(302);
  const stateCookie = login.headers['set-cookie'][0].split(';')[0];
  const r = await fetch(login.headers.location, { redirect: 'manual' });
  const back = new URL(r.headers.get('location')!);
  const cb = request(app).get(`/auth/google/callback${back.search}`).set('Cookie', stateCookie);
  if (xff) cb.set('X-Forwarded-For', xff);
  return cb;
}
const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(SESSION_COOKIE))!;

describe('sign-in', () => {
  const dir = tmpDir();

  it('an allowlisted email gets a __Host- session cookie and is audited', async () => {
    const s = setup(dir);
    g.setEmail('admin@example.com');
    const r = await signIn(s.app);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const c = cookieOf(r);
    expect(c).toMatch(/^__Host-cams_admin=/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Max-Age=43200/);
    expect(c).not.toMatch(/Domain/);
    const me = await request(s.app).get('/api/v1/me').set('Cookie', c.split(';')[0]);
    expect(me.body).toEqual({ email: 'admin@example.com' });
    expect(s.audit.list({ action: 'signin' }).items[0]).toMatchObject({ actor: 'admin@example.com', outcome: 'ok' });
  });

  it('a stranger is refused with 403; the audit record carries only a hash prefix', async () => {
    const s = setup(dir);
    g.setEmail('stranger@example.org');
    const r = await signIn(s.app);
    expect(r.status).toBe(403);
    expect((r.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) => c.startsWith(SESSION_COOKIE + '=') && !c.includes('Expires=Thu, 01 Jan 1970'))).toBeFalsy();
    const a = s.audit.list({ action: 'signin-refused' }).items[0];
    expect(a.detail.emailHash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(a)).not.toContain('stranger');
  });

  it('refuses an unverified email and a state mismatch', async () => {
    const s = setup(dir);
    g.setEmail('admin@example.com', false);
    expect((await signIn(s.app)).status).toBe(403);
    g.setEmail('admin@example.com');
    const login = await request(s.app).get('/auth/google/login');
    const r = await fetch(login.headers.location, { redirect: 'manual' });
    const back = new URL(r.headers.get('location')!);
    const cb = await request(s.app).get(`/auth/google/callback${back.search}`).set('Cookie', 'cams_admin_oauth=' + 'f'.repeat(32));
    expect(cb.status).toBe(400);
  });

  it('limits sign-in callbacks in total, whatever X-Forwarded-For says', async () => {
    const s = setup(dir, { LIMIT_SIGNIN_GLOBAL: '3' });
    g.setEmail('admin@example.com');
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await signIn(s.app, `198.51.100.${i}`)).status);
    expect(codes).toEqual([302, 302, 302, 429]);
  });

  it('a session ends after 12 hours, on removal from the allowlist, and on logout', async () => {
    const s = setup(dir);
    g.setEmail('other@example.com');
    const c = cookieOf(await signIn(s.app)).split(';')[0];
    s.clock.advance(12 * 3600_000 - 1);
    expect((await request(s.app).get('/api/v1/me').set('Cookie', c)).status).toBe(200);
    s.clock.advance(1);
    expect((await request(s.app).get('/api/v1/me').set('Cookie', c)).status).toBe(401);
    const c2 = cookieOf(await signIn(s.app)).split(';')[0];
    process.env.SYSADMIN_EMAILS = 'admin@example.com';
    expect((await request(s.app).get('/api/v1/me').set('Cookie', c2)).status).toBe(401);
    process.env.SYSADMIN_EMAILS = 'admin@example.com,other@example.com';
    const c3 = cookieOf(await signIn(s.app)).split(';')[0];
    const out = await request(s.app).post('/auth/logout').set('Cookie', c3).set('X-Cams-Admin', '1').set('Content-Type', 'application/json').send('{}');
    expect(out.status).toBe(200);
    expect(out.text).toContain('href="/auth/google/login"');
    expect((await request(s.app).get('/api/v1/me').set('Cookie', c3)).status).toBe(401);
    expect(s.audit.list({ action: 'signout' }).items).toHaveLength(1);
  });

  it('writes need JSON, X-Cams-Admin and a same-origin Origin', async () => {
    const s = setup(dir);
    g.setEmail('admin@example.com');
    const c = cookieOf(await signIn(s.app)).split(';')[0];
    const post = () => request(s.app).post('/api/v1/thing').set('Cookie', c);
    expect((await post().set('Content-Type', 'application/json').send('{}')).status).toBe(403);
    expect((await post().set('X-Cams-Admin', '1').type('form').send('a=1')).status).toBe(403);
    expect((await post().set('X-Cams-Admin', '1').set('Origin', 'https://evil.example').set('Content-Type', 'application/json').send('{}')).status).toBe(403);
    expect((await post().set('X-Cams-Admin', '1').set('Origin', 'https://cams-admin.example.net').set('Content-Type', 'application/json').send('{}')).status).toBe(200);
  });

  it('limits writes per session, not per address', async () => {
    const s = setup(dir, { LIMIT_WRITES_PER_SESSION: '3' });
    g.setEmail('admin@example.com');
    const a = cookieOf(await signIn(s.app)).split(';')[0];
    const b = cookieOf(await signIn(s.app)).split(';')[0];
    const w = (c: string, ip: string) => request(s.app).post('/api/v1/thing').set('Cookie', c).set('X-Cams-Admin', '1').set('X-Forwarded-For', ip).set('Content-Type', 'application/json').send('{}');
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await w(a, `198.51.100.${i}`)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await w(b, '198.51.100.0')).status).toBe(200);
  });

  it('sends the security headers', async () => {
    const s = setup(dir);
    const r = await request(s.app).get('/api/v1/me');
    expect(r.status).toBe(401);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('dev-session', () => {
  const dir = tmpDir();
  const run = (env: Record<string, string>, email: string) => {
    try {
      return { ok: true, out: execFileSync('npx', ['tsx', 'scripts/dev-session.ts', email], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { ok: false, out: String((e as { stderr?: string }).stderr) };
    }
  };
  it('refuses outside development, a non-loopback URL and a stranger; prints a cookie value otherwise', () => {
    const db = join(dir, 'dev.db');
    const base = { DB_FILE: db, SYSADMIN_EMAILS: 'dev@example.com', PUBLIC_URL: 'http://127.0.0.1:29000', NODE_ENV: 'development' };
    expect(run({ ...base, NODE_ENV: 'production' }, 'dev@example.com').ok).toBe(false);
    expect(run({ ...base, PUBLIC_URL: 'https://cams-admin.example.net' }, 'dev@example.com').ok).toBe(false);
    expect(run(base, 'stranger@example.com').ok).toBe(false);
    const r = run(base, 'dev@example.com');
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 30_000);
});
