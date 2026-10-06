// npx tsx scripts/gen-signing-key.ts FILE: a new Ed25519 signing key for
// cams-admin (PKCS#8 PEM, mode 600). Prints only the public fingerprint.
// Replacing the production key means re-enrolling every proxy (spec §10).
import { generateKeyPairSync } from 'crypto';
import { existsSync, writeFileSync } from 'fs';
import { fingerprint } from '../server/crypto/ed25519';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: gen-signing-key.ts FILE\n');
  process.exit(1);
}
if (existsSync(file) && !process.argv.includes('--force')) {
  process.stderr.write(`${file} exists (--force to replace it: every proxy must then re-enroll)\n`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
process.stdout.write(`${fingerprint(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))}\n`);
