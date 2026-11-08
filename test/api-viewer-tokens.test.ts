// Viewer tokens on the API (design 2026-11-05): the routes, the session-only
// copy, an operations token that may only revoke, the no-key answers, and
// the account page's list.
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { chmodSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

const dir = tmpDir();
const keyFile = join(dir, 'viewer.key');
writeFileSync(keyFile, randomBytes(32).toString('base64'));
chmodSync(keyFile, 0o600);
const a = testApp(dir, { VIEWER_TOKEN_KEY_FILE: keyFile });
// The cluster sets VIEWER_TOKEN_KEY_FILE always; until the optional Secret exists the file is missing: the server starts, tokens are off.
const off = testApp(dir, { VIEWER_TOKEN_KEY_FILE: join(dir, 'not-there-yet.key') });
afterAll(() => { a.close(); off.close(); });
const ACTOR = 'admin@example.com';
const home = a.registry.createAccount(ACTOR, { name: 'home', displayName: 'Home' }).id;
const away = a.registry.createAccount(ACTOR, { name: 'away', displayName: 'Away' }).id;
const bearer = (method: 'post' | 'put' | 'delete', path: string, token: string, body?: unknown) =>
  request(a.app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send(JSON.stringify(body ?? {}));

describe('viewer token routes', () => {
  it('create → list → copy → validity → accounts → revoke → delete', async () => {
    const c = await a.api('post', '/viewer-tokens', { name: 'Kitchen tablet', accountIds: [home] });
    expect(c.status).toBe(201);
    expect(c.headers['cache-control']).toBe('no-store');
    expect(c.body.token).toMatch(/^cav_[0-9A-Za-z]{22}$/);
    expect(c.body.link).toBe(`https://cams.skylar.technology/token#t=${c.body.token}`);
    const id = c.body.item.id;

    const list = await a.api('get', `/viewer-tokens?account=${home}`);
    expect(list.body).toMatchObject({ configured: true, linkBase: 'https://cams.skylar.technology' });
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(JSON.stringify(list.body)).not.toContain(c.body.token);
    expect((await a.api('get', `/viewer-tokens?account=${away}`)).body.items).toEqual([]);
    expect((await a.api('get', '/viewer-tokens?account=acc_00000000000000000000')).status).toBe(404);

    const copy = await a.api('post', `/viewer-tokens/${id}/copy`, { what: 'token' });
    expect(copy.status).toBe(200);
    expect(copy.headers['cache-control']).toBe('no-store');
    expect(copy.body).toEqual({ token: c.body.token, link: c.body.link, links: c.body.links });
    expect(c.body.links).toEqual([{ instanceId: null, name: 'Main viewer', base: 'https://cams.skylar.technology', link: c.body.link }]);
    // A URL in the request is never used: the server builds every link.
    const forged = await a.api('post', `/viewer-tokens/${id}/copy`, { what: 'qr', base: 'https://evil.example.com', links: [{ base: 'https://evil.example.com' }] });
    expect(JSON.stringify(forged.body)).not.toContain('evil.example.com');

    const v = await a.api('post', `/viewer-tokens/${id}/validity`, { days: 365 });
    expect(v.body).toMatchObject({ days: 365, state: 'valid' });
    expect((await a.api('post', `/viewer-tokens/${id}/validity`, { days: 3 })).body).toEqual({ error: 'invalid', field: 'days' });

    const acc = await a.api('put', `/viewer-tokens/${id}/accounts`, { accountIds: [home, away], version: v.body.version });
    expect(acc.body.accounts.map((x: { name: string }) => x.name)).toEqual(['away', 'home']);
    expect((await a.api('put', `/viewer-tokens/${id}/accounts`, { accountIds: [home], version: 1 })).status).toBe(409);

    expect((await a.api('post', `/viewer-tokens/${id}/revoke`)).body.state).toBe('revoked');
    expect((await a.api('delete', `/viewer-tokens/${id}`)).status).toBe(204);
    expect((await a.api('get', '/viewer-tokens')).body.items).toEqual([]);
    expect((await a.api('post', `/viewer-tokens/${id}/copy`, { what: 'token' })).status).toBe(404);
  });

  it('writes need the CSRF header, like every session write', async () => {
    const r = await request(a.app).post('/api/v1/viewer-tokens').set('Cookie', a.cookie).set('Content-Type', 'application/json').send(JSON.stringify({ name: 'x', accountIds: [home] }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'csrf' });
  });

  it('an operations token may revoke (scope tokens) and nothing else; never copy', async () => {
    const c = (await a.api('post', '/viewer-tokens', { name: 'ops target', accountIds: [home] })).body;
    const { token } = a.ops.issue(ACTOR, { name: 'script', scopes: ['tokens'], days: 1 });
    expect((await bearer('post', `/viewer-tokens/${c.item.id}/copy`, token, { what: 'token' })).status).toBe(403);
    expect((await bearer('post', '/viewer-tokens', token, { name: 'x', accountIds: [home] })).status).toBe(403);
    expect((await bearer('post', `/viewer-tokens/${c.item.id}/validity`, token, { days: 7 })).status).toBe(403);
    expect((await bearer('delete', `/viewer-tokens/${c.item.id}`, token)).status).toBe(403);
    const r = await bearer('post', `/viewer-tokens/${c.item.id}/revoke`, token);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('revoked');
    const rec = a.audit.list({ action: 'viewer-token-revoke' }).items.find((x) => x.targetId === c.item.id)!;
    expect(rec.actor).toMatch(/^ops-token:[0-9a-f]{8}$/);
  });

  it('with VIEWER_TOKEN_KEY_FILE naming a missing file: the server runs, the list says so; create and copy answer 503', async () => {
    const acc = off.registry.createAccount(ACTOR, { name: 'home', displayName: 'Home' }).id;
    expect((await off.api('get', `/viewer-tokens?account=${acc}`)).body).toMatchObject({ configured: false, items: [] });
    expect((await off.api('post', '/viewer-tokens', { name: 'x', accountIds: [acc] })).body).toEqual({ error: 'viewer_tokens_unconfigured' });
  });

  it('the diag view lists them without the token or the fingerprint', async () => {
    const c = (await a.api('post', '/viewer-tokens', { name: 'diag me', accountIds: [home] })).body;
    const r = await request(a.app).get('/api/v1/diag/viewer-tokens').set('Cookie', a.cookie);
    expect(r.status).toBe(200);
    const item = r.body.items.find((t: { id: string }) => t.id === c.item.id);
    expect(item).toMatchObject({ name: 'diag me', accountIds: [home], state: 'valid', fingerprintPrefix: c.item.fingerprintPrefix });
    expect(JSON.stringify(r.body)).not.toContain(c.token);
  });
});
