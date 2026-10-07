import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, startServer, until, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch, type CamsKeyT } from './helpers/cams';
import { generateToken } from '../server/tokens/service';
import { readEpoch } from '../server/db/open';
import type { ProxyClient } from '../test-client/client';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

describe('cams-held tokens (POST /cams/v1/tokens, retire; R4-19)', () => {
  const dir = tmpDir();
  let s: Running;
  const clients: ProxyClient[] = [];
  let home: string, other: string;
  let inst: any, key: CamsKeyT, inst2: any, key2: CamsKeyT;
  let px: { proxyId: string; client: ProxyClient }, pxNoAdmin: { proxyId: string; client: ProxyClient }, foreign: { proxyId: string }, hiddenPx: { proxyId: string };
  const post = async (k: CamsKeyT, path: string, body: unknown) => {
    const r = await signedFetch(s, k, 'POST', path, body);
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const snapshot = async (k: CamsKeyT) => (await (await signedFetch(s, k, 'GET', '/cams/v1/config')).json());
  const tokenOf = async (k: CamsKeyT, id: string) => {
    const snap = await snapshot(k);
    for (const a of snap.accounts) for (const p of a.proxies) for (const t of p.tokens) if (t.id === id) return t;
    return null;
  };
  async function proxy(name: string, allow: string[] | null, account = 'home') {
    const p = await enrolled(s, name, account);
    const client = makeClient(p.key, allow ? { commands: { allow } } : {});
    clients.push(client);
    client.start();
    await until(() => !!s.built.status.row(p.proxyId)?.reported?.cameras.length, 5000);
    if (allow) await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000);
    return { ...p, client };
  }
  // Routes are default-deny: an instance sees a proxy only through a route row.
  const route = (instanceId: string, proxyId: string) => s.api('PUT', `/cams-instances/${instanceId}/routes/${proxyId}`, { url: null, hidden: false });
  const auditRows = (action: string) => s.built.db.prepare('SELECT actor_type, actor FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_type: string; actor: string }[];

  beforeAll(async () => {
    s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000' });
    px = await proxy('tok-a', ['tokens.apply', 'tokens.apply.admin']);
    pxNoAdmin = await proxy('tok-b', ['tokens.apply']);
    hiddenPx = await proxy('tok-h', ['tokens.apply']);
    foreign = await proxy('tok-f', ['tokens.apply'], 'other');
    home = (s.built.registry.proxyById(px.proxyId))!.accountId;
    other = (s.built.registry.proxyById(foreign.proxyId))!.accountId;
    inst = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home] });
    inst2 = await s.api('POST', '/cams-instances', { name: 'second', displayName: 'Second', accounts: [home] });
    await s.api('PUT', `/cams-instances/${inst.id}/routes/${hiddenPx.proxyId}`, { url: null, hidden: true });
    for (const i of [inst, inst2]) for (const p of [px, pxNoAdmin]) await route(i.id, p.proxyId);
    key = await enrollCamsKey(s, inst.id);
    key2 = await enrollCamsKey(s, inst2.id);
  });
  afterAll(async () => {
    for (const c of clients) await c.stop('shutdown');
    await s.stop();
  });

  it('registers a client token hash: 201 pending, label "cams cluster", holder = the instance; becomes active after tokens.apply; audit actor type cams', async () => {
    const { hash } = generateToken();
    const a = await post(key, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash });
    expect([a.status, a.json]).toEqual([201, { tokenId: expect.stringMatching(/^tok_/), state: 'pending', label: 'cams cluster' }]);
    await until(async () => (await tokenOf(key, a.json.tokenId))?.state === 'active', 5000, 'active');
    expect(px.client.accepts(hash)).toBe(true);
    expect(auditRows('token-issue').at(-1)).toEqual({ actor_type: 'cams', actor: inst.id });
    expect(auditRows('command-create').at(-1)).toEqual({ actor_type: 'cams', actor: inst.id });
    expect(s.built.db.prepare('SELECT holder FROM proxy_tokens WHERE id = ?').get(a.json.tokenId)).toEqual({ holder: inst.id });
    // The other instance doesn't see it.
    expect(await tokenOf(key2, a.json.tokenId)).toBeNull();
  });

  it('idempotent by hash (200, same tokenId); another pending one of the same kind → 409 pending_exists with its id', async () => {
    const { hash } = generateToken();
    // A proxy that can't take the set now keeps the token pending.
    const p = await proxy('tok-idem', ['tokens.apply']);
    await route(inst.id, p.proxyId);
    await p.client.stop('shutdown');
    const a = await post(key, '/cams/v1/tokens', { v: 1, proxyId: p.proxyId, kind: 'client', hash });
    expect(a.status).toBe(201);
    const again = await post(key, '/cams/v1/tokens', { v: 1, proxyId: p.proxyId, kind: 'client', hash });
    expect([again.status, again.json.tokenId]).toEqual([200, a.json.tokenId]);
    const second = await post(key, '/cams/v1/tokens', { v: 1, proxyId: p.proxyId, kind: 'client', hash: generateToken().hash });
    expect([second.status, second.json]).toEqual([409, { error: 'pending_exists', tokenId: a.json.tokenId }]);
  });

  it('a hash already used anywhere else → 409 hash_in_use, nothing written', async () => {
    const { hash } = generateToken();
    expect((await post(key2, '/cams/v1/tokens', { v: 1, proxyId: pxNoAdmin.proxyId, kind: 'client', hash })).status).toBe(201);
    const count = () => s.built.db.prepare(`SELECT (SELECT count(*) FROM proxy_tokens) t, (SELECT count(*) FROM audit_log WHERE action = 'token-issue') a`).get();
    const before = count();
    const r = await post(key, '/cams/v1/tokens', { v: 1, proxyId: pxNoAdmin.proxyId, kind: 'client', hash });
    expect([r.status, r.json]).toEqual([409, { error: 'hash_in_use' }]);
    expect(count()).toEqual(before);
    // The same hash for another proxy or kind, even by its holder, is in use too.
    expect((await post(key2, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash })).json).toEqual({ error: 'hash_in_use' });
  });

  it('a proxy of an unserved account, a hidden one, or an unknown one → 404 not_found', async () => {
    for (const proxyId of [foreign.proxyId, hiddenPx.proxyId, 'prx_ZZZZZZZZZZZZZZZZZZZZ']) {
      const r = await post(key, '/cams/v1/tokens', { v: 1, proxyId, kind: 'client', hash: generateToken().hash });
      expect([r.status, r.json]).toEqual([404, { error: 'not_found' }]);
    }
    expect(other).not.toBe(home);
  });

  it('an invalid body → 400 invalid with the field', async () => {
    const r = await post(key, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash: 'sha256:' + 'A'.repeat(64) });
    expect([r.status, r.json]).toEqual([400, { error: 'invalid', field: 'hash' }]);
  });

  it('kind admin on a proxy that does not allow tokens.apply.admin → 409 not_allowed_on_proxy (the P2 pre-check, unchanged)', async () => {
    const r = await post(key, '/cams/v1/tokens', { v: 1, proxyId: pxNoAdmin.proxyId, kind: 'admin', hash: generateToken().hash });
    expect([r.status, r.json]).toEqual([409, { error: 'not_allowed_on_proxy' }]);
    const ok = await post(key, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'admin', hash: generateToken().hash });
    expect([ok.status, ok.json.label]).toEqual([201, 'cams cluster admin']);
  });

  it('retire: only own tokens (another instance\'s → 404), only active (else 409 not_active); hours 1–168, default 24', async () => {
    const stopped = await proxy('tok-pend', ['tokens.apply']);
    await route(inst.id, stopped.proxyId);
    await stopped.client.stop('shutdown');
    const p = await post(key, '/cams/v1/tokens', { v: 1, proxyId: stopped.proxyId, kind: 'client', hash: generateToken().hash });
    expect((await post(key, `/cams/v1/tokens/${p.json.tokenId}/retire`, { v: 1 })).json).toEqual({ error: 'not_active' });
    const { hash } = generateToken();
    const a = await post(key, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash });
    await until(async () => (await tokenOf(key, a.json.tokenId))?.state === 'active', 5000, 'active');
    expect((await post(key2, `/cams/v1/tokens/${a.json.tokenId}/retire`, { v: 1 })).status).toBe(404);
    expect((await post(key, `/cams/v1/tokens/${a.json.tokenId}/retire`, { v: 1, hours: 169 })).status).toBe(400);
    const t0 = Date.now();
    const r = await post(key, `/cams/v1/tokens/${a.json.tokenId}/retire`, { v: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ tokenId: a.json.tokenId, state: 'retiring', retireAt: expect.any(Number) });
    expect(Math.abs(r.json.retireAt - (t0 + 24 * 3600_000))).toBeLessThan(5000);
    expect(auditRows('token-retire').at(-1)).toEqual({ actor_type: 'cams', actor: inst.id });
  });

  it('a served account removed between two pulls: its tokens answer 404 and the next snapshot no longer lists it', async () => {
    const i = await s.api('POST', '/cams-instances', { name: 'shrink', displayName: 'Shrink', accounts: [home] });
    await route(i.id, px.proxyId);
    const k = await enrollCamsKey(s, i.id);
    const { hash } = generateToken();
    const a = await post(k, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash });
    await until(async () => (await tokenOf(k, a.json.tokenId))?.state === 'active', 5000, 'active');
    const cur = s.built.camsInstances.get(i.id);
    await s.api('PATCH', `/cams-instances/${i.id}`, { accounts: [], version: cur.version });
    // Its token there is revoked (no stale credential); the requests below write nothing.
    expect(s.built.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(a.json.tokenId)).toEqual({ state: 'revoked' });
    const count = () => s.built.db.prepare(`SELECT (SELECT count(*) FROM proxy_tokens) t, (SELECT count(*) FROM audit_log WHERE actor = ?) a`).get(i.id);
    const before = count();
    expect((await post(k, `/cams/v1/tokens/${a.json.tokenId}/retire`, { v: 1 })).status).toBe(404);
    expect((await post(k, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash: generateToken().hash })).status).toBe(404);
    expect(count()).toEqual(before);
    expect((await snapshot(k)).accounts).toEqual([]);
  });

  it('removing a served account or hiding a proxy revokes the tokens the instance holds there (no stale credential)', async () => {
    const i = await s.api('POST', '/cams-instances', { name: 'narrow', displayName: 'Narrow', accounts: [home] });
    for (const p of [px, pxNoAdmin]) await route(i.id, p.proxyId);
    const k = await enrollCamsKey(s, i.id);
    const a = await post(k, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash: generateToken().hash });
    const b = await post(k, '/cams/v1/tokens', { v: 1, proxyId: pxNoAdmin.proxyId, kind: 'client', hash: generateToken().hash });
    const state = (id: string) => (s.built.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(id) as { state: string }).state;
    await s.api('PUT', `/cams-instances/${i.id}/routes/${pxNoAdmin.proxyId}`, { url: null, hidden: true });
    expect(state(a.json.tokenId)).not.toBe('revoked');
    expect(state(b.json.tokenId)).toBe('revoked');
    const cur = s.built.camsInstances.get(i.id);
    await s.api('PATCH', `/cams-instances/${i.id}`, { accounts: [], version: cur.version });
    expect(state(a.json.tokenId)).toBe('revoked');
  });

  it('blocking the instance revokes every token it holds and the next tokens.apply removes them (R4-19)', async () => {
    const i = await s.api('POST', '/cams-instances', { name: 'doomed', displayName: 'Doomed', accounts: [home] });
    await route(i.id, px.proxyId);
    const k = await enrollCamsKey(s, i.id);
    const { hash } = generateToken();
    const a = await post(k, '/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash });
    await until(() => px.client.accepts(hash), 5000, 'accepted');
    await s.api('POST', `/cams-instances/${i.id}/block`, {});
    expect(s.built.db.prepare(`SELECT state FROM proxy_tokens WHERE holder = ?`).all(i.id)).toEqual([{ state: 'revoked' }]);
    await until(() => !px.client.accepts(hash), 5000, 'dropped by the proxy');
    expect(a.json.tokenId).toMatch(/^tok_/);
  });
});

