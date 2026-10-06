// Writes the v1 contract: contract/v1/*.schema.json (lenient),
// contract/v1/strict/*.schema.json and contract/v1/fixtures/*.json.
// `npm run contract:make`. The fixtures are deterministic (fixed time, the
// keys of vectors.json), so a re-run changes nothing unless the contract does.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildSchemas } from './build';
import { keyFromSeed, privateFromB64, sign, signedText } from '../server/crypto/ed25519';
import { makeProxyInfo, makeSummary, truncateSummary } from '../test-client/summaries';
import vectors from './v1/vectors.json';

const OUT = join(__dirname, 'v1');
const NOW = 1791273600000;
const ID = (n: number) => '01K6' + String(n).padStart(22, '0');
const PRX = 'prx_0123456789ABCDEFGHJK';
const KEY = 'key_0123456789ABCDEFGHJK';
const CON = 'con_0123456789ABCDEFGHJK';
const NONCE = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA';

export function fixtures(): Record<string, unknown> {
  const proxyKey = keyFromSeed(vectors.keys.proxy.seedHex);
  const serverKey = keyFromSeed(vectors.keys.server.seedHex);
  const env = (type: string, seq: number, body: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, type, id: ID(seq), seq, ts: NOW + seq, ...extra, body });
  const hb = (summary: unknown, truncated = false, info = makeProxyInfo({ now: NOW })) => env('heartbeat', 2, { summary, proxy: info, truncated });
  const four = makeSummary({ cameras: 4, now: NOW, site: true, offline: ['cam3'] });
  const pi = makeSummary({ cameras: 1, now: NOW, pi: true });
  const code = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
  const valid = (schema: string, message: unknown, note: string) => ({ $note: note, schema, message });
  const invalid = (schema: string, runtime: string, message: unknown, note: string) => ({ $note: note, schema, $expect: { runtime, strict: 'invalid' }, message });
  const drift = (schema: string, message: unknown, note: string) => ({ $note: note, schema, $expect: { runtime: 'accepted', strict: 'invalid' }, message });
  const longLabel = structuredClone(four);
  longLabel.items[0].label = 'x'.repeat(201);
  const manyItems = structuredClone(pi);
  manyItems.items = Array.from({ length: 65 }, () => structuredClone(pi.items[0]));
  const extra = structuredClone(pi) as Record<string, unknown>;
  extra.newThing = 1;
  return {
    'valid-heartbeat-4cam': valid('heartbeat', hb(four, false, makeProxyInfo({ now: NOW, site: 'garage', publicUrl: 'https://proxy.example.net' })), 'four cameras, site CA, cam3 offline'),
    'valid-heartbeat-1cam-pi': valid('heartbeat', hb(pi), 'the Pi: one camera, host stats'),
    'valid-heartbeat-truncated': valid('heartbeat', hb(truncateSummary(four), true), 'over 192 KiB: header, items, cameras[].camera and .items'),
    'valid-challenge': valid('challenge', env('challenge', 1, { connId: CON, nonce: NONCE, serverTime: NOW, serverKeyId: vectors.keys.server.fingerprint },
      { sig: sign(privateFromB64(serverKey.privateKeyPkcs8B64), signedText.challenge(CON, NONCE, NOW)) }), 'signed by the vectors server key'),
    'valid-hello': valid('hello', env('hello', 1, { proxyId: PRX, keyId: KEY, connId: CON, nonce: NONCE, ts: NOW, version: 'v2026.10.06.1', capabilities: ['status'] },
      { sig: sign(privateFromB64(proxyKey.privateKeyPkcs8B64), signedText.hello(CON, NONCE, PRX, KEY, NOW)) }), 'signed by the vectors proxy key'),
    'valid-welcome': valid('welcome', env('welcome', 2, { heartbeatS: 30, offlineAfterS: 90, maxMessageBytes: 262144, serverTime: NOW }), ''),
    'valid-ack': valid('ack', env('ack', 3, { nextInS: 30 }, { re: ID(2) }), ''),
    'valid-error': valid('error', env('error', 4, { code: 'unsupported_type', message: 'type command is not supported' }, { re: ID(3) }), ''),
    'valid-error-retry': valid('error', env('error', 4, { code: 'rate_limited', message: 'too many messages', retryAfterS: 60 }), ''),
    'valid-bye': valid('bye', env('bye', 5, { reason: 'shutdown' }), ''),
    'valid-enroll-request': valid('enroll-request', {
      v: 1, code, publicKey: proxyKey.publicKeySpkiB64, proof: sign(privateFromB64(proxyKey.privateKeyPkcs8B64), signedText.enroll(code, proxyKey.publicKeySpkiB64)),
      proxy: { version: 'v2026.10.06.1', cameraIds: ['cam1'] },
    }, 'proof signed by the vectors proxy key'),
    'valid-enroll-response': valid('enroll-response', { v: 1, proxyId: PRX, keyId: KEY, account: 'home', connectUrl: 'wss://cams-admin.example.net/proxy/v1/connect', serverKeys: [serverKey.publicKeySpkiB64], heartbeatS: 30 }, ''),
    'invalid-envelope-no-seq': invalid('envelope', 'bad_message', (({ seq: _s, ...m }) => m)(env('bye', 1, { reason: 'shutdown' })), 'seq missing'),
    'invalid-envelope-seq-0': invalid('envelope', 'bad_message', env('bye', 0, { reason: 'shutdown' }), 'seq starts at 1'),
    'invalid-envelope-v2': invalid('envelope', 'unsupported_version', { ...env('bye', 1, { reason: 'shutdown' }), v: 2 }, 'an unknown envelope version'),
    'invalid-envelope-body-array': invalid('envelope', 'bad_message', env('bye', 1, []), 'body must be an object'),
    'invalid-type-unknown': invalid('envelope', 'unsupported_type', env('frobnicate', 1, {}), 'unknown type: error unsupported_type, connection stays'),
    'invalid-type-command': invalid('envelope', 'unsupported_type', env('command', 1, {}), 'reserved for P3'),
    'invalid-hello-no-sig': invalid('hello', 'bad_message', env('hello', 1, { proxyId: PRX, keyId: KEY, connId: CON, nonce: NONCE, ts: NOW }), 'hello must be signed'),
    'invalid-ack-no-re': invalid('ack', 'bad_message', env('ack', 1, { nextInS: 30 }), 'ack answers a heartbeat id'),
    'invalid-heartbeat-no-summary': invalid('heartbeat', 'bad_message', env('heartbeat', 1, { truncated: false }), ''),
    'invalid-heartbeat-schema-2': invalid('heartbeat', 'unreadable_summary', hb({ ...pi, schema: 2 }), 'stored as "unreadable summary (schema 2)"'),
    'invalid-heartbeat-65-items': invalid('heartbeat', 'unreadable_summary', hb(manyItems), 'at most 64 items'),
    'invalid-heartbeat-ok-string': invalid('heartbeat', 'unreadable_summary', hb({ ...pi, ok: 'yes' }), 'ok is a boolean'),
    'drift-heartbeat-long-label': drift('heartbeat', hb(longLabel), 'run time clamps text to 200 characters; strict refuses: the proxy must clamp'),
    'drift-heartbeat-new-field': drift('heartbeat', hb(extra), 'run time ignores an unknown field; strict refuses: add it to the contract first'),
    'invalid-enroll-v2': invalid('enroll-request', 'unsupported_version', { v: 2, code, publicKey: proxyKey.publicKeySpkiB64, proof: 'AAAA' }, ''),
    'invalid-enroll-no-proof': invalid('enroll-request', 'bad_request', { v: 1, code, publicKey: proxyKey.publicKeySpkiB64 }, ''),
  };
}

if (require.main === module) {
  for (const mode of ['lenient', 'strict'] as const) {
    const dir = mode === 'strict' ? join(OUT, 'strict') : OUT;
    mkdirSync(dir, { recursive: true });
    for (const [name, s] of Object.entries(buildSchemas(mode))) writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify(s, null, 2) + '\n');
  }
  rmSync(join(OUT, 'fixtures'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'fixtures'));
  for (const [name, f] of Object.entries(fixtures())) writeFileSync(join(OUT, 'fixtures', `${name}.json`), JSON.stringify(f, null, 2) + '\n');
  console.log('contract/v1 written');
}
