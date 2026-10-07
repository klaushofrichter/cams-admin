// Writes contract/v1/vectors.json: fixed Ed25519 keys (from seeds) and the
// exact signed strings with their signatures (Ed25519 is deterministic).
// Run once; the file is committed and both repos test against it.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fingerprint, keyFromSeed, privateFromB64, sign, signEnvelope, signedText } from '../../server/crypto/ed25519';
import { jcs } from '../../server/crypto/jcs';

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
// P2: canonical JSON (RFC 8785) cases and signed envelopes.
const jcsCases = [
  { name: 'rfc8785-sorting', input: { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Smiley', '\u0080': 'Control', '\u00f6': 'Latin' } },
  { name: 'numbers', input: [0, -0, 1, -1, 0.1, 1e21, 1e-7, 9007199254740991, 1791273600000] },
  { name: 'escapes', input: { s: 'a"\\\b\f\n\r\t\u0001\u001f\u007f\u2028/<>&é😀' } },
  { name: 'nesting', input: { b: [true, false, null, { z: [], a: {} }], a: '' } },
].map((c) => ({ ...c, text: jcs(c.input) }));
const env = (type: string, seq: number, body: object, extra: object = {}) => ({ v: 1, type, id: '01K6' + String(seq).padStart(22, '0'), seq, ts: 1791273600000 + seq, ...extra, body });
const CON = connId, PRX = 'prx_0123456789ABCDEFGHJK', CMD = 'cmd_0123456789ABCDEFGHJK';
const tokensArgs = { v: 1, revision: 1, tokens: [{ id: 'tok_0123456789ABCDEFGHJK', kind: 'client', hash: 'sha256:' + '0'.repeat(63) + '1', label: 'cams example', retireAt: null }] };
const tokensResult = { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] };
const envelopeCases = [
  { kind: 'command', key: 'server', envelope: env('command', 3, { proxyId: PRX, connId: CON, cmdId: CMD, exp: 1791273600003 + 60000, actor: 'admin@example.org', command: 'tokens.apply', args: tokensArgs }) },
  { kind: 'result', key: 'proxy', envelope: env('result', 4, { proxyId: PRX, connId: CON, cmdId: CMD, phase: 'done', status: 'ok', result: tokensResult }, { re: '01K6' + '3'.padStart(22, '0') }) },
  { kind: 'event', key: 'proxy', envelope: env('event', 2, { proxyId: PRX, connId: CON, kind: 'command.done', cmdId: CMD, phase: 'done', status: 'ok', result: tokensResult }) },
  // A revocation: the set only removes tokens (body.revocationOnly).
  { kind: 'command', key: 'server', envelope: env('command', 5, { proxyId: PRX, connId: CON, cmdId: 'cmd_1123456789ABCDEFGHJK', exp: 1791273600005 + 60000, actor: 'admin@example.org', command: 'tokens.apply', args: { v: 1, revision: 2, tokens: [] }, revocationOnly: true }) },
  // P3: a config.set and its done result (one change).
  { kind: 'command', key: 'server', envelope: env('command', 6, { proxyId: PRX, connId: CON, cmdId: 'cmd_2123456789ABCDEFGHJK', exp: 1791273600006 + 60000, actor: 'admin@example.org', command: 'config.set', args: { v: 1, dryRun: false, baseRevision: 'sha256:' + 'a'.repeat(64), set: { 'sse.pingS': 5 } } }) },
  { kind: 'result', key: 'proxy', envelope: env('result', 7, { proxyId: PRX, connId: CON, cmdId: 'cmd_2123456789ABCDEFGHJK', phase: 'done', status: 'ok', result: { dryRun: false, baseRevision: 'sha256:' + 'a'.repeat(64), revision: 'sha256:' + 'b'.repeat(64), changes: [{ path: 'sse.pingS', from: 30, to: 5, sourceFrom: 'default', sourceTo: 'override' }], unchanged: [] } }, { re: '01K6' + '6'.padStart(22, '0') }) },
].map((c) => ({ ...c, text: jcs(c.envelope), sig: signEnvelope(privateFromB64(keys[c.key].privateKey), c.envelope) }));
const out = {
  $comment: 'Fixed Ed25519 test keys (PKCS#8 = 302e020100300506032b657004220420 + seed) and the signed strings of spec 8.2/8.3. Test keys only: never use them for a real proxy.',
  keys,
  signatures,
  jcs: jcsCases,
  envelopes: envelopeCases,
};
writeFileSync(join(__dirname, '../../contract/v1/vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${signatures.length} vectors`);
