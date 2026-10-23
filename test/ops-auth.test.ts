// Operations tokens on the API: a bearer `cao_…` token opens only the write
// routes of the scope table, for the scopes it holds; every other route
// answers 403 `scope`. A bad token is 401 (one throttled record). The bearer
// decides over a session cookie; a bearer write needs no CSRF header.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, request as httpRequest, type IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { once } from 'events';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { apiRouter } from '../server/api/router';
import { OPS_ROUTES, opsScopeFor } from '../server/ops/scopes';
import { OPS_SCOPES, type OpsScope } from '../server/ops/tokens';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

type M = 'get' | 'post' | 'put' | 'patch' | 'delete';
const bearer = (method: M, path: string, token: string, body?: unknown) => {
  const r = request(a.app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  return method === 'get' ? r : r.set('Content-Type', 'application/json').send(JSON.stringify(body ?? {}));
};
const issue = (scopes: OpsScope[], name = 'script') => {
  const { token, item } = a.ops.issue('admin@example.com', { name, scopes, days: 1 });
  return { token, prefix: item.hashPrefix, id: item.id };
};
const auditOf = (action: string) => a.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor: string; detail: string; outcome: string; target_id: string }[];
const auditCount = () => (a.db.prepare(`SELECT count(*) n FROM audit_log WHERE action <> 'ops-auth-refused'`).get() as { n: number }).n;

