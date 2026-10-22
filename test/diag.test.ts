// The read-only diagnostics API and its token (issue #45): issued once and
// stored as a hash, GET only, never on the other API routes, revocable (and
// revoked again after a restore), and no secret in any answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { buildServer } from '../server/server';
import { writeSigningKey } from './helpers/signingKey';
import { MAX_LIVE } from '../server/diag/tokens';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

const bearer = (path: string, token: string, method: 'get' | 'post' | 'put' | 'delete' = 'get') => request(a.app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
const issue = async (name: string, days?: number) => {
  const r = await a.api('post', '/diag-tokens', { name, ...(days === undefined ? {} : { days }) });
  expect(r.status).toBe(201);
  return r.body as { token: string; item: { id: string; hashPrefix: string; state: string; expiresAt: number; createdAt: number } };
};
const auditOf = (action: string) => a.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { detail: string; outcome: string; target_id: string }[];
const ROUTES = ['/diag', '/diag/proxies', '/diag/cams-instances', '/diag/cameras', '/diag/moves', '/diag/audit'];

let acc: string, px: string, px2: string;
beforeAll(() => {
  acc = a.registry.createAccount('admin@example.com', { name: 'home', displayName: 'Home' }).id;
  px = a.registry.createProxy('admin@example.com', acc, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://192.0.2.5:8443', tlsSite: 'home', tlsServername: 'proxy.home.internal' }).id;
  px2 = a.registry.createProxy('admin@example.com', acc, { name: 'pc', displayName: 'PC', runsOn: 'local-host' }).id;
  a.registry.createCamera('admin@example.com', acc, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: px, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
});

describe('diagnostics tokens', () => {
  it('a token is shown once: the list and the audit carry only an 8-hex prefix of its hash', async () => {
    const { token, item } = await issue('mac');
    expect(token).toMatch(/^cad_[A-Za-z0-9_-]{43}$/);
    expect(item).toMatchObject({ name: 'mac', state: 'active', hashPrefix: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(item.expiresAt - item.createdAt).toBe(90 * 86400_000);
    const list = await a.api('get', '/diag-tokens');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.items.find((t: { id: string }) => t.id === item.id)).toMatchObject({ name: 'mac', state: 'active' });
    const rec = auditOf('diag-token-issue').find((r) => r.target_id === item.id)!;
    expect(rec.outcome).toBe('ok');
    expect(rec.detail).not.toContain(token);
    expect(JSON.parse(rec.detail)).toEqual({ hashPrefix: item.hashPrefix, days: 90 });
  });

  it('name and days are checked; at most MAX_LIVE live tokens', async () => {
    expect((await a.api('post', '/diag-tokens', { name: '' })).body).toEqual({ error: 'invalid', field: 'name' });
    expect((await a.api('post', '/diag-tokens', { name: 'x', days: 0 })).body).toEqual({ error: 'invalid', field: 'days' });
    expect((await a.api('post', '/diag-tokens', { name: 'x', days: 366 })).body).toEqual({ error: 'invalid', field: 'days' });
    expect((await a.api('post', '/diag-tokens', { name: 'x', days: 1.5 })).body).toEqual({ error: 'invalid', field: 'days' });
    const live = () => (a.db.prepare('SELECT count(*) n FROM diag_tokens WHERE revoked_at IS NULL').get() as { n: number }).n;
    while (live() < MAX_LIVE) await issue(`fill${live()}`, 1);
    const r = await a.api('post', '/diag-tokens', { name: 'one-too-many' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'too_many_tokens' });
    // Revoked ones don't count.
    for (const t of (await a.api('get', '/diag-tokens')).body.items) if (t.name.startsWith('fill')) await a.api('post', `/diag-tokens/${t.id}/revoke`);
    await issue('after-revoke', 1);
  });

  it('a bearer token opens every diag route; without one, or with a bad one, 401', async () => {
    const { token } = await issue('reader', 1);
    for (const r of ROUTES) {
      const res = await bearer(r, token);
      expect(res.status, r).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await request(a.app).get('/api/v1/diag/proxies')).status).toBe(401);
    const before = auditOf('diag-auth-refused').length;
    expect((await bearer('/diag/proxies', 'cad_' + 'x'.repeat(43))).status).toBe(401);
    expect((await bearer('/diag/proxies', 'not-a-diag-token')).status).toBe(401);
    expect((await request(a.app).get('/api/v1/diag/proxies').set('Authorization', 'Basic abc')).status).toBe(401);
    // Throttled: one record for the burst.
    expect(auditOf('diag-auth-refused').length).toBe(before + 1);
  });

  it('a signed-in sysadmin reads the diag routes with the session', async () => {
    expect((await a.api('get', '/diag/cams-instances')).status).toBe(200);
  });

  it('the token never opens the other API routes, and nothing but GET', async () => {
    const { token } = await issue('scoped', 1);
    for (const path of ['/dashboard', '/audit', '/moves', `/accounts/${acc}/proxies`, '/diag-tokens', '/me']) expect((await bearer(path, token)).status, path).toBe(401);
    expect((await bearer('/diag-tokens', token, 'post').set('X-Cams-Admin', '1').set('Content-Type', 'application/json').send('{"name":"x"}')).status).toBe(401);
    for (const m of ['post', 'put', 'delete'] as const) {
      const r = await bearer('/diag/proxies', token, m);
      expect(r.status, m).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
    expect((await bearer('/diag/nothing-here', token)).status).toBe(404);
  });

  it('a revoked or expired token is refused', async () => {
    const { token, item } = await issue('short', 1);
    expect((await bearer('/diag', token)).status).toBe(200);
    const rv = await a.api('post', `/diag-tokens/${item.id}/revoke`);
    expect(rv.body).toMatchObject({ id: item.id, state: 'revoked', revokedBy: 'admin@example.com' });
    expect((await bearer('/diag', token)).status).toBe(401);
    expect(auditOf('diag-token-revoke').some((r) => r.target_id === item.id)).toBe(true);
    expect((await a.api('post', '/diag-tokens/dgt_NOPE/revoke')).status).toBe(404);
    const e = await issue('expiring', 1);
    a.db.prepare('UPDATE diag_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.item.id);
    expect((await bearer('/diag', e.token)).status).toBe(401);
    expect((await a.api('get', '/diag-tokens')).body.items.find((t: { id: string }) => t.id === e.item.id).state).toBe('expired');
  });

  it('the last use is shown (memory only)', async () => {
    const { token, item } = await issue('used', 1);
    expect((await a.api('get', '/diag-tokens')).body.items.find((t: { id: string }) => t.id === item.id).lastUsedAt).toBeNull();
    await bearer('/diag', token);
    expect((await a.api('get', '/diag-tokens')).body.items.find((t: { id: string }) => t.id === item.id).lastUsedAt).toEqual(expect.any(Number));
  });
});

describe('diagnostics answers', () => {
  // The first block left live tokens behind: room for these.
  beforeAll(() => void a.db.prepare(`UPDATE diag_tokens SET revoked_at = 1, revoked_by = 'test' WHERE revoked_at IS NULL`).run());
  it('proxies, cameras and cams instances carry the registry fields', async () => {
    const i = a.camsInstances.create('admin@example.com', { name: 'cluster', displayName: 'Cluster', accounts: [acc] });
    a.camsInstances.setRoute('admin@example.com', i.id, px, { url: null, hidden: false });
    const { token } = await issue('fields', 1);
    const p = (await bearer('/diag/proxies', token)).body.items.find((x: { id: string }) => x.id === px);
    expect(p).toMatchObject({ name: 'pi', url: 'https://192.0.2.5:8443', tlsSite: 'home', tlsServername: 'proxy.home.internal', state: 'pending', problems: [], reported: null });
    const c = (await bearer('/diag/cameras', token)).body.items.find((x: { camsId: string }) => x.camsId === 'porch');
    expect(c).toMatchObject({ proxyId: px, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https', moveId: null, online: null });
    const ci = (await bearer('/diag/cams-instances', token)).body.items.find((x: { id: string }) => x.id === i.id);
    expect(ci).toMatchObject({ name: 'cluster', accounts: [acc], routes: [{ proxyId: px, accountId: acc, url: null, hidden: false }], report: null });
  });

  it('the move precheck names every rule: an offline target, and the instance that sees only the source', async () => {
    const { token } = await issue('precheck', 1);
    const r = await bearer(`/diag/moves/precheck?source=${px}&target=${px2}&camera=porch`, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, reason: 'target_offline', cameraId: expect.stringMatching(/^cam_/) });
    const rule = (k: string) => r.body.rules.find((x: { rule: string }) => x.rule === k);
    expect(rule('same_account')).toMatchObject({ ok: true });
    expect(rule('target_online')).toMatchObject({ ok: false, detail: 'target pending' });
    expect(rule('routed')).toMatchObject({ ok: false, reason: 'not_routed', detail: 'cams instances that see the source but not the target: cluster' });
    expect(rule('no_host_override')).toMatchObject({ ok: true });
    expect((await bearer(`/diag/moves/precheck?target=${px2}`, token)).body).toEqual({ error: 'invalid', field: 'source' });
    expect((await bearer(`/diag/moves/precheck?source=prx_NOPE&target=${px2}`, token)).status).toBe(404);
    expect((await bearer(`/diag/moves/precheck?source=${px}&target=${px2}&camera=nope`, token)).body).toEqual({ error: 'not_found', field: 'camera' });
    const other = a.registry.createAccount('admin@example.com', { name: 'away', displayName: 'Away' }).id;
    const foreign = a.registry.createProxy('admin@example.com', other, { name: 'far', displayName: 'Far', runsOn: 'cloud' }).id;
    expect((await bearer(`/diag/moves/precheck?source=${px}&target=${foreign}`, token)).body).toMatchObject({ ok: false, reason: 'other_account', rules: [{ rule: 'different_proxies', ok: true }, { rule: 'same_account', ok: false, detail: 'other account: target' }] });
  });

  it('the secret guard: markers in hashes, codes, keys, e-mails and notes never appear in any answer', async () => {
    const MARK = 'f00dfeed';
    const { token } = await issue('guard', 1);
    const i = a.camsInstances.list()[0];
    a.camsInstances.createCode('admin@example.com', i.id, 1);
    await a.api('post', `/accounts/${acc}/proxies/${px}/enrollment-codes`, { lifetimeH: 1 });
    await a.api('post', `/accounts/${acc}/proxies/${px}/tokens`, { kind: 'client', label: 'guard' });
    a.registry.createUser('admin@example.com', acc, { email: `${MARK}@example.com`, role: 'viewer' });
    a.db.prepare(`UPDATE proxy_tokens SET hash = 'sha256:' || ? || substr(hash, 16)`).run(MARK);
    a.db.prepare(`UPDATE enrollment_codes SET code_hash = ? || code_hash`).run(MARK);
    a.db.prepare(`UPDATE cams_enrollment_codes SET code_hash = ? || code_hash`).run(MARK);
    a.db.prepare(`UPDATE proxies SET notes = ?`).run(MARK);
    a.db.prepare(`UPDATE cameras SET notes = ?, web_ui_note = ?`).run(MARK, MARK);
    a.db.prepare(`UPDATE accounts SET notes = ?`).run(MARK);
    a.db.prepare(`UPDATE cams_instances SET notes = ?`).run(MARK);
    a.db.prepare(`UPDATE diag_tokens SET hash = 'sha256:' || ? || substr(hash, 16) WHERE name <> 'guard'`).run(MARK);
    const hash = (a.db.prepare(`SELECT hash FROM diag_tokens WHERE name = 'guard'`).get() as { hash: string }).hash;
    for (const r of [...ROUTES.filter((x) => x !== '/diag/audit'), `/diag/moves/precheck?source=${px}&target=${px2}&camera=porch`]) {
      const body = JSON.stringify((await bearer(r, token)).body);
      expect(body, r).not.toContain(MARK);
      expect(body, r).not.toContain(token);
      expect(body, r).not.toContain(hash.slice(7));
    }
    // The audit answer: the token and its full hash never, the e-mail of the user record is the audit's own business.
    const audit = JSON.stringify((await bearer('/diag/audit?limit=200', token)).body);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(hash.slice(7));
  });
});

describe('revocation journal', () => {
  it('a restore from an older backup does not bring a revoked token back', async () => {
    const d2 = tmpDir();
    process.env.ALLOWED_EMAILS = 'admin@example.com';
    const env = { PUBLIC_URL: 'https://cams-admin.example.net', DB_FILE: join(d2, 'app.db'), SERVER_SIGNING_KEY_FILE: writeSigningKey(join(d2, 'sk.pem')), NODE_ENV: 'test' };
    const b1 = buildServer(env);
    const { token, item } = b1.diag.issue('admin@example.com', { name: 'restored', days: 1 });
    b1.diag.revoke('admin@example.com', item.id);
    expect(existsSync(join(d2, 'cams-revocations.jsonl'))).toBe(true);
    expect(readFileSync(join(d2, 'cams-revocations.jsonl'), 'utf8')).not.toContain(token);
    // What an older backup would hold: the token not revoked.
    b1.db.prepare('UPDATE diag_tokens SET revoked_at = NULL, revoked_by = NULL WHERE id = ?').run(item.id);
    await b1.close();
    const b2 = buildServer(env);
    try {
      expect(b2.diag.verify(token)).toBeNull();
      expect(b2.diag.list().items[0]).toMatchObject({ id: item.id, state: 'revoked', revokedBy: 'system' });
    } finally {
      await b2.close();
    }
  });
});
