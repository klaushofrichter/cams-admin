import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { CamsEnrollment } from '../server/cams/enroll';
import { CamsInstances } from '../server/cams/instances';
import { camsRouter } from '../server/cams/routes';
import { loadConfig } from '../server/config';
import { fingerprint, generateKeyPair, privateFromB64, sign, signedText } from '../server/crypto/ed25519';
import { newEnrollmentCode, normaliseCamsCode, normaliseCode } from '../server/ids';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';
import { startServer, type Running } from './helpers/server';

const INTERNAL = 'http://cams-admin.cams-admin.svc.cluster.local:8080';
const PUB = 'https://cams-admin.example.net';

function setup(dir: string, env: Record<string, string> = {}) {
  const { db, clock, audit, reg } = makeRegistry(dir);
  const cfg = loadConfig({ PUBLIC_URL: PUB, ...env });
  const server = generateKeyPair();
  const fp = fingerprint(server.publicKeySpkiB64);
  const instances = new CamsInstances({ db, clock, audit, registry: reg, cfg, serverKeys: [server.publicKeySpkiB64], serverKeyFingerprints: [fp], onRevoke: () => {} });
  const enr = new CamsEnrollment({ db, clock, audit, instances, cfg, serverKeys: [server.publicKeySpkiB64], serverKeyFingerprints: [fp] });
  const app = express();
  app.set('trust proxy', 1);
  app.use(camsRouter({ enrollment: enr }));
  const acc = reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const inst = instances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [acc.id] });
  return { db, clock, audit, reg, instances, enr, app, acc, inst, server, fp };
}

function body(code: string, k = generateKeyPair(), text: 'cams' | 'proxy' = 'cams') {
  const canonical = normaliseCamsCode(code) ?? normaliseCode(code) ?? code;
  const t = text === 'cams' ? signedText.camsEnroll(canonical, k.publicKeySpkiB64) : signedText.enroll(canonical, k.publicKeySpkiB64);
  return { v: 1, code, publicKey: k.publicKeySpkiB64, proof: sign(privateFromB64(k.privateKeyPkcs8B64), t), camsVersion: 'test' };
}
const post = (app: express.Express, b: unknown, headers: Record<string, string> = {}) => {
  const r = request(app).post('/cams/v1/enroll').set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send(JSON.stringify(b));
};

