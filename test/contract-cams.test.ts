import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { camsRequestText, camsResponseText, keyFromSeed, privateFromB64, publicFromB64, sha256hex, sign, signedText, signEnvelope, verify, verifyEnvelope } from '../server/crypto/ed25519';
import { jcs } from '../server/crypto/jcs';
import { validateCams, CAMS_SCHEMAS } from '../server/contract';
import { buildCamsSchemas, camsFixtures, TRUST_FIELDS } from '../contract/cams-build';
import vectors from '../contract/cams-v1/vectors.json';
import { strictCamsValidator, strictCamsErrors } from './helpers/contract';

const ROOT = join(__dirname, '../contract/cams-v1');
const DIR = join(ROOT, 'fixtures');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fixtures = readdirSync(DIR).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
const priv = (k: 'server' | 'cams' | 'other') => privateFromB64(keyFromSeed(vectors.keys[k].seedHex).privateKeyPkcs8B64);

describe('cams-v1 contract', () => {
  it('committed schemas and fixtures equal a fresh build (run npm run contract:make)', () => {
    for (const mode of ['lenient', 'strict'] as const) {
      const dir = mode === 'strict' ? join(ROOT, 'strict') : ROOT;
      const built = buildCamsSchemas(mode);
      expect(Object.keys(built).sort()).toEqual([...CAMS_SCHEMAS].sort());
      for (const [name, s] of Object.entries(built)) expect(read(join(dir, `${name}.schema.json`)), `${mode} ${name}`).toEqual(s);
    }
    const fresh = camsFixtures();
    expect(fixtures.map((f) => f.name).sort()).toEqual(Object.keys(fresh).sort());
    for (const [name, f] of Object.entries(fresh)) expect(read(join(DIR, `${name}.json`)), name).toEqual(JSON.parse(JSON.stringify(f)));
  });
  it('lists the fixtures the contract names', () => {
    for (const n of ['valid-snapshot-two-accounts', 'valid-snapshot-empty', 'valid-tokens-request', 'valid-report-shadow', 'valid-report-cams-admin', 'valid-enroll-request',
      'valid-enroll-response', 'invalid-snapshot-secret-field', 'invalid-snapshot-bad-camsid', 'invalid-snapshot-unsigned', 'invalid-tokens-request-upper-hex',
      'invalid-report-value-in-items', 'drift-snapshot-new-field']) expect(fixtures.map((f) => f.name), n).toContain(n);
    expect(TRUST_FIELDS).toEqual(['proxyUrl', 'caFingerprints', 'proxyTlsServername', 'host', 'protocol', 'tlsServername']);
  });
  it('valid-* pass lenient and strict; invalid-* fail strict; drift-* pass lenient only', () => {
    for (const f of fixtures) {
      const strict = strictCamsValidator(f.schema)(f.message);
      const lenient = validateCams(f.schema, f.message).ok;
      if (f.name.startsWith('valid-')) expect([f.name, strict, lenient]).toEqual([f.name, true, true]);
      if (f.name.startsWith('invalid-')) expect([f.name, strict]).toEqual([f.name, false]);
      if (f.name.startsWith('drift-')) expect([f.name, strict, lenient]).toEqual([f.name, false, true]);
    }
  });
  it('request and response texts and signatures reproduce byte for byte', () => {
    expect(vectors.requests.length).toBe(3);
    for (const r of vectors.requests) {
      const body = Buffer.from(r.body, 'utf8');
      expect(sha256hex(body)).toBe(r.bodySha256);
      expect(camsRequestText(r.method, r.pathAndQuery, r.ts, r.nonce, body)).toBe(r.text);
      expect(sign(priv('cams'), r.text)).toBe(r.sig);
      expect(verify(publicFromB64(vectors.keys.cams.publicKey), r.text, r.sig)).toBe(true);
      expect(verify(publicFromB64(vectors.keys.other.publicKey), r.text, r.sig)).toBe(false);
    }
    expect(vectors.responses.length).toBe(3);
    for (const a of vectors.responses) {
      expect(sha256hex(Buffer.from(a.body, 'utf8'))).toBe(a.bodySha256);
      expect(camsResponseText(a.status, a.nonce, Buffer.from(a.body, 'utf8'))).toBe(a.text);
      expect(sign(priv('server'), a.text)).toBe(a.sig);
    }
    expect(vectors.responses.find((a) => a.status === 304)!.bodySha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('the snapshot signature is over jcs(snapshot without sig) and the enroll proof uses its own text', () => {
    for (const s of vectors.snapshots) {
      expect(jcs(s.snapshot)).toBe(s.text);
      expect(signEnvelope(priv('server'), s.snapshot)).toBe(s.sig);
      expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), { ...s.snapshot, sig: s.sig })).toBe(true);
    }
    const e = vectors.enroll[0];
    expect(signedText.camsEnroll(e.code, e.publicKey)).toBe(e.text);
    expect(e.text.startsWith('cams-admin cams-enroll v1\n')).toBe(true);
    expect(e.code.startsWith('CAC1-')).toBe(true);
    expect(sign(priv('cams'), e.text)).toBe(e.sig);
  });
  it('the signed fixtures verify with the vectors server key; the unsigned one does not', () => {
    const f = (n: string) => fixtures.find((x) => x.name === n)!;
    for (const n of ['valid-snapshot-two-accounts', 'valid-snapshot-empty']) expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), f(n).message), n).toBe(true);
    expect(f('invalid-snapshot-unsigned').message.sig).toBeUndefined();
  });
  it('no fixture or vector holds anything that looks like a token, a hash of one, or a password field', () => {
    // Only the token-hash requests may carry a hash, and only the "secret field" fixture a password.
    const rest = fixtures.filter((f) => !/tokens-request|invalid-snapshot-secret-field/.test(f.name));
    const all = JSON.stringify({ fixtures: rest, vectors: { ...vectors, requests: vectors.requests.filter((r) => !r.pathAndQuery.startsWith('/cams/v1/tokens')) } });
    expect(all).not.toMatch(/"password"|"token"\s*:|sha256:[0-9a-f]{64}/);
  });
  it('the vendored README carries the check order and the signed texts', () => {
    const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const s of ['cams-admin/v1 request', 'cams-admin/v1 response', 'cams-admin cams-enroll v1', 'Check order on cams-admin', 'clock_skew']) expect(md).toContain(s);
    // Security review 2026-10-07: routes default-deny (I1), per-instance failed-signature budgets (M1),
    // a per-holder token cap (M3), and the ETag header is not signed (info).
    for (const s of ['**only** the proxies with a route row for this instance', 'per named instance', 'held by this instance on this proxy', 'The `ETag` header is not covered by the signature']) expect(md).toContain(s);
  });
  it('camera moves: the snapshot proxy requires site and the camera requires moveId (both nullable) in strict, optional at run time', () => {
    const snap = structuredClone(fixtures.find((f) => f.name === 'valid-snapshot-two-accounts')!.message);
    const strict = strictCamsValidator('snapshot');
    const proxies = snap.accounts.flatMap((a: { proxies: Record<string, unknown>[] }) => a.proxies);
    const cameras = snap.accounts.flatMap((a: { cameras: Record<string, unknown>[] }) => a.cameras);
    expect(proxies.map((p: { site: unknown }) => p.site)).toEqual(expect.arrayContaining(['garage', null]));
    expect(cameras.map((c: { moveId: unknown }) => c.moveId)).toEqual(expect.arrayContaining(['mv_0123456789ABCDEFGHJK', null]));
    for (const [list, key] of [[proxies, 'site'], [cameras, 'moveId']] as const) {
      const keep = list[0][key];
      delete list[0][key];
      expect(strict(snap), `${key} missing`).toBe(false);
      expect(validateCams('snapshot', snap).ok, `${key} missing, run time`).toBe(true);
      list[0][key] = keep;
    }
  });
  it('move attestation: strict requires cameras[].move (nullable), lenient accepts it absent; the camera with a moveId carries one', () => {
    const snap = structuredClone(fixtures.find((f) => f.name === 'valid-snapshot-two-accounts')!.message);
    const strict = strictCamsValidator('snapshot');
    const cameras = snap.accounts.flatMap((a: { cameras: Record<string, unknown>[] }) => a.cameras);
    const held = cameras.find((c: { moveId: unknown }) => c.moveId !== null);
    expect(held.move).toEqual({ id: held.moveId, sourceProxyId: expect.stringMatching(/^prx_/), targetProxyId: expect.stringMatching(/^prx_/), expiresAt: expect.any(Number) });
    expect(cameras.filter((c: { move: unknown }) => c.move === null).length).toBeGreaterThan(0);
    expect(strict(snap), strictCamsErrors()).toBe(true);
    expect(validateCams('snapshot', snap).ok).toBe(true);
    const keep = cameras[0].move;
    delete cameras[0].move;
    expect(strict(snap), 'move missing').toBe(false);
    expect(validateCams('snapshot', snap).ok, 'move missing, run time').toBe(true);
    cameras[0].move = keep;
    const bad = [{ ...held.move, id: 'mv_0123456789ABCDEFGHJI' }, { ...held.move, sourceProxyId: 'cam_0123456789ABCDEFGHJK' }, { ...held.move, expiresAt: 1.5 }, { ...held.move, extra: 1 }, 'x'];
    for (const b of bad) { held.move = b; expect(strict(snap), JSON.stringify(b)).toBe(false); }
  });
  it('camera moves: site is null or ^[a-z0-9][a-z0-9-]{0,30}$ (X21, C14); moveId is null or mv_ + 20', () => {
    const snap = structuredClone(fixtures.find((f) => f.name === 'valid-snapshot-two-accounts')!.message);
    const strict = strictCamsValidator('snapshot');
    const proxy = snap.accounts[1].proxies[0];
    const camera = snap.accounts[1].cameras[0];
    for (const site of ['a', 'a'.repeat(31), 'garage-2', null]) { proxy.site = site; expect(strict(snap), String(site)).toBe(true); }
    for (const site of ['', 'a'.repeat(32), '-a', 'A', 'a_b', 'a.b']) { proxy.site = site; expect(strict(snap), site).toBe(false); expect(validateCams('snapshot', snap).ok, site).toBe(false); }
    proxy.site = null;
    for (const moveId of ['mv_0123456789ABCDEFGHJI', 'mv_0123456789abcdefghjk', 'cam_0123456789ABCDEFGHJK', '']) { camera.moveId = moveId; expect(strict(snap), moveId).toBe(false); }
  });
  it('camera moves: report heldProxies is optional, at most 64 entries, each exactly {accountId, proxyId, fields}', () => {
    const rep = structuredClone(fixtures.find((f) => f.name === 'valid-report-cams-admin')!.message);
    const strict = strictCamsValidator('report-request');
    expect(strict(rep)).toBe(true); // heldProxies absent
    const entry = { accountId: 'acc_00000000000000000001', proxyId: 'prx_00000000000000000001', fields: ['proxyUrl', 'caFingerprints', 'proxyTlsServername'] };
    rep.heldProxies = [entry];
    expect(strict(rep)).toBe(true);
    expect(validateCams('report-request', rep).ok).toBe(true);
    rep.heldProxies = Array.from({ length: 64 }, () => entry);
    expect(strict(rep)).toBe(true);
    rep.heldProxies = Array.from({ length: 65 }, () => entry);
    expect(strict(rep)).toBe(false);
    for (const bad of [{ ...entry, fields: ['host'] }, { ...entry, fields: [] }, { ...entry, fields: ['proxyUrl', 'proxyUrl'] }, { ...entry, extra: 1 }, { accountId: entry.accountId, fields: entry.fields }, { ...entry, proxyId: 'cam1' }]) {
      rep.heldProxies = [bad];
      expect(strict(rep), JSON.stringify(bad)).toBe(false);
    }
  });
  it('camera moves: a fixture carries heldProxies', () => {
    expect(fixtures.find((f) => f.name === 'valid-report-cams-admin')!.message.heldProxies).toHaveLength(1);
  });
});