// Without live proxies (their heartbeats write on their own): the status is fed directly.
describe('cams tokens: write budget', () => {
  const dir = tmpDir();
  let s: Running;
  afterAll(() => s.stop());
  it('a registration costs one transaction; pulls and reports cost none', async () => {
    // No ticks: the status store's own timers write on their schedule, not ours.
    s = await startServer(dir, { TICK_MS: '60000' });
    const acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    const px = await s.api('POST', `/accounts/${acc.id}/proxies`, { name: 'wb', displayName: 'WB', runsOn: 'cloud' });
    s.built.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(px.id);
    s.built.status.hello(px.id, 'v2', Date.now(), ['status', 'commands']);
    s.built.status.heartbeat(px.id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply', 'tokens.apply.admin'], seenWindow: 1000 } }, truncated: false }, Date.now());
    s.built.status.flush(true);
    const inst = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [acc.id] });
    await s.api('PUT', `/cams-instances/${inst.id}/routes/${px.id}`, { url: null, hidden: false });
    const key = await enrollCamsKey(s, inst.id);
    await signedFetch(s, key, 'GET', '/cams/v1/ping'); // confirms the key
    const e = readEpoch(s.built.db);
    const r = await signedFetch(s, key, 'POST', '/cams/v1/tokens', { v: 1, proxyId: px.id, kind: 'client', hash: generateToken().hash });
    expect(r.status).toBe(201);
    expect(readEpoch(s.built.db) - e).toBe(1);
    const e2 = readEpoch(s.built.db);
    let etag = '';
    for (let i = 0; i < 100; i++) {
      const x = await signedFetch(s, key, 'GET', '/cams/v1/config', undefined, etag ? { headers: { 'If-None-Match': etag } } : {});
      etag = x.headers.get('etag') ?? etag;
      if (i % 10 === 9) await signedFetch(s, key, 'POST', '/cams/v1/report', { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] });
    }
    expect(readEpoch(s.built.db)).toBe(e2);
  });

  it('the command audit says who acted, never guessed from the actor text (review M7)', async () => {
    const acc = (await s.api('GET', '/accounts')).items[0];
    const px = (await s.api('GET', `/accounts/${acc.id}/proxies`)).items[0];
    s.built.tokens.issue('cms_person@example.org', acc.id, px.id, { kind: 'client', label: 'by a person' });
    const row = s.built.db.prepare(`SELECT actor_type, actor FROM audit_log WHERE action = 'command-create' ORDER BY id DESC LIMIT 1`).get();
    expect(row).toEqual({ actor_type: 'sysadmin', actor: 'cms_person@example.org' });
  });

  it('at most 3 live tokens per holder, kind and proxy (one rotation); the 4th is too_many_tokens for that holder only (review M3)', async () => {
    const acc = (await s.api('GET', '/accounts')).items[0];
    const px = (await s.api('GET', `/accounts/${acc.id}/proxies`)).items[0];
    const inst = await s.api('POST', '/cams-instances', { name: 'capped', displayName: 'Capped', accounts: [acc.id] });
    await s.api('PUT', `/cams-instances/${inst.id}/routes/${px.id}`, { url: null, hidden: false });
    const key = await enrollCamsKey(s, inst.id);
    const reg = (kind = 'client') => signedFetch(s, key, 'POST', '/cams/v1/tokens', { v: 1, proxyId: px.id, kind, hash: generateToken().hash });
    for (let i = 0; i < 3; i++) {
      const r = await reg();
      expect(r.status).toBe(201);
      s.built.db.prepare(`UPDATE proxy_tokens SET state = 'active' WHERE id = ?`).run((await r.json()).tokenId); // as if applied
    }
    const fourth = await reg();
    expect([fourth.status, (await fourth.json()).error]).toEqual([409, 'too_many_tokens']);
    expect((await reg('admin')).status).toBe(201);
  });
});
