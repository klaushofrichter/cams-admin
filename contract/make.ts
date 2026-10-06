// Writes the v1 contract: contract/v1/*.schema.json (lenient),
// contract/v1/strict/*.schema.json and contract/v1/fixtures/*.json.
// `npm run contract:make`. The fixtures are deterministic (fixed time, the
// keys of vectors.json), so a re-run changes nothing unless the contract does.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { KeyObject } from 'crypto';
import { buildSchemas } from './build';
import { keyFromSeed, privateFromB64, sign, signEnvelope, signedText } from '../server/crypto/ed25519';
import { makeProxyInfo, makeSummary, truncateSummary } from '../test-client/summaries';
import vectors from './v1/vectors.json';

const OUT = join(__dirname, 'v1');
const NOW = 1791273600000;
const ID = (n: number) => '01K6' + String(n).padStart(22, '0');
const PRX = 'prx_0123456789ABCDEFGHJK';
const KEY = 'key_0123456789ABCDEFGHJK';
const CON = 'con_0123456789ABCDEFGHJK';
const NONCE = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA';
const CMD = 'cmd_0123456789ABCDEFGHJK';
const TOK = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const HASH = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

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

  // --- P2: commands. $context is what the receiving proxy knows; $expect.receiver says who judges.
  const SERVER = privateFromB64(serverKey.privateKeyPkcs8B64);
  const PROXY = privateFromB64(proxyKey.privateKeyPkcs8B64);
  const OTHER = privateFromB64(keyFromSeed(vectors.keys.other.seedHex).privateKeyPkcs8B64);
  const ctx = (o: Partial<{ allow: string[]; paused: boolean; seen: string[]; now: number }> = {}) => ({ now: NOW + 10, proxyId: PRX, connId: CON, serverKeys: [serverKey.publicKeySpkiB64], allow: ['tokens.apply'], paused: false, seen: [] as string[], ...o });
  const signed = <T extends Record<string, unknown>>(m: T, key: KeyObject) => ({ ...m, sig: signEnvelope(key, m) });
  const command = (seq: number, name: string, args: object, o: Partial<{ proxyId: string; connId: string; exp: number; key: KeyObject }> = {}) =>
    signed(env('command', seq, { proxyId: o.proxyId ?? PRX, connId: o.connId ?? CON, cmdId: CMD, exp: o.exp ?? NOW + seq + 60_000, actor: 'admin@example.org', command: name, args }), o.key ?? SERVER);
  const tokensArgs = (tokens: object[]) => ({ v: 1, revision: 1, tokens });
  const clientTok = { id: TOK(1), kind: 'client', hash: HASH(1), label: 'cams example', retireAt: null };
  const adminTok = { id: TOK(2), kind: 'admin', hash: HASH(2), label: 'cams example admin', retireAt: null };
  const applyResult = { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] };
  const goodCommand = command(3, 'tokens.apply', tokensArgs([clientTok]));
  const refused = (code: string, message: unknown, context: object, note: string) => ({ $note: note, schema: 'command', $context: context, $expect: { runtime: code, strict: 'valid', receiver: 'proxy' }, message });
  const toProxyInvalid = (code: string, message: unknown, note: string) => ({ $note: note, schema: 'command', $context: ctx(), $expect: { runtime: code, strict: 'invalid', receiver: 'proxy' }, message });
  const result = (seq: number, body: object) => signed(env('result', seq, { proxyId: PRX, connId: CON, cmdId: CMD, ...body }, { re: ID(3) }), PROXY);
  const { sig: _unsigned, ...unsignedCommand } = goodCommand;

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
    'invalid-type-command': invalid('command', 'unsupported_type', env('command', 1, {}), 'a proxy never sends a command: error unsupported_type, connection stays'),
    'valid-command-tokens-apply': { $note: 'signed by the vectors server key; the proxy runs it', schema: 'command', $context: ctx(), message: goodCommand },
    'valid-result-received': valid('result', result(4, { phase: 'received' }), 'signed by the vectors proxy key'),
    'valid-result-done-ok': valid('result', result(5, { phase: 'done', status: 'ok', result: applyResult }), 'signed by the vectors proxy key'),
    'valid-result-refused-paused': valid('result', result(4, { phase: 'done', status: 'refused', code: 'paused' }), 'a nack'),
    'valid-event-command-done': valid('event', signed(env('event', 3, { proxyId: PRX, connId: CON, kind: 'command.done', cmdId: CMD, phase: 'done', status: 'ok', result: applyResult }), PROXY),
      'a done that could not be sent on its own connection, after the next welcome'),
    'valid-heartbeat-p2': valid('heartbeat', hb(pi, false, {
      ...makeProxyInfo({ now: NOW }),
      commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 },
      tokens: { revision: 7, client: 1, admin: 1, blocked: [] },
      configRevision: 'sha256:' + 'a'.repeat(64),
    } as ReturnType<typeof makeProxyInfo>), 'a P2 proxy: command policy, token revision, config revision'),
    'drift-result-new-field': drift('result', result(5, { phase: 'done', status: 'ok', result: applyResult, newThing: 1 }), 'run time ignores an unknown field; strict refuses'),
    'refused-command-bad-signature': refused('bad_signature', command(3, 'tokens.apply', tokensArgs([clientTok]), { key: OTHER }), ctx(), 'signed by the vectors other key'),
    'refused-command-wrong-proxy': refused('wrong_target', command(3, 'tokens.apply', tokensArgs([clientTok]), { proxyId: 'prx_ZZZZZZZZZZZZZZZZZZZZ' }), ctx(), 'for another proxy'),
    'refused-command-wrong-conn': refused('wrong_target', command(3, 'tokens.apply', tokensArgs([clientTok]), { connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' }), ctx(), 'for another connection'),
    'refused-command-replayed': refused('replayed', goodCommand, ctx({ seen: [ID(3)] }), 'its envelope id was seen on this connection'),
    'refused-command-expired': refused('expired', command(3, 'tokens.apply', tokensArgs([clientTok]), { exp: NOW + 4 }), ctx({ now: NOW + 4 + 120_001 }), 'exp + 120 s is past cams-admin time'),
    'refused-command-exp-too-far': refused('expired', command(3, 'tokens.apply', tokensArgs([clientTok]), { exp: NOW + 3 + 60_001 }), ctx(), 'exp - ts = 60001'),
    'refused-command-paused': refused('paused', goodCommand, ctx({ paused: true }), 'commands paused on the proxy'),
    'refused-command-not-allowed': refused('not_allowed', command(3, 'config.get', { v: 1 }), ctx({ allow: ['tokens.apply'] }), 'config.get is not in the allow-list'),
    'refused-command-args-v2': refused('unsupported_version', command(3, 'tokens.apply', { v: 2, revision: 1, tokens: [] }), ctx(), 'args v 2'),
    'refused-tokens-apply-bad-hash': refused('invalid_args', command(3, 'tokens.apply', tokensArgs([{ ...clientTok, hash: 'sha256:' + HASH(1).slice(7).replace(/0/g, 'A') }])), ctx(), 'upper-case hex in the hash (strict command schema accepts: args are checked by commands/tokens.apply.args)'),
    'refused-tokens-apply-admin-not-allowed': refused('not_allowed', command(3, 'tokens.apply', tokensArgs([clientTok, adminTok])), ctx({ allow: ['tokens.apply'] }), 'an admin entry needs tokens.apply.admin'),
    'invalid-command-unsigned': toProxyInvalid('bad_signature', unsignedCommand, 'no sig'),
    'invalid-command-unknown-name': toProxyInvalid('not_allowed', command(3, 'frobnicate', { v: 1 }), 'an unknown command name (strict: not in the enum)'),
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
    for (const [name, s] of Object.entries(buildSchemas(mode))) {
      const file = join(dir, `${name}.schema.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    }
  }
  rmSync(join(OUT, 'fixtures'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'fixtures'));
  for (const [name, f] of Object.entries(fixtures())) writeFileSync(join(OUT, 'fixtures', `${name}.json`), JSON.stringify(f, null, 2) + '\n');
  console.log('contract/v1 written');
}
