import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Enrollment, PENDING_KEY_MS } from '../server/enroll/codes';
import { enrollRouter } from '../server/enroll/route';
import { loadConfig } from '../server/config';
import { fingerprint, generateKeyPair, privateFromB64, sign, signedText } from '../server/crypto/ed25519';
import { normaliseCode } from '../server/ids';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';

const INTERNAL = 'http://cams-admin.cams-admin.svc.cluster.local:8080';
function setup(dir: string, env: Record<string, string> = {}, trustProxy: number | false = 1) {
  const { db, clock, audit, reg } = makeRegistry(dir);
  const cfg = loadConfig({ PUBLIC_URL: 'https://cams-admin.example.net', ...env });
  const server = generateKeyPair();
  const revoked: string[] = [];
  const enr = new Enrollment({ db, clock, audit, registry: reg, cfg, serverKeys: [server.publicKeySpkiB64], onKeyRevoked: (k) => revoked.push(k) });
  const app = express();
  app.set('trust proxy', trustProxy); // as server.ts (TRUST_PROXY)
  app.use(enrollRouter(enr));
  const acc = reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const prx = reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
  return { db, clock, audit, reg, enr, app, acc, prx, revoked, server };
}

// The proof covers the canonical code, whatever spelling is sent.
function body(code: string, k = generateKeyPair(), proofKey = k) {
  return { v: 1, code, publicKey: k.publicKeySpkiB64, proof: sign(privateFromB64(proofKey.privateKeyPkcs8B64), signedText.enroll(normaliseCode(code) ?? code, k.publicKeySpkiB64)), proxy: { version: 'v2026.10.06.1', cameraIds: ['cam1'] } };
}
const post = (app: express.Express, b: unknown, xff?: string, headers: Record<string, string> = {}) => {
  const r = request(app).post('/proxy/v1/enroll').set('Content-Type', 'application/json');
  if (xff) r.set('X-Forwarded-For', xff);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send(JSON.stringify(b));
};
const hdr = (host: string, extra: Record<string, string> = {}) => ({ Host: host, ...extra });

