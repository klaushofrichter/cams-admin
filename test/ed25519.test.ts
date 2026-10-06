import { describe, expect, it } from 'vitest';
import { createPrivateKey, generateKeyPairSync } from 'crypto';
import { fingerprint, generateKeyPair, keyFromSeed, privateFromB64, publicFromB64, sign, signedText, verify } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';

describe('ed25519', () => {
  it('signs and verifies', () => {
    const k = generateKeyPair();
    const priv = privateFromB64(k.privateKeyPkcs8B64);
    const pub = publicFromB64(k.publicKeySpkiB64);
    const sig = sign(priv, 'hello');
    expect(verify(pub, 'hello', sig)).toBe(true);
    expect(verify(pub, 'hellO', sig)).toBe(false);
    expect(verify(publicFromB64(generateKeyPair().publicKeySpkiB64), 'hello', sig)).toBe(false);
    expect(verify(pub, 'hello', 'not base64!')).toBe(false);
  });

  it('public keys are 44-byte SPKI DER', () => {
    expect(Buffer.from(generateKeyPair().publicKeySpkiB64, 'base64')).toHaveLength(44);
  });

  it('refuses a non-Ed25519 key and garbage', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(() => publicFromB64(ec)).toThrow(/ed25519/);
    expect(() => publicFromB64('AAAA')).toThrow();
    expect(() => publicFromB64(42 as unknown as string)).toThrow();
  });

  it('fingerprints are SHA256: and 64 upper-case hex characters', () => {
    expect(fingerprint(generateKeyPair().publicKeySpkiB64)).toMatch(/^SHA256:[0-9A-F]{64}$/);
  });

  it('keys from a seed are reproducible', () => {
    const a = keyFromSeed('00'.repeat(32));
    expect(a).toEqual(keyFromSeed('00'.repeat(32)));
    expect(createPrivateKey({ key: Buffer.from(a.privateKeyPkcs8B64, 'base64'), format: 'der', type: 'pkcs8' }).asymmetricKeyType).toBe('ed25519');
  });

  it('builds the signed strings of spec §8.2 and §8.3', () => {
    expect(signedText.enroll('CAE1-AAAA-BBBB-CCCC-DDDD-EEEE', 'PK')).toBe('cams-admin enroll v1\nCAE1-AAAA-BBBB-CCCC-DDDD-EEEE\nPK');
    expect(signedText.challenge('con_1', 'n', 5)).toBe('cams-admin/v1 challenge\ncon_1\nn\n5');
    expect(signedText.hello('con_1', 'n', 'prx_1', 'key_1', 7)).toBe('cams-admin/v1 hello\ncon_1\nn\nprx_1\nkey_1\n7');
  });

  it('reproduces contract/v1/vectors.json byte for byte', () => {
    const keys = Object.fromEntries(Object.entries(vectors.keys).map(([n, k]) => [n, keyFromSeed(k.seedHex)]));
    for (const [n, k] of Object.entries(vectors.keys)) {
      expect(keys[n].publicKeySpkiB64).toBe(k.publicKey);
      expect(keys[n].privateKeyPkcs8B64).toBe(k.privateKey);
      expect(fingerprint(k.publicKey)).toBe(k.fingerprint);
    }
    expect(vectors.signatures.length).toBeGreaterThanOrEqual(3);
    for (const v of vectors.signatures) {
      const text = v.kind === 'enroll' ? signedText.enroll(v.args[0] as string, v.args[1] as string)
        : v.kind === 'challenge' ? signedText.challenge(v.args[0] as string, v.args[1] as string, v.args[2] as number)
        : signedText.hello(v.args[0] as string, v.args[1] as string, v.args[2] as string, v.args[3] as string, v.args[4] as number);
      expect(text).toBe(v.text);
      expect(sign(privateFromB64(keys[v.key].privateKeyPkcs8B64), text)).toBe(v.sig);
      expect(verify(publicFromB64(keys[v.key].publicKeySpkiB64), text, v.sig)).toBe(true);
    }
  });
});
