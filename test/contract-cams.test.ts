import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { camsRequestText, camsResponseText, keyFromSeed, privateFromB64, publicFromB64, sha256hex, sign, signedText, signEnvelope, verify, verifyEnvelope } from '../server/crypto/ed25519';
import { jcs } from '../server/crypto/jcs';
import { validateCams, CAMS_SCHEMAS } from '../server/contract';
import { buildCamsSchemas, camsFixtures, TRUST_FIELDS } from '../contract/cams-build';
import vectors from '../contract/cams-v1/vectors.json';
import { strictCamsValidator } from './helpers/contract';

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
  });
});