describe('enrollment', () => {
  const dir = tmpDir();

  it('redeems a code once: 201 with the connect data, the key stored, audited', async () => {
    const s = setup(dir);
    const c = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    expect(c.command).toBe('docker compose exec cam-proxy node dist/src/cli.js admin-enroll --url https://cams-admin.example.net');
    const k = generateKeyPair();
    const r = await post(s.app, body(c.code.toLowerCase().replace(/-/g, ' '), k));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ v: 1, proxyId: s.prx.id, account: 'home', connectUrl: 'wss://cams-admin.example.net/proxy/v1/connect', serverKeys: [s.server.publicKeySpkiB64], heartbeatS: 30 });
    expect(r.body.keyId).toMatch(/^key_/);
    expect(s.reg.getProxy(s.acc.id, s.prx.id).state).toBe('pending');
    expect(s.enr.confirmKey(s.prx.id, r.body.keyId)).toEqual({ revoked: [] }); // the first hello
    expect(s.reg.getProxy(s.acc.id, s.prx.id).state).toBe('enrolled');
    expect(s.reg.activeKey(s.prx.id)).toMatchObject({ id: r.body.keyId, fingerprint: fingerprint(k.publicKeySpkiB64) });
    const a = s.audit.list({ action: 'proxy-enrolled' }).items[0];
    expect(a).toMatchObject({ actorType: 'proxy', actor: s.prx.id, detail: { keyId: r.body.keyId, fingerprint: fingerprint(k.publicKeySpkiB64) } });
    expect(JSON.stringify(s.audit.list({}).items)).not.toContain(c.code);
    const again = await post(s.app, body(c.code));
    expect(again.status).toBe(401);
  });

  it('answers unknown, used, expired and cancelled codes identically', async () => {
    const s = setup(dir);
    const used = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 1);
    expect((await post(s.app, body(used.code))).status).toBe(201);
    const p2 = s.reg.createProxy(ACTOR, s.acc.id, { name: 'p2', displayName: 'P2', runsOn: 'cloud' });
    const expired = s.enr.createCode(ACTOR, s.acc.id, p2.id, 1);
    const p3 = s.reg.createProxy(ACTOR, s.acc.id, { name: 'p3', displayName: 'P3', runsOn: 'cloud' });
    const cancelled = s.enr.createCode(ACTOR, s.acc.id, p3.id, 24);
    s.enr.cancelCode(ACTOR, s.acc.id, p3.id, cancelled.id);
    s.clock.advance(3600_000); // exactly expires_at of the 1 h code
    const answers = await Promise.all(['CAE1-0000-0000-0000-0000-0000', used.code, expired.code, cancelled.code].map((c) => post(s.app, body(c))));
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.body).toEqual({ error: 'invalid_code' });
    }
  });

  it('a code of a blocked proxy is dead', async () => {
    const s = setup(dir);
    const c = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    s.db.prepare(`UPDATE proxies SET state='revoked' WHERE id=?`).run(s.prx.id); // blocked after the code was made
    expect((await post(s.app, body(c.code))).status).toBe(401);
  });

  it('bad proof, proof for another key, bad version, malformed, oversize', async () => {
    const s = setup(dir);
    const c = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    const b = body(c.code);
    expect((await post(s.app, { ...b, proof: b.proof.replace(/^./, b.proof[0] === 'A' ? 'B' : 'A') })).body).toEqual({ error: 'bad_proof' });
    expect((await post(s.app, body(c.code, generateKeyPair(), generateKeyPair()))).body).toEqual({ error: 'bad_proof' });
    expect((await post(s.app, { ...b, v: 2 })).body).toEqual({ error: 'unsupported_version' });
    expect((await post(s.app, { v: 1 })).status).toBe(400);
    const big = await post(s.app, { ...b, pad: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    // The code survived all of that.
    expect((await post(s.app, body(c.code))).status).toBe(201);
  });

  it('two concurrent redemptions: exactly one 201', async () => {
    const s = setup(dir);
    const c = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    const r = await Promise.all([post(s.app, body(c.code)), post(s.app, body(c.code))]);
    expect(r.map((x) => x.status).sort()).toEqual([201, 401]);
  });

  it('re-enrollment keeps the working key until the new key says hello', async () => {
    const s = setup(dir);
    const first = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    s.enr.confirmKey(s.prx.id, first.body.keyId);
    const second = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    expect(second.status).toBe(201);
    expect(s.revoked).toEqual([]);
    expect(s.reg.activeKey(s.prx.id)?.id).toBe(first.body.keyId);
    // The new key's first hello: the old key goes, and its connection is closed.
    expect(s.enr.confirmKey(s.prx.id, second.body.keyId)).toEqual({ revoked: [first.body.keyId] });
    expect(s.revoked).toEqual([first.body.keyId]);
    expect(s.reg.activeKey(s.prx.id)?.id).toBe(second.body.keyId);
    const keys = s.reg.listKeys(s.acc.id, s.prx.id);
    expect(keys.find((k) => k.id === first.body.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
    expect(s.audit.list({ action: 'key-confirmed' }).items[0]).toMatchObject({ actor: s.prx.id, detail: { keyId: second.body.keyId, replacedKeys: [first.body.keyId] } });
  });

  it('orphan key: an answer the proxy never used leaves a pending key that blocks nothing and expires', async () => {
    const s = setup(dir);
    const lost = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    expect(lost.status).toBe(201);
    // Redeemed, but no hello yet: the key is pending, the proxy is not enrolled.
    expect(s.reg.getProxy(s.acc.id, s.prx.id).state).toBe('pending');
    expect(s.reg.activeKey(s.prx.id)).toBeNull();
    expect(s.reg.listKeys(s.acc.id, s.prx.id)[0]).toMatchObject({ id: lost.body.keyId, confirmedAt: null, revokedAt: null, pending: 'waiting' });
    s.clock.advance(PENDING_KEY_MS);
    expect(s.reg.listKeys(s.acc.id, s.prx.id)[0]).toMatchObject({ id: lost.body.keyId, pending: 'expired' });
    expect(s.enr.confirmKey(s.prx.id, lost.body.keyId)).toBeNull(); // too late for a hello
    // A new code works and retires the orphan.
    const again = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    expect(again.status).toBe(201);
    expect(s.reg.listKeys(s.acc.id, s.prx.id).find((k) => k.id === lost.body.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
    expect(s.enr.confirmKey(s.prx.id, again.body.keyId)).toEqual({ revoked: [] });
    expect(s.reg.getProxy(s.acc.id, s.prx.id).state).toBe('enrolled');
    expect(s.reg.activeKey(s.prx.id)?.id).toBe(again.body.keyId);
  });

  describe('connectUrl on the origin the proxy used', () => {
    const PUB = 'wss://cams-admin.example.net/proxy/v1/connect';
    const INT = 'ws://cams-admin.cams-admin.svc.cluster.local:8080/proxy/v1/connect';
    const enrollWith = async (s: ReturnType<typeof setup>, headers: Record<string, string>) => {
      const r = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code), undefined, headers);
      expect(r.status).toBe(201);
      return r.body.connectUrl as string;
    };

    it('an allowlisted in-cluster origin (direct, no forwarded headers) gets its own origin', async () => {
      const s = setup(dir, { INTERNAL_URLS: INTERNAL });
      expect(await enrollWith(s, hdr('cams-admin.cams-admin.svc.cluster.local:8080'))).toBe(INT);
    });

    it('the public origin (behind Traefik) gets PUBLIC_URL', async () => {
      const s = setup(dir, { INTERNAL_URLS: INTERNAL });
      expect(await enrollWith(s, hdr('cams-admin.example.net', { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cams-admin.example.net' }))).toBe(PUB);
      expect(await enrollWith(s, hdr('cams-admin.example.net', { 'X-Forwarded-Proto': 'https' }))).toBe(PUB);
    });

    it('an unknown Host is never reflected: PUBLIC_URL', async () => {
      const s = setup(dir, { INTERNAL_URLS: INTERNAL });
      expect(await enrollWith(s, hdr('evil.example.org'))).toBe(PUB);
      expect(await enrollWith(s, hdr('evil.example.org', { 'X-Forwarded-Proto': 'https' }))).toBe(PUB);
      expect(await enrollWith(s, hdr('cams-admin.cams-admin.svc.cluster.local:8081'))).toBe(PUB);
      expect(await enrollWith(s, hdr('cams-admin.cams-admin.svc.cluster.local:8080', { 'X-Forwarded-Proto': 'https' }))).toBe(PUB); // https is not the allowlisted origin
      expect(await enrollWith(s, hdr('[::1'))).toBe(PUB);
    });

    it('without INTERNAL_URLS the in-cluster origin gets PUBLIC_URL (as before)', async () => {
      const s = setup(dir);
      expect(await enrollWith(s, hdr('cams-admin.cams-admin.svc.cluster.local:8080'))).toBe(PUB);
    });

    it('forwarded headers count only as TRUST_PROXY says', async () => {
      const fwd = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cams-admin.example.net' };
      // Trusted (TRUST_PROXY=1, Traefik in front): the forwarded origin is the one used.
      expect(await enrollWith(setup(dir, { INTERNAL_URLS: INTERNAL }, 1), hdr('cams-admin.cams-admin.svc.cluster.local:8080', fwd))).toBe(PUB);
      // Not trusted (TRUST_PROXY=0): only the request's own Host and scheme.
      expect(await enrollWith(setup(dir, { INTERNAL_URLS: INTERNAL }, false), hdr('cams-admin.cams-admin.svc.cluster.local:8080', fwd))).toBe(INT);
      expect(await enrollWith(setup(dir, { INTERNAL_URLS: INTERNAL }, false), hdr('cams-admin.example.net', fwd))).toBe(PUB); // http://… is not allowlisted: the fallback
    });

    it('PROXY_CONNECT_URL still decides the public answer', async () => {
      const s = setup(dir, { INTERNAL_URLS: INTERNAL, PROXY_CONNECT_URL: 'https://ws.example.net' });
      expect(await enrollWith(s, hdr('cams-admin.example.net', { 'X-Forwarded-Proto': 'https' }))).toBe('wss://ws.example.net/proxy/v1/connect');
      expect(await enrollWith(s, hdr('cams-admin.cams-admin.svc.cluster.local:8080'))).toBe(INT);
    });
  });

  it('a new code cancels the live one', () => {
    const s = setup(dir);
    const a = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    expect(s.db.prepare('SELECT cancelled_at FROM enrollment_codes WHERE id=?').get(a.id)).not.toEqual({ cancelled_at: null });
  });

  it('limits 5 attempts per code and 100 in total, never by address', async () => {
    const s = setup(dir);
    const c = s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24);
    const bad = { ...body(c.code), proof: body(c.code).proof.replace(/^./, 'Z') };
    for (let i = 0; i < 5; i++) expect((await post(s.app, bad, `198.51.100.${i}`)).status).toBe(400);
    const sixth = await post(s.app, body(c.code), '203.0.113.99');
    expect(sixth.status).toBe(429);
    expect(sixth.body.retryAfterS).toBeGreaterThan(0);
    for (let i = 0; i < 94; i++) await post(s.app, body(`CAE1-0000-0000-0000-0000-${String(i).padStart(4, '0').replace(/[89]/g, '7')}`), `192.0.2.${i}`);
    const r = await post(s.app, body('CAE1-1111-1111-1111-1111-1111'), '192.0.2.250');
    expect(r.status).toBe(429);
    // Refusals were audited, throttled.
    expect(s.audit.list({ action: 'enroll-refused' }).items.length).toBeLessThan(10);
  });
});
