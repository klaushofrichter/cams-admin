import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const built: { close(): Promise<void> }[] = [];
afterEach(async () => { while (built.length) await built.pop()!.close(); });

describe('the API', () => {
  const dir = tmpDir();
  const app = () => { const a = testApp(dir); built.push(a); return a; };

  it('needs a session', async () => {
    const a = app();
    expect((await request(a.app).get('/api/v1/accounts')).status).toBe(401);
    expect((await a.api('get', '/me')).body).toMatchObject({ email: 'admin@example.com', expiresAt: expect.any(Number) });
  });

  it('accounts, users and memberships across accounts', async () => {
    const a = app();
    const acc = (await a.api('post', '/accounts', { name: 'alpha', displayName: 'Alpha' })).body;
    expect(acc).toMatchObject({ name: 'alpha', version: 1 });
    expect((await a.api('post', '/accounts', { name: 'Bad Name', displayName: 'x' })).body).toEqual({ error: 'invalid', field: 'name' });
    const beta = (await a.api('post', '/accounts', { name: 'beta', displayName: 'Beta' })).body;
    expect((await a.api('post', `/accounts/${acc.id}/users`, { email: 'u@example.com', role: 'admin' })).status).toBe(201);
    expect((await a.api('post', `/accounts/${acc.id}/users`, { email: 'U@example.com', role: 'viewer' })).body).toEqual({ error: 'duplicate_email', field: 'email' });
    expect((await a.api('post', `/accounts/${beta.id}/users`, { email: 'u@example.com', role: 'viewer' })).status).toBe(201);
    const m = (await a.api('get', '/users?email=u@example.com')).body;
    expect(m.items.map((x: { accountName: string; role: string }) => `${x.accountName}:${x.role}`)).toEqual(['alpha:admin', 'beta:viewer']);
    expect((await a.api('patch', `/accounts/${acc.id}`, { displayName: 'A2', version: 1 })).body.version).toBe(2);
    expect((await a.api('patch', `/accounts/${acc.id}`, { displayName: 'A3', version: 1 })).status).toBe(409);
    expect((await a.api('delete', `/accounts/${acc.id}`, { confirmName: 'nope' })).status).toBe(400);
    expect((await a.api('delete', `/accounts/${acc.id}`, { confirmName: 'alpha' })).status).toBe(204);
    expect((await a.api('get', `/accounts/${acc.id}`)).status).toBe(404);
  });

  it('proxies, enrollment codes shown once, keys, block, cameras, sims, adopt', async () => {
    const a = app();
    const acc = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    const p = (await a.api('post', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', hostKind: 'pi' })).body;
    const code = (await a.api('post', `/accounts/${acc.id}/proxies/${p.id}/enrollment-codes`, { lifetimeH: 24 })).body;
    expect(code.code).toMatch(/^CAE1-/);
    expect(code.command).toContain('admin-enroll --url https://cams-admin.example.net');
    const st = (await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/status`)).body;
    expect(JSON.stringify(st)).not.toContain(code.code);
    expect(st.enrollment).toMatchObject({ id: code.id, expiresAt: code.expiresAt });
    expect((await a.api('delete', `/accounts/${acc.id}/proxies/${p.id}/enrollment-codes/${code.id}`)).status).toBe(204);
    expect((await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/keys`)).body.items).toEqual([]);
    const cam = (await a.api('post', `/accounts/${acc.id}/cameras`, { camsId: 'sim1', name: 'Sim 1', kind: 'sim', proxyId: p.id, proxyCameraId: 'cam1' })).body;
    expect((await a.api('put', `/accounts/${acc.id}/cameras/${cam.id}/sim`, { runsOn: 'mac', controlUrl: 'http://127.0.0.1:29502' })).body).toMatchObject({ runsOn: 'mac' });
    expect((await a.api('get', `/accounts/${acc.id}/cameras`)).body.items[0].sim).toMatchObject({ runsOn: 'mac' });
    // A reported camera, adopted.
    a.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    a.status.heartbeat(p.id, { summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: makeProxyInfo({ now: Date.now() }), truncated: false }, Date.now());
    const st2 = (await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/status`)).body;
    expect(st2.reconcile.reportedNotRegistered).toEqual([{ ref: 'cam2', proposedCamsId: 'cam2' }]);
    expect(st2.summary.cameras).toHaveLength(2);
    const adopted = (await a.api('post', `/accounts/${acc.id}/proxies/${p.id}/adopt`, { proxyCameraId: 'cam2', kind: 'camera' })).body;
    expect(adopted).toMatchObject({ camsId: 'cam2', proxyCameraId: 'cam2', proxyId: p.id, name: 'Camera 2' });
    expect((await a.api('post', `/accounts/${acc.id}/proxies/${p.id}/block`)).body.state).toBe('revoked');
    expect((await a.api('post', `/accounts/${acc.id}/proxies/${p.id}/enrollment-codes`, {})).status).toBe(409);
    expect((await a.api('delete', `/accounts/${acc.id}/proxies/${p.id}`)).status).toBe(204);
    expect((await a.api('get', `/accounts/${acc.id}/cameras/${cam.id}`)).body.proxyId).toBeNull();
  });

  it('the dashboard lists accounts, proxies with state and cameras, and the backup card', async () => {
    const a = app();
    const acc = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    await a.api('post', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    const d = (await a.api('get', '/dashboard')).body;
    expect(d.accounts[0]).toMatchObject({ name: 'home', proxies: [{ name: 'pi', state: 'pending' }], warnings: ['no-admin'] });
    expect(d.backup).toMatchObject({ lastSnapshotAt: null, alerts: expect.any(Array) });
    expect(d.summary).toMatchObject({ accounts: 1, proxies: 1, proxiesOnline: 0 });
  });

  it('the audit log filters and pages', async () => {
    const a = app();
    for (const name of ['aa', 'bb', 'cc']) await a.api('post', '/accounts', { name, displayName: name });
    const r = (await a.api('get', '/audit?action=account-create&limit=2')).body;
    expect(r.items).toHaveLength(2);
    expect((await a.api('get', `/audit?action=account-create&limit=2&cursor=${r.nextCursor}`)).body.items).toHaveLength(1);
  });

  it('backup now: the result and state on GET /backup; 6 an hour, then 429', async () => {
    const a = app();
    const r = (await a.api('post', '/backup/now', {})).body;
    expect(r).toMatchObject({ ok: false, litestream: { ok: false, error: 'Litestream is not configured (LITESTREAM_SOCKET)' }, snapshot: { ok: true, key: expect.stringMatching(/snapshots\/manual-\d{8}T\d{6}Z\.sqlite\.gz$/) } });
    expect((await a.api('get', '/backup')).body).toMatchObject({ configured: false, store: 'local folder (no S3 configured)', lastManual: { ok: false, snapshot: { ok: true } } });
    for (let i = 0; i < 5; i++) await a.api('post', '/backup/now', {});
    expect((await a.api('post', '/backup/now', {})).status).toBe(429);
    expect((await request(a.app).get('/health')).body.backup).toMatchObject({ lastManualAt: expect.any(Number), lastManualOk: false });
  });

  it('answers malformed JSON with 400 and a big body with 413', async () => {
    const a = app();
    const bad = await request(a.app).post('/api/v1/accounts').set('Cookie', a.cookie).set('X-Cams-Admin', '1').set('Content-Type', 'application/json').send('{nope');
    expect(bad.status).toBe(400);
    const big = await a.api('post', '/accounts', { name: 'xx', displayName: 'x', notes: 'n'.repeat(70_000) });
    expect(big.status).toBe(413);
  });
});
