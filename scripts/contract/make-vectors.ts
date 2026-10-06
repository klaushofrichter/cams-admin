// Writes contract/v1/vectors.json: fixed Ed25519 keys (from seeds) and the
// exact signed strings with their signatures (Ed25519 is deterministic).
// Run once; the file is committed and both repos test against it.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fingerprint, keyFromSeed, privateFromB64, sign, signedText } from '../../server/crypto/ed25519';

const seeds = { proxy: '01'.repeat(32), server: '02'.repeat(32), other: '03'.repeat(32) };
const keys = Object.fromEntries(Object.entries(seeds).map(([n, seedHex]) => {
  const k = keyFromSeed(seedHex);
  return [n, { seedHex, privateKey: k.privateKeyPkcs8B64, publicKey: k.publicKeySpkiB64, fingerprint: fingerprint(k.publicKeySpkiB64) }];
}));
const code = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
const connId = 'con_0123456789ABCDEFGHJK';
const nonce = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA';
const cases: { kind: 'enroll' | 'challenge' | 'hello'; key: string; args: (string | number)[] }[] = [
  { kind: 'enroll', key: 'proxy', args: [code, keys.proxy.publicKey] },
  { kind: 'challenge', key: 'server', args: [connId, nonce, 1791273600000] },
  { kind: 'hello', key: 'proxy', args: [connId, nonce, 'prx_0123456789ABCDEFGHJK', 'key_0123456789ABCDEFGHJK', 1791273600123] },
  { kind: 'hello', key: 'proxy', args: [connId, nonce, 'prx_0123456789ABCDEFGHJK', 'key_0123456789ABCDEFGHJK', 0] },
];
const signatures = cases.map((c) => {
  const text = (signedText[c.kind] as (...a: (string | number)[]) => string)(...c.args);
  return { ...c, text, sig: sign(privateFromB64(keys[c.key].privateKey), text) };
});
const out = {
  $comment: 'Fixed Ed25519 test keys (PKCS#8 = 302e020100300506032b657004220420 + seed) and the signed strings of spec 8.2/8.3. Test keys only: never use them for a real proxy.',
  keys,
  signatures,
};
writeFileSync(join(__dirname, '../../contract/v1/vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${signatures.length} vectors`);
