import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, startServer, until, type Running } from './helpers/server';
import { CamsTestClient, enrollCams } from '../test-client/cams';
import { generateKeyPair, fingerprint } from '../server/crypto/ed25519';
import { generateToken } from '../server/tokens/service';
import type { ProxyClient } from '../test-client/client';

describe('the reference cams client (test-client/cams.ts) against a real server', () => {
  const dir = tmpDir();
  let s: Running;
  let px: { proxyId: string; accountId: string; client: ProxyClient };
  let cams: CamsTestClient;
  let instId = '';
  beforeAll(async () => {
    s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000' });
    const p = await enrolled(s, 'ref-a');
    const client = makeClient(p.key, { commands: { allow: ['tokens.apply', 'tokens.apply.admin'] } });
    client.start();
    await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000);
    px = { ...p, client };
    const inst = await s.api('POST', '/cams-instances', { name: 'ref', displayName: 'Ref', accounts: [p.accountId] });
    instId = inst.id;
    await s.api('PUT', `/cams-instances/${inst.id}/routes/${p.proxyId}`, { url: null, hidden: false }); // routes are default-deny
  });
  afterAll(async () => {
    await px.client.stop('shutdown');
    await s.stop();
  });

  it('enrolls with a CAC1 code and pins the server key', async () => {
    const { code } = await s.api('POST', `/cams-instances/${instId}/enrollment-codes`, { lifetimeH: 1 });
    const k = await enrollCams(s.url, code, 'ref-test');
    expect(k).toMatchObject({ v: 1, instanceId: instId, keyId: expect.stringMatching(/^key_/), serverKeys: [s.built.signing.publicKeyB64], accounts: ['home'] });
    expect(k.serverKeyFingerprints).toEqual([fingerprint(s.built.signing.publicKeyB64)]);
    cams = new CamsTestClient({ url: s.url, instanceId: k.instanceId, keyId: k.keyId, privateKey: k.privateKey, serverKeys: k.serverKeys });
  });

  it('pulls 200 then 304, both answers verified; the snapshot signature verifies', async () => {
    const a = await cams.get('/cams/v1/config');
    expect([a.status, a.signatureOk]).toEqual([200, true]);
    const b = await cams.get('/cams/v1/config', { 'If-None-Match': a.headers.get('etag')! });
    expect([b.status, b.signatureOk, b.bytes.length]).toEqual([304, true, 0]);
    const snap = await cams.snapshot();
    expect(snap.accounts.map((x) => x.name)).toEqual(['home']);
  });

  it('registers a token hash, which becomes active; reports', async () => {
    const { token, hash } = generateToken();
    const r = await cams.post('/cams/v1/tokens', { v: 1, proxyId: px.proxyId, kind: 'client', hash });
    expect(r.status).toBe(201);
    await until(async () => (await cams.snapshot()).accounts[0].proxies[0].tokens.some((t) => t.id === r.json.tokenId && t.state === 'active'), 5000);
    expect(px.client.accepts(hash)).toBe(true);
    expect(token).toHaveLength(43);
    const rep = await cams.post('/cams/v1/report', { v: 1, mode: 'shadow', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: { accountId: px.accountId, differences: 0, items: [] }, tokens: { managed: 1, pending: 0, legacy: 0 }, problems: [] });
    expect(rep.json.changed).toBe(true);
  });

  it('corrects its clock from a signed clock_skew and retries once', async () => {
    const off = new CamsTestClient({ ...cams.options, clockOffsetMs: -3600_000 });
    const r = await off.get('/cams/v1/config');
    expect(r.status).toBe(200);
    expect(Math.abs(off.offsetMs)).toBeLessThan(5000); // corrected from -1 h
  });

  it('refuses an answer it cannot verify (another server key pinned)', async () => {
    const wrong = new CamsTestClient({ ...cams.options, serverKeys: [generateKeyPair().publicKeySpkiB64] });
    await expect(wrong.get('/cams/v1/config')).rejects.toThrow(/admin_answer_unsigned/);
    await expect(wrong.snapshot()).rejects.toThrow(/admin_answer_unsigned/);
  });
});
