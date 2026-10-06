import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { fingerprint } from './ed25519';

// cams-admin's own Ed25519 key (spec §10): a PKCS#8 PEM file, mode 600, from
// the cams-admin-signing Secret. In process memory only, never in the
// database. A file readable by group or others is refused.
export interface SigningKey { key: KeyObject; publicKeyB64: string; fingerprint: string }

export function loadSigningKey(file: string | null): SigningKey {
  if (!file) throw new Error('config: SERVER_SIGNING_KEY_FILE is required (scripts/gen-signing-key.ts makes one)');
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`signing key ${file} is readable by group or others (chmod 600)`);
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('signing key: not ed25519');
  const publicKeyB64 = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  return { key, publicKeyB64, fingerprint: fingerprint(publicKeyB64) };
}
