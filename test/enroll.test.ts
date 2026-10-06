import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { join } from 'path';
import { openDb } from '../server/db/open';
import { Audit } from '../server/audit';
import { Registry } from '../server/registry';
import { Enrollment } from '../server/enroll/codes';
import { enrollRouter } from '../server/enroll/route';
import { loadConfig } from '../server/config';
import { fingerprint, generateKeyPair, privateFromB64, sign, signedText } from '../server/crypto/ed25519';
import { normaliseCode } from '../server/ids';
import { tmpDir } from './helpers/tmp';
import { fakeClock } from './helpers/clock';

const ACTOR = 'admin@example.com';
let n = 0;

function setup(dir: string) {
  const db = openDb(join(dir, `e${n++}.db`));
  const clock = fakeClock();
  const audit = new Audit(db, clock);
  const reg = new Registry(db, clock, audit);
  const cfg = loadConfig({ PUBLIC_URL: 'https://cams-admin.example.net' });
  const server = generateKeyPair();
  const revoked: string[] = [];
  const enr = new Enrollment({ db, clock, audit, registry: reg, cfg, serverKeys: [server.publicKeySpkiB64], onKeyRevoked: (k) => revoked.push(k) });
  const app = express();
  app.use(enrollRouter(enr));
  const acc = reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const prx = reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
  return { db, clock, audit, reg, enr, app, acc, prx, revoked, server };
}

// The proof covers the canonical code, whatever spelling is sent.
function body(code: string, k = generateKeyPair(), proofKey = k) {
  return { v: 1, code, publicKey: k.publicKeySpkiB64, proof: sign(privateFromB64(proofKey.privateKeyPkcs8B64), signedText.enroll(normaliseCode(code) ?? code, k.publicKeySpkiB64)), proxy: { version: 'v2026.10.06.1', cameraIds: ['cam1'] } };
}
const post = (app: express.Express, b: unknown, xff?: string) => {
  const r = request(app).post('/proxy/v1/enroll').set('Content-Type', 'application/json');
  if (xff) r.set('X-Forwarded-For', xff);
  return r.send(JSON.stringify(b));
};

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

  it('re-enrollment revokes the old key and reports it', async () => {
    const s = setup(dir);
    const first = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    const second = await post(s.app, body(s.enr.createCode(ACTOR, s.acc.id, s.prx.id, 24).code));
    expect(second.status).toBe(201);
    expect(s.revoked).toEqual([first.body.keyId]);
    const keys = s.reg.listKeys(s.acc.id, s.prx.id);
    expect(keys.find((k) => k.id === first.body.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
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
