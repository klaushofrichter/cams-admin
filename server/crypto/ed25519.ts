import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'crypto';

// Ed25519 with Node's crypto (no dependency). Public keys travel as base64
// SPKI DER (44 bytes), private keys as base64 PKCS#8 DER.

export interface KeyPairB64 { privateKeyPkcs8B64: string; publicKeySpkiB64: string }

export function generateKeyPair(): KeyPairB64 {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPkcs8B64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

// The fixed keys of contract/v1/vectors.json: PKCS#8 = this prefix + the seed.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export function keyFromSeed(seedHex: string): KeyPairB64 {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  return {
    privateKeyPkcs8B64: priv.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeySpkiB64: createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function publicFromB64(spkiB64: string): KeyObject {
  if (typeof spkiB64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(spkiB64)) throw new Error('public key: not base64');
  const der = Buffer.from(spkiB64, 'base64');
  if (der.length !== 44) throw new Error('public key: not an ed25519 SPKI DER (44 bytes)');
  const k = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('public key: not ed25519');
  return k;
}

export function privateFromB64(pkcs8B64: string): KeyObject {
  const k = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('private key: not ed25519');
  return k;
}

export const sign = (priv: KeyObject, text: string): string => nodeSign(null, Buffer.from(text, 'utf8'), priv).toString('base64');

export function verify(pub: KeyObject, text: string, sigB64: unknown): boolean {
  if (typeof sigB64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sigB64)) return false;
  try {
    return nodeVerify(null, Buffer.from(text, 'utf8'), pub, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export const fingerprint = (spkiB64: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase();

// The signed strings of spec §8.2 and §8.3. `code` is the canonical dashed
// upper-case form; `nonce` is base64url of 32 random bytes.
export const signedText = {
  enroll: (code: string, publicKey: string) => `cams-admin enroll v1\n${code}\n${publicKey}`,
  challenge: (connId: string, nonce: string, serverTime: number) => `cams-admin/v1 challenge\n${connId}\n${nonce}\n${serverTime}`,
  hello: (connId: string, nonce: string, proxyId: string, keyId: string, ts: number) => `cams-admin/v1 hello\n${connId}\n${nonce}\n${proxyId}\n${keyId}\n${ts}`,
};