let acc: string, px: string, inst: string;
let n = 0;
// An active proxy token, as if the proxy had confirmed it.
const seedToken = () => {
  const id = `tok_OPS${String(n++).padStart(17, '0')}`;
  a.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,'client','manual','seeded',?,'active',1,1,'admin@example.com')`).run(id, acc, px, 'sha256:' + String(n).padStart(64, 'e'));
  return id;
};
// A move in copying, with proxies and a camera of its own.
const seedMove = () => {
  const i = n++;
  const s = `prx_os${i}`, t = `prx_ot${i}`, cam = `cam_o${i}`, mv = `mv_O${String(i).padStart(19, '0')}`;
  for (const id of [s, t]) a.db.prepare(`INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES (?,?,?,?,'cluster','enrolled',1,1)`).run(id, acc, id, id);
  a.db.prepare(`INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,'pc','M','camera',1,1)`).run(cam, acc, s, `m${i}`);
  a.db.prepare(`INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,'copying',1,1)`).run(mv, acc, cam, s, t, `rq_o${i}`);
  return mv;
};

beforeAll(() => {
  acc = a.registry.createAccount('admin@example.com', { name: 'home', displayName: 'Home' }).id;
  px = a.registry.createProxy('admin@example.com', acc, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' }).id;
  inst = a.camsInstances.create('admin@example.com', { name: 'cluster', displayName: 'Cluster', accounts: [acc] }).id;
});
// Room under the live-token cap for each test.
beforeEach(() => void a.db.prepare(`UPDATE ops_tokens SET revoked_at = 1, revoked_by = 'test' WHERE revoked_at IS NULL`).run());

describe('the scope table', () => {
  it('matches each :param as one non-empty segment', () => {
    expect(opsScopeFor('POST', '/moves/mv_1/cancel')).toBe('moves');
    expect(opsScopeFor('PUT', '/cams-instances/ci_1/routes/prx_1')).toBe('routes');
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens/apply')).toBe('tokens');
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens/tok_1/revoke')).toBe('tokens');
    expect(opsScopeFor('GET', '/moves/mv_1/cancel')).toBeNull();
    expect(opsScopeFor('PUT', '/cams-instances/ci_1/camera-overrides/cam_1')).toBeNull();
    expect(opsScopeFor('POST', '/moves//cancel')).toBeNull();
    expect(opsScopeFor('POST', '/moves/a/b/cancel')).toBeNull();
    expect(opsScopeFor('POST', '/moves/mv_1/cancel/x')).toBeNull();
    expect(opsScopeFor('POST', '/x/moves/mv_1/cancel')).toBeNull();
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens')).toBeNull();
  });

  it('coverage: every route of the router is in the table or refuses a token with every scope', async () => {
    const router = apiRouter({ ...a, serverKeyFingerprints: [a.signing.fingerprint] });
    const routes: { method: string; path: string }[] = [];
    for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path });
    }
    expect(routes.length).toBeGreaterThan(50);
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const o of OPS_ROUTES) expect(have.has(`${o.method} ${o.path}`), `${o.method} ${o.path}`).toBe(true);
    const inTable = new Set(OPS_ROUTES.map((o) => `${o.method} ${o.path}`));
    const { token } = issue([...OPS_SCOPES], 'all');
    const before = auditCount();
    for (const r of routes) {
      if (inTable.has(`${r.method} ${r.path}`)) continue;
      const res = await bearer(r.method.toLowerCase() as M, r.path.replace(/:[A-Za-z]+/g, 'x1'), token);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body, `${r.method} ${r.path}`).toEqual({ error: 'scope' });
    }
    expect(auditCount()).toBe(before);
  });
});

describe('scoped writes', () => {
  it('a tokens token revokes a proxy token; the audit actor is the token', async () => {
    const t = issue(['tokens']);
    const tok = seedToken();
    const r = await bearer('post', `/accounts/${acc}/proxies/${px}/tokens/${tok}/revoke`, t.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((a.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(tok) as { state: string }).state).toBe('revoked');
    const rec = auditOf('token-revoke').find((x) => JSON.parse(x.detail).tokenId === tok)!;
    expect(rec.actor).toBe(`ops-token:${t.prefix}`);
    expect(rec.actor).toMatch(/^ops-token:[0-9a-f]{8}$/);
  });

  it('a tokens token may not set a route; a routes token sets and deletes one', async () => {
    const path = `/cams-instances/${inst}/routes/${px}`;
    const t = issue(['tokens']);
    const no = await bearer('put', path, t.token, { url: null, hidden: false });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'scope' });
    expect(a.camsInstances.routes(inst)).toHaveLength(0);
    const r = issue(['routes']);
    expect((await bearer('put', path, r.token, { url: null, hidden: false })).status).toBe(200);
    expect(a.camsInstances.routes(inst)).toHaveLength(1);
    expect((await bearer('delete', path, r.token)).status).toBe(204);
    expect(a.camsInstances.routes(inst)).toHaveLength(0);
    expect(auditOf('route-update').slice(-2).map((x) => x.actor)).toEqual([`ops-token:${r.prefix}`, `ops-token:${r.prefix}`]);
  });

  it('a moves token cancels a move', async () => {
    const t = issue(['moves']);
    const mv = seedMove();
    const r = await bearer('post', `/moves/${mv}/cancel`, t.token, { copied: 'delete', confirm: 'cancel' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ id: mv, phase: 'cancelling' });
  });

  it('a bearer write needs no X-Cams-Admin header; a session write without it is still 403 csrf', async () => {
    const t = issue(['moves']);
    const r = await request(a.app).post(`/api/v1/moves/${seedMove()}/cancel`).set('Authorization', `Bearer ${t.token}`).set('Content-Type', 'application/json').send('{"copied":"delete","confirm":"cancel"}');
    expect(r.status).toBe(202);
    const s = await request(a.app).post(`/api/v1/moves/${seedMove()}/cancel`).set('Cookie', a.cookie).set('Content-Type', 'application/json').send('{"copied":"delete","confirm":"cancel"}');
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: 'csrf' });
  });

  it('60 writes a minute per token: the 61st is 429', async () => {
    const t = issue(['moves']);
    for (let i = 0; i < 60; i++) expect((await bearer('post', '/moves/mv_NOPE/cancel', t.token, { confirm: 'cancel' })).status).toBe(404);
    const r = await bearer('post', '/moves/mv_NOPE/cancel', t.token, { confirm: 'cancel' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited' });
    // Another token has its own budget.
    expect((await bearer('post', '/moves/mv_NOPE/cancel', issue(['moves']).token, { confirm: 'cancel' })).status).toBe(404);
  });
});

describe('review focus', () => {
  it('1: a token on a session-only write route is 403 scope, nothing written', async () => {
    const t = issue([...OPS_SCOPES]);
    const before = auditCount();
    const live = () => (a.db.prepare('SELECT count(*) n FROM ops_tokens WHERE revoked_at IS NULL').get() as { n: number }).n;
    const tokensBefore = live();
    for (const [path, body] of [['/diag-tokens', { name: 'x' }], [`/accounts/${acc}/proxies/${px}/tokens`, { kind: 'client', label: 'x' }], ['/ops-tokens', { name: 'x', scopes: ['moves'] }]] as const) {
      const r = await bearer('post', path, t.token, body);
      expect(r.status, path).toBe(403);
      expect(r.body, path).toEqual({ error: 'scope' });
    }
    expect(auditCount()).toBe(before);
    expect(live()).toBe(tokensBefore);
    expect((a.db.prepare(`SELECT count(*) n FROM proxy_tokens WHERE label = 'x'`).get() as { n: number }).n).toBe(0);
  });

  it('2: a routes token on a tokens route is 403 scope', async () => {
    const t = issue(['routes']);
    const tok = seedToken();
    const r = await bearer('post', `/accounts/${acc}/proxies/${px}/tokens/${tok}/revoke`, t.token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'scope' });
    expect((a.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(tok) as { state: string }).state).toBe('active');
  });

  it('3: an expired, revoked or diag token on a write is 401; an ops token on the diag API is 401', async () => {
    const path = `/moves/${seedMove()}/cancel`;
    const body = { copied: 'delete', confirm: 'cancel' };
    const e = issue(['moves'], 'expired');
    a.db.prepare('UPDATE ops_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.id);
    const rv = issue(['moves'], 'revoked');
    a.ops.revoke('admin@example.com', rv.id);
    const diag = a.diag.issue('admin@example.com', { name: 'reader', days: 1 }).token;
    const before = auditOf('ops-auth-refused').length;
    for (const tok of [e.token, rv.token, diag, 'cao_' + 'x'.repeat(43), 'nope']) {
      const r = await bearer('post', path, tok, body);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthorized' });
    }
    // A Bearer header without a token is a token attempt too.
    expect((await request(a.app).post(`/api/v1${path}`).set('Authorization', 'Bearer').set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(401);
    // Throttled: one record for the burst, never keyed on the client address.
    const refused = auditOf('ops-auth-refused');
    expect(refused.length).toBe(before + 1);
    expect(refused.at(-1)!.outcome).toBe('refused');
    expect(JSON.stringify(refused)).not.toContain('cao_');
    expect((a.db.prepare('SELECT phase FROM moves WHERE id = ?').get(path.split('/')[2]) as { phase: string }).phase).toBe('copying');
    // The diag API takes only diag tokens.
    const ok = issue(['moves']);
    expect((await bearer('get', '/diag/proxies', ok.token)).status).toBe(401);
  });

  it('4: with a session cookie as well, the bearer decides', async () => {
    const path = `/moves/${seedMove()}/cancel`;
    const body = JSON.stringify({ copied: 'delete', confirm: 'cancel' });
    const e = issue(['moves'], 'expired');
    a.db.prepare('UPDATE ops_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.id);
    const withBoth = (tok: string, p = path, m: M = 'post') => request(a.app)[m](`/api/v1${p}`).set('Cookie', a.cookie).set('X-Cams-Admin', '1').set('Authorization', `Bearer ${tok}`).set('Content-Type', 'application/json').send(body);
    expect((await withBoth(e.token)).status).toBe(401);
    // A live token without the scope: the session doesn't stand in.
    const r = issue(['routes']);
    expect((await withBoth(r.token)).status).toBe(403);
    expect((await withBoth(r.token, '/diag-tokens')).status).toBe(403);
    // A GET with both: refused (tokens read nothing here).
    const g = await request(a.app).get('/api/v1/me').set('Cookie', a.cookie).set('Authorization', `Bearer ${r.token}`);
    expect(g.status).toBe(403);
    expect(g.body).toEqual({ error: 'scope' });
    // In scope: the token is the actor, not the session's e-mail.
    const m = issue(['moves']);
    expect((await withBoth(m.token)).status).toBe(202);
    expect(auditOf('move-cancel').at(-1)!.actor).toBe(`ops-token:${m.prefix}`);
  });

  it('the import route refuses a token before it reads the big body', async () => {
    const t = issue([...OPS_SCOPES]);
    // A body announced at 900 KiB (under the import's 1 MiB), of which 1 KiB is sent: a parser
    // would wait for the rest, so an answer now means the body was never read.
    const srv = createServer(a.app).listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as AddressInfo).port;
    try {
      for (const cookie of [false, true]) {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/v1/accounts/${acc}/import`, headers: {
          Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', 'Content-Length': String(900 * 1024),
          ...(cookie ? { Cookie: a.cookie, 'X-Cams-Admin': '1' } : {}),
        } });
        req.on('error', () => {});
        req.write('{"instanceId":"' + 'x'.repeat(1024));
        const [res] = (await Promise.race([once(req, 'response'), new Promise((_r, rej) => setTimeout(() => rej(new Error('the body was waited for')), 2000))])) as [IncomingMessage];
        let text = '';
        for await (const c of res) text += c;
        req.destroy();
        expect(res.statusCode, `cookie ${cookie}`).toBe(403);
        expect(JSON.parse(text)).toEqual({ error: 'scope' });
      }
    } finally {
      srv.close();
    }
    expect(auditOf('import-run')).toHaveLength(0);
  });
});