describe('cams enrollment (POST /cams/v1/enroll)', () => {
  const dir = tmpDir();

  describe('on the real server', () => {
    let s: Running;
    beforeAll(async () => { s = await startServer(dir); });
    afterAll(() => s.stop());

    it('redeems a CAC1 code once: 201 with instance, key, served account names, server keys and fingerprints; key pending', async () => {
      const acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
      const inst = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [acc.id] });
      const { code } = await s.api('POST', `/cams-instances/${inst.id}/enrollment-codes`, { lifetimeH: 1 });
      const b = body(code);
      const r = await fetch(`${s.url}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const j = await r.json();
      expect(j).toEqual({ v: 1, instanceId: inst.id, instanceName: 'cluster', keyId: expect.stringMatching(/^key_/), accounts: ['home'], serverKeys: [s.built.signing.publicKeyB64], serverKeyFingerprints: [s.built.signing.fingerprint], apiUrl: s.url });
      expect(s.built.camsInstances.keys(inst.id)[0]).toMatchObject({ id: j.keyId, confirmedAt: null, fingerprint: fingerprint(b.publicKey) });
      expect(s.built.camsInstances.get(inst.id).state).toBe('pending');
      expect((await fetch(`${s.url}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status).toBe(401); // used
      // A cams code at the proxy endpoint: invalid_code.
      const c2 = await s.api('POST', `/cams-instances/${inst.id}/enrollment-codes`, { lifetimeH: 1 });
      const px = await fetch(`${s.url}/proxy/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(c2.code), proxy: { version: 't', cameraIds: [] } }) });
      expect([px.status, (await px.json()).error]).toEqual([401, 'invalid_code']);
      const audit = s.built.audit.list({ action: 'cams-enrolled' }).items[0];
      expect(audit).toMatchObject({ actorType: 'cams', actor: inst.id });
      expect(JSON.stringify(s.built.audit.list({ limit: 200 }))).not.toContain(code.slice(5));
    });
  });

  it('a proxy code (CAE1) at /cams/v1/enroll: 401 invalid_code', async () => {
    const s = setup(dir);
    const r = await post(s.app, body(newEnrollmentCode()));
    expect([r.status, r.body.error]).toEqual([401, 'invalid_code']);
  });

  it('a proof made with the proxy enroll text is bad_proof', async () => {
    const s = setup(dir);
    const c = s.instances.createCode(ACTOR, s.inst.id, 1);
    const r = await post(s.app, body(c.code, generateKeyPair(), 'proxy'));
    expect([r.status, r.body.error]).toEqual([400, 'bad_proof']);
  });

  it('malformed, oversize: 400 bad_request', async () => {
    const s = setup(dir);
    const c = s.instances.createCode(ACTOR, s.inst.id, 1);
    expect((await post(s.app, { v: 1, code: c.code })).status).toBe(400);
    expect((await post(s.app, { ...body(c.code), camsVersion: 'x'.repeat(10_000) })).status).toBe(413);
    expect((await request(s.app).post('/cams/v1/enroll').set('Content-Type', 'application/json').send('{nope')).status).toBe(400);
  });

  it('a key already used by a proxy or another instance is refused', async () => {
    const s = setup(dir);
    const k = generateKeyPair();
    const px = s.reg.createProxy(ACTOR, s.acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    s.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at) VALUES ('key_00000000000000000001', ?, ?, 'fp', 1)`).run(px.id, k.publicKeySpkiB64);
    const c = s.instances.createCode(ACTOR, s.inst.id, 1);
    const r = await post(s.app, body(c.code, k));
    expect([r.status, r.body.error]).toEqual([400, 'bad_request']);
  });

  it('expired, cancelled, blocked instance: the same 401 invalid_code; audited cams-enroll-refused (throttled)', async () => {
    const s = setup(dir);
    const expired = s.instances.createCode(ACTOR, s.inst.id, 1);
    s.clock.advance(3600_000);
    const a = await post(s.app, body(expired.code));
    const cancelled = s.instances.createCode(ACTOR, s.inst.id, 1);
    s.instances.cancelCode(ACTOR, s.inst.id, cancelled.id);
    const b = await post(s.app, body(cancelled.code));
    const live = s.instances.createCode(ACTOR, s.inst.id, 24);
    s.db.prepare(`UPDATE cams_instances SET state = 'revoked' WHERE id = ?`).run(s.inst.id);
    const c = await post(s.app, body(live.code));
    for (const r of [a, b, c]) expect([r.status, r.body]).toEqual([401, { error: 'invalid_code' }]);
    expect(s.audit.list({ action: 'cams-enroll-refused' }).items.length).toBeGreaterThan(0);
    expect(s.audit.list({ action: 'cams-enroll-refused' }).items.every((x) => x.actorType === 'cams')).toBe(true);
  });

  it('re-enrolling retires the older pending key (one pending key per instance)', async () => {
    const s = setup(dir);
    for (let i = 0; i < 2; i++) expect((await post(s.app, body(s.instances.createCode(ACTOR, s.inst.id, 1).code))).status).toBe(201);
    const keys = s.instances.keys(s.inst.id);
    expect(keys.filter((k) => k.revokedAt === null)).toHaveLength(1);
    expect(keys.find((k) => k.revokedAt !== null)?.revokedReason).toBe('re-enrolled');
  });

  it('per-code and global limits answer 429 with retryAfterS, never keyed on the address', async () => {
    const s = setup(dir);
    const c = s.instances.createCode(ACTOR, s.inst.id, 24);
    const bad = { ...body(c.code), proof: body(c.code).proof.replace(/^./, 'Z') };
    for (let i = 0; i < 5; i++) expect((await post(s.app, bad, { 'X-Forwarded-For': `198.51.100.${i}` })).status).toBe(400);
    const sixth = await post(s.app, body(c.code), { 'X-Forwarded-For': '203.0.113.99' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.retryAfterS).toBeGreaterThan(0);
    for (let i = 0; i < 94; i++) await post(s.app, body(`CAC1-0000-0000-0000-0000-${String(i).padStart(4, '0').replace(/[89]/g, '7')}`), { 'X-Forwarded-For': `192.0.2.${i}` });
    const r = await post(s.app, body('CAC1-1111-1111-1111-1111-1111'), { 'X-Forwarded-For': '192.0.2.250' });
    expect(r.status).toBe(429);
  });

  it('apiUrl: the request origin when allow-listed (INTERNAL_URLS), else PUBLIC_URL', async () => {
    const s = setup(dir, { INTERNAL_URLS: INTERNAL });
    const enrollWith = async (headers: Record<string, string>) => (await post(s.app, body(s.instances.createCode(ACTOR, s.inst.id, 1).code), headers)).body.apiUrl;
    expect(await enrollWith({ Host: 'cams-admin.cams-admin.svc.cluster.local:8080' })).toBe(INTERNAL);
    expect(await enrollWith({ Host: 'cams-admin.example.net', 'X-Forwarded-Proto': 'https' })).toBe(PUB);
    expect(await enrollWith({ Host: 'evil.example.org' })).toBe(PUB);
  });
});
