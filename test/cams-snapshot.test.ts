import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, encodeSnapshot, snapshotRevision, type SnapshotDeps } from '../server/cams/snapshot';
import { camsResponseText, publicFromB64, verify, verifyEnvelope } from '../server/crypto/ed25519';
import { tmpDir } from './helpers/tmp';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch, type CamsKeyT } from './helpers/cams';
import { strictCamsValidator, strictCamsErrors } from './helpers/contract';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const H = (c: string) => 'sha256:' + c.repeat(64);

describe('the cams snapshot (GET /cams/v1/config)', () => {
  const dir = tmpDir();
  let s: Running;
  let d: SnapshotDeps;
  let home: any, beta: any, piProxy: any, clusterProxy: any, b1: any, viewer: any, cluster: any, pi: any, unserved: any;
  let key: CamsKeyT;
  const FP = () => d.signingFingerprint;
  const tok = (id: string, proxy: any, holder: string, state: string, hash: string, revokedAt: number | null = null) =>
    s.built.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,revoked_at,created_at,created_by) VALUES (?,?,?,'client',?,'l',?,?,1,?,1,'a@example.com')`)
      .run(id, proxy.accountId, proxy.id, holder, hash, state, revokedAt);

  beforeAll(async () => {
    s = await startServer(dir);
    d = { db: s.built.db, clock: s.built.clock, signingKey: s.built.signing.key, signingFingerprint: s.built.signing.fingerprint };
    home = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    beta = await s.api('POST', '/accounts', { name: 'beta', displayName: 'Beta' });
    await s.api('POST', `/accounts/${home.id}/users`, { email: 'Klaus@Example.org', role: 'admin' });
    viewer = await s.api('POST', `/accounts/${home.id}/users`, { email: 'v@example.org', role: 'viewer' });
    await s.api('POST', `/accounts/${beta.id}/users`, { email: 'klaus@example.org', role: 'viewer' });
    piProxy = await s.api('POST', `/accounts/${home.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480', caFingerprints: ['ab'.repeat(32)] });
    clusterProxy = await s.api('POST', `/accounts/${home.id}/proxies`, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster', url: 'https://cluster.example.net' });
    b1 = await s.api('POST', `/accounts/${beta.id}/proxies`, { name: 'b1', displayName: 'B1', runsOn: 'cloud', url: 'https://b1.example.net' });
    await s.api('POST', `/accounts/${home.id}/cameras`, { camsId: 'cam1', name: 'Yard', kind: 'camera', proxyId: piProxy.id, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https', cameraUser: 'cams' });
    await s.api('POST', `/accounts/${home.id}/cameras`, { camsId: 'cam2', name: 'Drive', kind: 'camera', proxyId: clusterProxy.id, proxyCameraId: 'cam2' });
    await s.api('POST', `/accounts/${home.id}/cameras`, { camsId: 'loose', name: 'Loose', kind: 'camera' });
    await s.api('POST', `/accounts/${beta.id}/cameras`, { camsId: 'cam1', name: 'Gate', kind: 'camera', proxyId: b1.id, proxyCameraId: 'cam1' });
    cluster = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home.id, beta.id] });
    pi = await s.api('POST', '/cams-instances', { name: 'pi', displayName: 'Pi', accounts: [home.id] });
    unserved = await s.api('POST', '/cams-instances', { name: 'empty', displayName: 'Empty', accounts: [] });
    await s.api('PUT', `/cams-instances/${pi.id}/routes/${piProxy.id}`, { url: 'http://127.0.0.1:8480', hidden: false });
    await s.api('PUT', `/cams-instances/${pi.id}/routes/${clusterProxy.id}`, { url: null, hidden: true });
    const now = s.built.clock.now();
    tok('tok_00000000000000000001', piProxy, cluster.id, 'active', H('1'));
    tok('tok_00000000000000000002', piProxy, 'manual', 'active', H('2'));
    tok('tok_00000000000000000003', piProxy, cluster.id, 'revoked', H('3'), now - 8 * 86400_000);
    tok('tok_00000000000000000004', piProxy, cluster.id, 'revoked', H('4'), now - 86400_000);
    tok('tok_00000000000000000005', piProxy, pi.id, 'pending', H('5'));
    key = await enrollCamsKey(s, cluster.id);
  });
  afterAll(() => s.stop());

  it('an instance sees exactly its accounts, sorted by name; the pi instance sees only the pi proxy, at its route URL', () => {
    const c = buildSnapshot(d, cluster.id);
    expect(c.accounts.map((a) => a.name)).toEqual(['beta', 'home']);
    expect(c.accounts[1].proxies.map((x) => [x.name, x.url])).toEqual([['cluster', 'https://cluster.example.net'], ['pi', 'https://proxy.example.net:8480']]);
    const p = buildSnapshot(d, pi.id);
    expect(p.accounts.map((a) => a.name)).toEqual(['home']);
    expect(p.accounts[0].proxies.map((x) => [x.name, x.url])).toEqual([['pi', 'http://127.0.0.1:8480']]);
    expect(p.accounts[0].cameras.map((x) => x.camsId)).toEqual(['cam1', 'loose']);
    expect(buildSnapshot(d, unserved.id).accounts).toEqual([]);
  });

  it('users: every user, lower-case email, role and disabled', () => {
    const h = buildSnapshot(d, cluster.id).accounts[1];
    expect(h.users).toEqual([{ email: 'klaus@example.org', role: 'admin', disabled: false }, { email: 'v@example.org', role: 'viewer', disabled: false }]);
  });

  it('the same camsId in two accounts stays in its own account', () => {
    const c = buildSnapshot(d, cluster.id);
    expect(c.accounts.find((a) => a.name === 'beta')!.cameras[0]).toMatchObject({ camsId: 'cam1', proxyId: b1.id, name: 'Gate' });
    expect(c.accounts.find((a) => a.name === 'home')!.cameras.find((x) => x.camsId === 'cam1')).toMatchObject({ proxyId: piProxy.id, host: 'from-proxy', protocol: 'https', cameraUser: 'cams' });
  });

  it('tokens: only those held by this instance, never a hash; revoked ones only for 7 days', () => {
    const px = buildSnapshot(d, cluster.id).accounts[1].proxies.find((x) => x.name === 'pi')!;
    expect(px.tokens).toEqual([
      { id: 'tok_00000000000000000001', kind: 'client', state: 'active', retireAt: null },
      { id: 'tok_00000000000000000004', kind: 'client', state: 'revoked', retireAt: null },
    ]);
    expect(buildSnapshot(d, pi.id).accounts[0].proxies[0].tokens.map((t) => t.id)).toEqual(['tok_00000000000000000005']);
    expect(px.caFingerprints).toEqual(['SHA256:' + 'AB'.repeat(32)]);
  });

  it('the signature verifies over jcs(snapshot without sig); strict schema passes', () => {
    for (const i of [cluster, pi, unserved]) {
      const c = buildSnapshot(d, i.id);
      expect(verifyEnvelope(publicFromB64(s.built.signing.publicKeyB64), c as never)).toBe(true);
      expect(strictCamsValidator('snapshot')(c), strictCamsErrors()).toBe(true);
      expect(c.revision).toBe(snapshotRevision(d.db, i.id, FP()));
      expect(c.instance).toEqual({ id: i.id, name: i.name, rotateBefore: null });
    }
  });

  it('revision changes on a user role change, a route change, a token state change, served accounts, rotate-now, a key change, and not on a heartbeat', async () => {
    let r = snapshotRevision(d.db, cluster.id, FP());
    const changed = (what: string) => {
      const n = snapshotRevision(d.db, cluster.id, FP());
      expect(n, what).not.toBe(r);
      r = n;
    };
    await s.api('PATCH', `/accounts/${home.id}/users/${viewer.id}`, { role: 'admin', version: viewer.version });
    changed('role');
    await s.api('PUT', `/cams-instances/${cluster.id}/routes/${b1.id}`, { url: 'https://b1-alt.example.net', hidden: false });
    changed('route');
    s.built.db.prepare(`UPDATE proxy_tokens SET state = 'retiring' WHERE id = 'tok_00000000000000000001'`).run();
    changed('token');
    const c = s.built.camsInstances.get(cluster.id);
    await s.api('PATCH', `/cams-instances/${cluster.id}`, { accounts: [home.id], version: c.version });
    changed('served accounts');
    expect(buildSnapshot(d, cluster.id).accounts.map((a) => a.name)).toEqual(['home']);
    await s.api('POST', `/cams-instances/${cluster.id}/rotate`, {});
    changed('rotate');
    expect(buildSnapshot(d, cluster.id).instance.rotateBefore).toEqual(expect.any(Number));
    expect(snapshotRevision(d.db, cluster.id, 'SHA256:' + '0'.repeat(64))).not.toBe(r);
    s.built.status.hello(piProxy.id, 'v1', Date.now(), ['status']);
    s.built.status.heartbeat(piProxy.id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: makeProxyInfo({ now: Date.now() }), truncated: false }, Date.now());
    s.built.status.flush(true);
    expect(snapshotRevision(d.db, cluster.id, FP())).toBe(r);
    const c2 = s.built.camsInstances.get(cluster.id);
    await s.api('PATCH', `/cams-instances/${cluster.id}`, { accounts: [home.id, beta.id], version: c2.version });
  });

  it('a proxy moved between accounts takes its cameras out of the old account (no cross-account leak)', () => {
    const p = buildSnapshot(d, pi.id);
    expect(JSON.stringify(p)).not.toContain(b1.id);
    expect(JSON.stringify(p)).not.toContain('Gate');
  });

  it('the secret guard: markers in token hashes, codes and keys never appear in any instance\'s snapshot', async () => {
    const MARK = 'f00dfeed';
    s.built.db.prepare(`UPDATE proxy_tokens SET hash = 'sha256:' || ? || substr(hash, 16)`).run(MARK);
    await s.api('POST', `/cams-instances/${cluster.id}/enrollment-codes`, { lifetimeH: 1 });
    s.built.db.prepare(`UPDATE cams_enrollment_codes SET code_hash = ? || code_hash`).run(MARK);
    s.built.db.prepare(`UPDATE cams_instance_keys SET public_key = public_key || ?, fingerprint = ?`).run(MARK, MARK);
    s.built.db.prepare(`UPDATE proxies SET notes = ?, dns_name = ?, tls_site = ?`).run(MARK, MARK, MARK);
    s.built.db.prepare(`UPDATE cameras SET notes = ?, model = ?`).run(MARK, MARK);
    s.built.db.prepare(`UPDATE accounts SET notes = ?`).run(MARK);
    for (const i of [cluster, pi, unserved]) expect(JSON.stringify(buildSnapshot(d, i.id))).not.toContain(MARK);
    s.built.db.prepare(`UPDATE cams_instance_keys SET public_key = replace(public_key, ?, '')`).run(MARK);
  });

  it('GET /cams/v1/config: 200 with ETag; If-None-Match equal → 304 signed with an empty body; the body revision equals the ETag', async () => {
    const a = await signedFetch(s, key, 'GET', '/cams/v1/config');
    expect(a.status).toBe(200);
    const etag = a.headers.get('etag')!;
    const body = Buffer.from(await a.arrayBuffer());
    expect(verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(200, a.nonce, body), a.headers.get('x-cams-admin-sig'))).toBe(true);
    const snap = JSON.parse(body.toString('utf8'));
    expect(etag).toBe(`"${snap.revision}"`);
    expect(strictCamsValidator('snapshot')(snap)).toBe(true);
    const b = await signedFetch(s, key, 'GET', '/cams/v1/config', undefined, { headers: { 'If-None-Match': etag } });
    const bb = Buffer.from(await b.arrayBuffer());
    expect([b.status, bb.byteLength]).toEqual([304, 0]);
    expect(verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(304, b.nonce, bb), b.headers.get('x-cams-admin-sig'))).toBe(true);
    expect(s.built.camsInstances.live(cluster.id)).toMatchObject({ lastPullStatus: 304, lastPullAt: expect.any(Number) });
  });

  it('a snapshot over the limit is refused with 500 snapshot_too_large (never truncated)', () => {
    const snap = buildSnapshot(d, cluster.id);
    expect(encodeSnapshot(snap).length).toBeGreaterThan(100);
    expect(() => encodeSnapshot(snap, 100)).toThrow(expect.objectContaining({ status: 500, code: 'snapshot_too_large' }));
  });
});