describe('managing ops tokens', () => {
  it('a session issues (shown once, no-store), lists and revokes; a token is 403 scope', async () => {
    const r = await a.api('post', '/ops-tokens', { name: 'mac', scopes: ['routes', 'moves'], days: 7 });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ token: expect.stringMatching(/^cao_[A-Za-z0-9_-]{43}$/), item: expect.objectContaining({ name: 'mac', scopes: ['routes', 'moves'], state: 'active' }), shownOnce: true });
    const { token, item } = r.body;
    const list = await a.api('get', '/ops-tokens');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.items.find((x: { id: string }) => x.id === item.id)).toMatchObject({ name: 'mac', state: 'active' });
    expect((await a.api('post', '/ops-tokens', { name: 'bad', scopes: ['registry'] })).body).toEqual({ error: 'invalid', field: 'scopes' });
    // The token can't manage tokens, not even itself.
    expect((await bearer('get', '/ops-tokens', token)).status).toBe(403);
    expect((await bearer('post', '/ops-tokens', token, { name: 'x', scopes: ['moves'] })).status).toBe(403);
    expect((await bearer('post', `/ops-tokens/${item.id}/revoke`, token)).status).toBe(403);
    const rv = await a.api('post', `/ops-tokens/${item.id}/revoke`);
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ id: item.id, state: 'revoked', revokedBy: 'admin@example.com' });
    expect((await bearer('post', `/moves/${seedMove()}/cancel`, token, { copied: 'delete', confirm: 'cancel' })).status).toBe(401);
    expect((await a.api('post', '/ops-tokens/opt_NOPE/revoke')).status).toBe(404);
  });

  it('/me still works with a session', async () => {
    expect((await a.api('get', '/me')).body).toMatchObject({ email: 'admin@example.com' });
  });
});
