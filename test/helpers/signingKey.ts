import { chmodSync, writeFileSync } from 'fs';
import { generateKeyPair } from '../../server/crypto/ed25519';

// A fresh cams-admin signing key as a mode-600 PKCS#8 PEM file.
export function writeSigningKey(file: string): string {
  writeFileSync(file, `-----BEGIN PRIVATE KEY-----\n${generateKeyPair().privateKeyPkcs8B64}\n-----END PRIVATE KEY-----\n`);
  chmodSync(file, 0o600);
  return file;
}
