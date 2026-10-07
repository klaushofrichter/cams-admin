// Writes the v1 contract: contract/v1/*.schema.json (lenient),
// contract/v1/strict/*.schema.json and contract/v1/fixtures/*.json.
// `npm run contract:make`. The fixtures are deterministic (fixed time, the
// keys of vectors.json), so a re-run changes nothing unless the contract does.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { KeyObject } from 'crypto';
import { ALLOW_ENTRIES, buildSchemas, DISRUPTIVE_ACTIONS, REMOTE_SETTABLE } from './build';
import { buildCamsSchemas, camsFixtures, camsVectors } from './cams-build';
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
  // The Pi with its camera's SD card read (cam-proxy #199): overwrite off, a warning.
  const withSd = structuredClone(pi) as unknown as { camera: Record<string, unknown>; items: Record<string, unknown>[]; cameras: { camera: Record<string, unknown>; items: Record<string, unknown>[] }[] };
  const sd = { mounted: true, formatted: true, capacityMB: 30432, freeMB: 900, overwrite: false, recordingEnabled: true, checkedAt: NOW - 60_000, lastRecordingAt: NOW - 120_000, stalled: false };
  const sdItem = { id: 'sd', label: 'SD card', value: 'overwrite_off', text: 'Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true };
  withSd.camera.sd = sd;
  withSd.cameras[0].camera.sd = sd;
  for (const list of [withSd.items, withSd.cameras[0].items]) list.splice(list.findIndex((i) => i.id === 'ftp') + 1, 0, sdItem);
  const extra = structuredClone(pi) as Record<string, unknown>;
  extra.newThing = 1;

  // --- P2: commands. $context is what the receiving proxy knows; $expect.receiver says who judges.
  const SERVER = privateFromB64(serverKey.privateKeyPkcs8B64);
  const PROXY = privateFromB64(proxyKey.privateKeyPkcs8B64);
  const OTHER = privateFromB64(keyFromSeed(vectors.keys.other.seedHex).privateKeyPkcs8B64);
  const ctx = (o: Partial<{ allow: string[]; paused: boolean; seen: string[]; now: number; enabled: boolean; tokens: object[]; journal: object[] }> = {}) => ({ now: NOW + 10, proxyId: PRX, connId: CON, serverKeys: [serverKey.publicKeySpkiB64], allow: ['tokens.apply'], paused: false, seen: [] as string[], ...o });
  const signed = <T extends Record<string, unknown>>(m: T, key: KeyObject) => ({ ...m, sig: signEnvelope(key, m) });
  const command = (seq: number, name: string, args: object, o: Partial<{ proxyId: string; connId: string; exp: number; key: KeyObject; revocationOnly: boolean }> = {}) =>
    signed(env('command', seq, { proxyId: o.proxyId ?? PRX, connId: o.connId ?? CON, cmdId: CMD, exp: o.exp ?? NOW + seq + 60_000, actor: 'admin@example.org', command: name, args, ...(o.revocationOnly ? { revocationOnly: true } : {}) }), o.key ?? SERVER);
  const tokensArgs = (tokens: object[]) => ({ v: 1, revision: 1, tokens });
  const clientTok = { id: TOK(1), kind: 'client', hash: HASH(1), label: 'cams example', retireAt: null };
  const adminTok = { id: TOK(2), kind: 'admin', hash: HASH(2), label: 'cams example admin', retireAt: null };
  const otherTok = { id: TOK(3), kind: 'client', hash: HASH(3), label: 'cams other', retireAt: null };
  const revoke = (tokens: object[]) => command(3, 'tokens.apply', { v: 1, revision: 2, tokens }, { revocationOnly: true });
  const applyResult = { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] };
  const goodCommand = command(3, 'tokens.apply', tokensArgs([clientTok]));
  const refused = (code: string, message: unknown, context: object, note: string) => ({ $note: note, schema: 'command', $context: context, $expect: { runtime: code, strict: 'valid', receiver: 'proxy' }, message });
  const toProxyInvalid = (code: string, message: unknown, note: string) => ({ $note: note, schema: 'command', $context: ctx(), $expect: { runtime: code, strict: 'invalid', receiver: 'proxy' }, message });
  const result = (seq: number, body: object) => signed(env('result', seq, { proxyId: PRX, connId: CON, cmdId: CMD, ...body }, { re: ID(3) }), PROXY);
  const { sig: _unsigned, ...unsignedCommand } = goodCommand;

  // --- P3: remote configuration ("The P3 contract"). $context.journal: the proxy's
  // command journal entries the journal budget counts; result fixtures name their
  // command in $command (a result body carries only the cmdId).
  const REV = `sha256:${'a'.repeat(64)}`;
  const REV2 = `sha256:${'b'.repeat(64)}`;
  const journal = (n: number, name: string, action?: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => ({ cmdId: `cmd_${String(i).padStart(20, '0')}`, command: name, at: NOW - (i + 1) * 60_000, ...(action ? { action: action(i) } : {}) }));
  const p3Valid = (note: string, allow: string[], name: string, args: object) => ({ $note: note, schema: 'command', $context: ctx({ allow }), message: command(3, name, args) });
  const p3Refused = (code: string, name: string, args: object, allow: string[], note: string, o: { paused?: boolean; journal?: object[] } = {}) => refused(code, command(3, name, args), ctx({ allow, ...o }), note);
  const p3Result = (cmd: string, note: string, body: object) => ({ $note: note, $command: cmd, schema: 'result', message: result(5, { phase: 'done', ...body }) });
  const setArgs = (set: object, dryRun = true) => ({ v: 1, dryRun, baseRevision: REV, set });
  const view = {
    revision: REV, schema: 1, cameras: ['cam1'], omittedCameras: [],
    paths: {
      'sse.pingS': { v: 5, s: 'override', by: { cmdId: CMD, actor: 'admin@example.org', at: NOW } },
      'sse.maxClients': { v: 20, s: 'default' },
      'stills.quality': { v: 5, s: 'file', r: 'restart', p: true, n: 6 },
      'retention.clipsDays': { v: 90, s: 'file' },
      'ftp.publicHost': { v: 'proxy.example.net', s: 'env' },
      'cameras.cam1.name': { v: 'Front door', s: 'file' },
      'cameras.cam1.host': { v: '192.0.2.10', s: 'file' },
      'stills.maxGB': { s: 'default' },
    },
    settable: {
      'sse.pingS': { type: 'integer', min: 5, max: 300 },
      'sse.maxClients': { type: 'integer', min: 1, max: 100 },
      'stills.quality': { type: 'integer', oneOf: [1, 2, 3, 4, 5, 6] },
      'retention.clipsDays': { type: 'integer', min: 1, max: 3650, dir: 'more' },
      'stills.maxGB': { type: 'integer', min: 1, max: 10000, optional: true, dir: 'more' },
      'cameras.*.name': { type: 'string', pattern: '^[^\\u0000-\\u001f]{1,64}$' },
    },
  };
  const sixtyFive = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`sse.p${i}`, 1]));
  const p3 = {
    'valid-command-config-get': p3Valid('read the settings view', ['config.get'], 'config.get', { v: 1 }),
    'valid-command-config-set': p3Valid('a dry run of one setting', ['config.set'], 'config.set', setArgs({ 'sse.pingS': 5 })),
    'valid-command-config-unset': p3Valid('a dry run of a reset to the file or default value', ['config.unset'], 'config.unset', { v: 1, dryRun: true, baseRevision: REV, paths: ['sse.pingS'] }),
    'valid-command-config-rollback': p3Valid('a dry run of undoing an earlier change', ['config.rollback'], 'config.rollback', { v: 1, dryRun: true, cmdId: 'cmd_1123456789ABCDEFGHJK' }),
    'valid-command-camera-action': p3Valid('a non-disruptive camera action', ['camera.action:camera-test'], 'camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }),
    'valid-command-camera-name-set': p3Valid('rename a camera on the camera', ['camera.name.set'], 'camera.name.set', { v: 1, camera: 'cam1', name: 'Front door' }),
    'valid-command-proxy-restart': p3Valid('restart the proxy after the result is sent', ['proxy.restart'], 'proxy.restart', { v: 1 }),
    'valid-result-config-get': p3Result('config.get', 'a compact view: values, sources, restart marks, settable bounds', { status: 'ok', result: view }),
    'valid-result-config-set-ok': p3Result('config.set', 'one change written', { status: 'ok', result: { dryRun: false, baseRevision: REV, revision: REV2, changes: [{ path: 'sse.pingS', from: 30, to: 5, sourceFrom: 'default', sourceTo: 'override' }], unchanged: [] } }),
    'valid-result-config-set-conflict': p3Result('config.set', 'baseRevision is not the current revision: the current values of the named paths', { status: 'conflict', result: { revision: REV2, current: { 'sse.pingS': { v: 9, s: 'override' } } } }),
    'valid-result-config-set-failed': p3Result('config.set', 'a denied path fails the whole command', { status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'cameras.cam1.host', code: 'not_remote_settable' }] } }),
    'valid-result-config-set-failed-retention': p3Result('config.set', 'a retention period lowered remotely', { status: 'failed', code: 'widening_local_only', result: { paths: [{ path: 'retention.clipsDays', code: 'widening_local_only', detail: 'a remote change may only keep data longer' }] } }),
    'valid-result-config-set-failed-ftp-enabled': p3Result('config.set', 'capture switches are local only (ruling I4)', { status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'ftp.enabled', code: 'not_remote_settable' }] } }),
    'valid-result-config-set-failed-health': p3Result('config.set', 'health thresholds are local only (ruling I4)', { status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'health.diskPercent', code: 'not_remote_settable' }] } }),
    'valid-result-config-set-failed-storage': p3Result('config.set', 'storage settings are local only', { status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'storage.maxPercent', code: 'not_remote_settable' }] } }),
    'valid-result-camera-action-verified': p3Result('camera.action', 'a camera write, re-read and compared', { status: 'ok', result: { action: 'camera-ntp-set', camera: 'cam1', httpStatus: 200, answer: { ok: true }, verified: true, mismatch: [] } }),
    'refused-config-set-not-allowed': p3Refused('not_allowed', 'config.set', setArgs({ 'sse.pingS': 5 }), ['config.get'], 'config.set is not in the allow-list'),
    'refused-camera-action-entry-missing': p3Refused('not_allowed', 'camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' }, ['camera.action:camera-test'], 'step 8 passes (a camera.action entry), step 11 needs camera.action:camera-reboot'),
    'refused-camera-action-never-remote': p3Refused('not_allowed', 'camera.action', { v: 1, camera: 'cam1', action: 'find-camera' }, [...ALLOW_ENTRIES], 'never remote, whatever the allow-list (strict: not a remote action)'),
    'refused-camera-action-no-camera': p3Refused('invalid_args', 'camera.action', { v: 1, camera: null, action: 'camera-reboot' }, ['camera.action:camera-reboot'], 'camera is null only for retention-run (strict args refuse)'),
    'refused-config-set-bad-path': p3Refused('invalid_args', 'config.set', setArgs({ 'Sse.pingS': 5 }), ['config.set'], 'a path starts with a lower-case letter (strict args refuse)'),
    'refused-config-set-object-value': p3Refused('invalid_args', 'config.set', setArgs({ sse: { pingS: 5 } }), ['config.set'], 'a value is a leaf, never an object (strict args refuse)'),
    'refused-config-set-65-paths': p3Refused('invalid_args', 'config.set', setArgs(sixtyFive), ['config.set'], 'at most 64 entries (strict args refuse)'),
    'refused-config-set-args-v2': p3Refused('unsupported_version', 'config.set', { ...setArgs({ 'sse.pingS': 5 }), v: 2 }, ['config.set'], 'args v 2'),
    'refused-proxy-restart-budget': p3Refused('rate_limited', 'proxy.restart', { v: 1 }, ['proxy.restart'], 'two restarts within the hour (the journal budget)', { journal: journal(2, 'proxy.restart') }),
    'refused-camera-action-budget': p3Refused('rate_limited', 'camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' }, ['camera.action:camera-reboot'], 'six disruptive actions within the hour', { journal: journal(6, 'camera.action', (i) => DISRUPTIVE_ACTIONS[i % DISRUPTIVE_ACTIONS.length]) }),
    'refused-camera-name-set-bidi': p3Refused('invalid_args', 'camera.name.set', { v: 1, camera: 'cam1', name: 'evil\u202Egnp.exe' }, ['camera.name.set'], 'a bidi override in a camera name (strict args refuse)'),
    'refused-camera-name-set-alm': p3Refused('invalid_args', 'camera.name.set', { v: 1, camera: 'cam1', name: 'evil\u061Cname' }, ['camera.name.set'], 'U+061C (Arabic letter mark, a format character) in a camera name'),
    'refused-camera-name-set-tag': p3Refused('invalid_args', 'camera.name.set', { v: 1, camera: 'cam1', name: 'tag\u{E0041}name' }, ['camera.name.set'], 'a tag character (U+E0041) in a camera name'),
    'refused-camera-name-set-surrogate': p3Refused('invalid_args', 'camera.name.set', { v: 1, camera: 'cam1', name: 'lone\uD800name' }, ['camera.name.set'], 'a lone surrogate (U+D800) in a camera name'),
    'refused-camera-action-ftp-off': p3Refused('not_allowed', 'camera.action', { v: 1, camera: 'cam1', action: 'camera-ftp-off' }, [...ALLOW_ENTRIES], 'camera-ftp-off is never remote (cam-proxy #196), whatever the allow-list'),
    'valid-command-camera-name-set-accents': p3Valid('a name with accents, spaces and a dash', ['camera.name.set'], 'camera.name.set', { v: 1, camera: 'cam1', name: 'Garage Süd – Einfahrt' }),
    'valid-result-config-rollback-failed-widening': p3Result('config.rollback', 'a rollback that would lower a raise-only value (or touch a local-only path)', { status: 'failed', code: 'widening_local_only', result: { paths: [{ path: 'retention.clipsDays', code: 'widening_local_only', detail: 'a remote change may only keep data longer' }] } }),
    'refused-proxy-restart-paused': p3Refused('paused', 'proxy.restart', { v: 1 }, ['proxy.restart'], 'commands paused on the proxy', { paused: true }),
  };

  return {
    'valid-heartbeat-4cam': valid('heartbeat', hb(four, false, makeProxyInfo({ now: NOW, site: 'garage', publicUrl: 'https://proxy.example.net' })), 'four cameras, site CA, cam3 offline'),
    'valid-heartbeat-1cam-pi': valid('heartbeat', hb(pi), 'the Pi: one camera, host stats'),
    'valid-heartbeat-1cam-sd': valid('heartbeat', hb(withSd), "the Pi with its camera's SD card (cam-proxy #199): overwrite off, a warning item"),
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
    // revocationOnly ($context.tokens: the proxy's current managed set; $context.enabled: the env switch).
    'valid-command-revocation-while-paused': { $note: 'a true revocation (a subset of the current set): runs while paused and without an allow entry', schema: 'command', $context: ctx({ paused: true, allow: [], tokens: [clientTok, otherTok] }), message: revoke([clientTok]) },
    'refused-command-revocation-mismatch': refused('invalid_args', revoke([clientTok, otherTok]), ctx({ paused: true, allow: [], tokens: [clientTok] }), 'claims revocationOnly but adds a token'),
    'refused-command-revocation-env-off': refused('paused', revoke([clientTok]), ctx({ enabled: false, allow: ['tokens.apply'], tokens: [clientTok, otherTok] }), 'the env kill switch blocks even a revocation'),
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
    ...p3,
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
  writeFileSync(join(OUT, 'remote-settable.json'), JSON.stringify(REMOTE_SETTABLE, null, 2) + '\n');
  console.log('contract/v1 written');

  // cams-v1 (the cams service API). README.md is hand-written (the plans'
  // contract section) and left alone.
  const CAMS = join(__dirname, 'cams-v1');
  for (const mode of ['lenient', 'strict'] as const) {
    const dir = mode === 'strict' ? join(CAMS, 'strict') : CAMS;
    mkdirSync(dir, { recursive: true });
    for (const [name, s] of Object.entries(buildCamsSchemas(mode))) writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify(s, null, 2) + '\n');
  }
  rmSync(join(CAMS, 'fixtures'), { recursive: true, force: true });
  mkdirSync(join(CAMS, 'fixtures'));
  for (const [name, f] of Object.entries(camsFixtures())) writeFileSync(join(CAMS, 'fixtures', `${name}.json`), JSON.stringify(f, null, 2) + '\n');
  writeFileSync(join(CAMS, 'vectors.json'), JSON.stringify(camsVectors(), null, 2) + '\n');
  console.log('contract/cams-v1 written');
}
