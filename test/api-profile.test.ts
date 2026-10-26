// The proxy profile on the API (proxy profile design §3): the session route
// GET /proxies/:proxyId/profile, the diagnostics token's /diag/proxies (and its
// per-proxy route), and the dashboard's "profile not set" list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProfile, makeProxyInfo, makeSummary } from '../test-client/summaries';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());
const ACTOR = 'admin@example.com';

let acc: string, een: string, pi: string, old: string;
const hb = (id: string, profile?: unknown) => a.status.heartbeat(id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: makeProxyInfo({ now: Date.now() }), truncated: false, ...(profile === undefined ? {} : { profile }) }, Date.now());
beforeAll(() => {
  acc = a.registry.createAccount(ACTOR, { name: 'home', displayName: 'Home' }).id;
  een = a.registry.createProxy(ACTOR, acc, { name: 'een', displayName: 'een', runsOn: 'local-host', url: 'https://192.0.2.5:8443' }).id;
  pi = a.registry.createProxy(ACTOR, acc, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://192.0.2.6:8443', adminUiUrl: 'http://192.0.2.6:8480/' }).id;
  old = a.registry.createProxy(ACTOR, acc, { name: 'old', displayName: 'Old', runsOn: 'local-host' }).id;
  for (const id of [een, pi, old]) {
    a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(id);
    a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, ?, 1, 1)`).run(`key_${id}`, id, `pk${id}`, `fp${id}`);
    a.status.hello(id, 'v2026.10.26.1', Date.now(), ['status']);
  }
  hb(een, makeProfile());
  hb(pi, makeProfile({ set: false, name: null, cameras: 1, held: 1, storageGB: null }));
  hb(old);
});

describe('GET /proxies/:proxyId/profile', () => {
  it('a signed-in sysadmin reads the latest reported profile', async () => {
    const r = await a.api('get', `/proxies/${een}/profile`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      proxyId: een, accountId: acc, name: 'een', displayName: 'een', state: 'online', version: 'v2026.10.06.1', reportedAt: expect.any(Number),
      profile: { ...makeProfile(), firewall: { ...makeProfile().firewall, dropped: 0 }, tls: null }, unreadable: false, homeUrl: 'https://192.0.2.5:8443',
    });
    expect((await a.api('get', `/proxies/${pi}/profile`)).body).toMatchObject({ profile: { set: false }, homeUrl: 'http://192.0.2.6:8480/' });
  });
  it('an older proxy: profile null; an unknown proxy 404; no session 401; no token opens it', async () => {
    expect((await a.api('get', `/proxies/${old}/profile`)).body).toMatchObject({ profile: null, unreadable: false, homeUrl: null });
    expect((await a.api('get', '/proxies/prx_00000000000000000000/profile')).status).toBe(404);
    expect((await request(a.app).get(`/api/v1/proxies/${een}/profile`)).status).toBe(401);
    const diag = (await a.api('post', '/diag-tokens', { name: 'profile', days: 1 })).body.token as string;
    expect((await request(a.app).get(`/api/v1/proxies/${een}/profile`).set('Authorization', `Bearer ${diag}`)).status).toBe(401);
  });
});

describe('diagnostics', () => {
  it('/diag/proxies carries the profile; /diag/proxies/:proxyId/profile is the session answer', async () => {
    const token = (await a.api('post', '/diag-tokens', { name: 'profile2', days: 1 })).body.token as string;
    const bearer = (path: string) => request(a.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const items = (await bearer('/diag/proxies')).body.items as { id: string; reported: { profile: unknown; profileUnreadable: boolean } | null }[];
    expect(items.find((x) => x.id === een)!.reported).toMatchObject({ profile: { ...makeProfile(), firewall: { ...makeProfile().firewall, dropped: 0 } }, profileUnreadable: false });
    expect(items.find((x) => x.id === old)!.reported).toMatchObject({ profile: null });
    const one = await bearer(`/diag/proxies/${een}/profile`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual((await a.api('get', `/proxies/${een}/profile`)).body);
    expect((await bearer('/diag/proxies/prx_00000000000000000000/profile')).status).toBe(404);
    expect((await bearer('/diag')).body.routes).toContain('/diag/proxies/:proxyId/profile');
  });
});

describe('the dashboard', () => {
  it('each proxy carries whether its profile is set and its home page URL', async () => {
    const d = (await a.api('get', '/dashboard')).body;
    const px = d.accounts.find((x: { id: string }) => x.id === acc).proxies as { id: string; profile: unknown; homeUrl: string | null }[];
    expect(px.find((p) => p.id === een)).toMatchObject({ profile: { set: true, held: 1, cameras: 3 }, homeUrl: 'https://192.0.2.5:8443' });
    expect(px.find((p) => p.id === pi)).toMatchObject({ profile: { set: false, held: 1, cameras: 1 }, homeUrl: 'http://192.0.2.6:8480/' });
    expect(px.find((p) => p.id === old)).toMatchObject({ profile: null, homeUrl: null });
  });
});
