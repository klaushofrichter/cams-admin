// Writes the v1 contract: contract/v1/*.schema.json (lenient),
// contract/v1/strict/*.schema.json and contract/v1/fixtures/*.json.
// `npm run contract:make`. The fixtures are deterministic (fixed time, the
// keys of vectors.json), so a re-run changes nothing unless the contract does.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { KeyObject } from 'crypto';
import { ALLOW_ENTRIES, buildSchemas, FILE_KINDS, MOVE_KINDS, DISRUPTIVE_ACTIONS, ONBOARDING_STEPS, REMOTE_SETTABLE } from './build';
import { buildCamsSchemas, camsFixtures, camsVectors } from './cams-build';
import { keyFromSeed, privateFromB64, sign, signEnvelope, signedText } from '../server/crypto/ed25519';
import { makeProfile, makeProxyInfo, makeSummary, truncateSummary } from '../test-client/summaries';
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
  // Camera name sync (2026-11-06): names read from the cameras; cam3 (offline, never read) still has its initial name.
  for (const c of four.cameras) Object.assign(c.camera, { nameSource: c.camera.online ? 'camera' : 'config' });
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

  // --- camera moves: one valid command per command, the proxy's refusals, and the six event kinds.
  // Commands name the entry they need: move.send on the source side, move.receive on the target side
  // (move.finish and move.cancel by args.role). No password anywhere: the camera's passwords travel sealed, out of band.
  const MV = 'mv_0123456789ABCDEFGHJK';
  const RQ = 'rq_0123456789ABCDEFGHJK';
  const MV2 = 'mv_1123456789ABCDEFGHJK';
  const PRX_T = 'prx_1123456789ABCDEFGHJK';
  const LEAF = `SHA256:${'AB'.repeat(32)}`;
  // A fixed X25519 SPKI public key (the 12-byte prefix and 32 bytes: RFC 8410), base64.
  const X25519 = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.alloc(32, 7)]).toString('base64');
  const summary = Object.fromEntries(FILE_KINDS.map((k) => [k, k === 'archive'
    ? { files: 0, bytes: 0, rows: 0, oldest: null, newest: null }
    : { files: 120, bytes: 52_428_800, rows: 130, oldest: NOW - 86_400_000 * 30, newest: NOW - 60_000 }]));
  const settings = { name: 'Garage Süd', statusPollS: 30, ftp: { enabled: true, stream: 'main' }, stills: { stream: 'sub', intervalS: 1 }, storage: { sharePercent: 40 }, events: { poll: { enabled: true } } };
  const plan = { transfer: true, kinds: ['clips', 'events', 'checks'], space: 'all', targetSettings: null, budgetS: 7200, estimateS: 1800 };
  const space = { needed: 52_428_800, available: 10_737_418_240, fits: true, perKind: { clips: 50_000_000, events: 2_428_800 }, retentionProposal: null };
  const settingsProposal = { settings: { 'ftp.passive': '30000-30029' }, firewall: 'open TCP 2121 and 30000-30029 for 192.0.2.10 in the host firewall' };
  const camConn = { name: 'Garage Süd', host: '192.0.2.10', protocol: 'https', user: 'cams', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 };
  const offerArgs = {
    v: 1, moveId: MV, token: 'example-move-token-not-a-secret',
    source: { proxyId: PRX, name: 'Garage', url: 'https://192.0.2.1:8480', caFingerprints: [LEAF], tlsServername: 'garage.example.net' },
    camera: { camsId: 'cam1', proxyCameraId: 'cam1', ...camConn }, summary, settings,
  };
  const moveValid = (name: string, allow: string[], args: object, note: string) =>
    ({ $note: note, schema: 'command', $context: ctx({ allow }), message: command(3, name, args) });
  const moveRefused = (code: string, name: string, args: object, allow: string[], note: string) => refused(code, command(3, name, args), ctx({ allow }), note);
  const moveEvent = (seq: number, body: object, note: string) =>
    valid('event', signed(env('event', seq, { proxyId: PRX, connId: CON, ...body }), PROXY), note);
  const bounds = { transfer: true, kinds: ['clips', 'events'], space: 'fit', maxBudgetS: 3600 };
  const beginArgs = { v: 1, camera: 'cam1', target: PRX_T, bounds };
  const moves = {
    'valid-command-move-begin': moveValid('move.begin', ['move.send'], beginArgs, 'cams-admin starts a move on the source, with pre-approval bounds (the source may approve its own offer within them)'),
    'valid-command-move-begin-no-bounds': moveValid('move.begin', ['move.send'], { ...beginArgs, bounds: null }, 'bounds null: the move waits for a person to approve it on the source'),
    'refused-move-begin-not-allowed': moveRefused('not_allowed', 'move.begin', beginArgs, ['move.receive'], 'move.begin needs move.send; move.receive does not cover it'),
    'valid-command-move-summary': moveValid('move.summary', ['move.send'], { v: 1, camera: 'cam1' }, 'read only: cams-admin asks the source for the content of one camera before a move (the Start move form)'),
    'refused-move-summary-not-allowed': moveRefused('not_allowed', 'move.summary', { v: 1, camera: 'cam1' }, ['move.receive'], 'move.summary needs move.send (the source side); move.receive does not cover it'),
    'valid-result-move-summary': { $note: "the camera's content per kind, the same summary as move.request carries", $command: 'move.summary', schema: 'result',
      message: result(5, { phase: 'done', status: 'ok', result: { summary } }) },
    'valid-command-move-targets': moveValid('move.targets', ['move.send'], { v: 1, requestId: RQ, targets: [{ proxyId: PRX_T, name: 'Pi', site: 'garage' }, { proxyId: 'prx_2123456789ABCDEFGHJK', name: 'Mini PC', site: null }] },
      'the proxies the source may move to (source side)'),
    'valid-command-move-open': moveValid('move.open', ['move.send'], { v: 1, moveId: MV, requestId: RQ, camera: 'cam1', tokenHash: HASH(9), targetIp: '192.0.2.20' }, 'the source accepts one bearer token (its hash), bound to the target address'),
    'valid-command-move-offer': moveValid('move.offer', ['move.receive'], offerArgs, 'the target (move.receive) is offered a camera; the plaintext token is in non-final args only'),
    'valid-command-move-answer': moveValid('move.answer', ['move.send'], { v: 1, moveId: MV, requestId: RQ, target: { proxyId: PRX_T, name: 'Pi' }, accept: true, space, estimateS: 1800 }, 'the target accepted'),
    'valid-command-move-answer-refused-detail': moveValid('move.answer', ['move.send'], {
      v: 1, moveId: MV, requestId: RQ, target: { proxyId: PRX_T, name: 'Pi' }, accept: false, reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https',
    }, 'the target refused; detail (optional, 1-300 characters) says what refused, in words'),
    'valid-result-move-offer-refused-detail': { $note: 'the target refuses the offer; detail (optional) says why in words, older proxies send none', $command: 'move.offer', schema: 'result',
      message: result(5, { phase: 'done', status: 'ok', result: { accept: false, reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' } }) },
    'valid-result-move-offer-refused': { $note: 'a refusal without detail (a proxy from before detail)', $command: 'move.offer', schema: 'result',
      message: result(5, { phase: 'done', status: 'ok', result: { accept: false, reason: 'camera_unreachable' } }) },
    'valid-command-move-start': moveValid('move.start', ['move.receive'], { v: 1, moveId: MV, plan, settings, done: ['clips:2026-10-20'] }, 'the approved plan; the target answers with its public key and leaf fingerprint'),
    'valid-command-move-go': moveValid('move.go', ['move.send'], { v: 1, moveId: MV, plan, targetPublicKey: X25519, expectedLeaf: LEAF }, 'the source switches the camera over'),
    'valid-command-move-release': moveValid('move.release', ['move.send'], { v: 1, moveId: MV }, 'the source drops the camera'),
    'valid-command-move-finish': moveValid('move.finish', ['move.send'], { v: 1, moveId: MV, role: 'source', abandoned: false }, 'the source side ends; a target side is role target (move.receive)'),
    'valid-command-move-cancel': moveValid('move.cancel', ['move.receive'], { v: 1, moveId: MV, role: 'target', copied: 'age-out' }, 'cancel on the target, with what to do with copied content (a source cancel has no copied)'),
    'valid-command-move-return-open': moveValid('move.return.open', ['move.receive'], { v: 1, moveId: MV2, returnOf: MV, tokenHash: HASH(9), targetIp: '192.0.2.10' }, 'the copy back after a cancel: the receiving side (move.receive) accepts one bearer token (its hash) for the return move'),
    'valid-command-move-return-start': moveValid('move.return.start', ['move.send'], { v: 1, moveId: MV2, returnOf: MV, token: 'example-move-token-not-a-secret', source: offerArgs.source, done: ['clips:2026-10-20'] }, 'the sending side (move.send) starts copying back; done lists the newest chunk ids already back'),
    'valid-command-move-finish-return': moveValid('move.finish', ['move.receive'], { v: 1, moveId: MV2, role: 'source', abandoned: false, return: true }, 'a return ends: the entry flips, so role source needs move.receive (role target needs move.send)'),
    'refused-move-finish-return-wrong-entry': moveRefused('not_allowed', 'move.finish', { v: 1, moveId: MV2, role: 'source', abandoned: false, return: true }, ['move.send'], 'move.finish with return and role source needs move.receive; move.send does not cover it'),
    'refused-move-offer-not-allowed': moveRefused('not_allowed', 'move.offer', offerArgs, ['move.send'], 'move.offer needs move.receive; move.send does not cover it'),
    'refused-move-cancel-target-no-copied': moveRefused('invalid_args', 'move.cancel', { v: 1, moveId: MV, role: 'target' }, ['move.receive'], 'a target cancel names what to do with copied content (strict args refuse)'),
    'valid-event-move-targets': moveEvent(3, { kind: 'move.targets', requestId: RQ, camera: 'cam1' }, 'the source asks for the targets of one camera'),
    'valid-event-move-request': moveEvent(3, {
      kind: 'move.request', requestId: RQ, camera: { proxyCameraId: 'cam1', ...camConn }, target: PRX_T, actor: { origin: 'local', label: 'admin' }, summary, settings,
    }, 'the source asks to move a camera: connection fields from its config, never a password'),
    'valid-event-move-request-bounds': moveEvent(3, {
      kind: 'move.request', requestId: RQ, camera: { proxyCameraId: 'cam1', ...camConn }, target: PRX_T, actor: { origin: 'managed', label: 'cams-admin move' }, summary, settings, bounds,
    }, 'a request started by move.begin: the bounds the source kept (null when none)'),
    'valid-event-move-approve': moveEvent(3, { kind: 'move.approve', moveId: MV, plan }, 'the user approved the plan on the source'),
    'valid-event-move-cancel': moveEvent(3, { kind: 'move.cancel', moveId: MV, copied: 'delete' }, 'cancelled from the source page'),
    'valid-event-move-phase': moveEvent(3, { kind: 'move.phase', moveId: MV, role: 'target', phase: 'failed', ok: false, code: 'token_address', detail: 'the source refused the bound peer' }, 'a phase change; failed carries a code'),
    'valid-event-move-phase-check': moveEvent(3, { kind: 'move.phase', moveId: MV, role: 'target', phase: 'copied', ok: false, check: { complete: false, missing: { stills: 2 }, recovered: { clips: 1 }, failed: { archive: 1 }, expired: {} }, keepDays: 30 }, 'the completeness check: counts of files per kind (a row that could not be imported counts as failed)'),
    'valid-event-move-phase-return-pending': moveEvent(3, { kind: 'move.phase', moveId: MV, role: 'source', phase: 'cancelled', ok: true, returnPending: true }, 'cancelled after the switch-over: the content is still to be copied back'),
    'invalid-event-move-phase-keepdays-low': invalid('event', 'bad_message', signed(env('event', 3, {
      proxyId: PRX, connId: CON, kind: 'move.phase', moveId: MV, role: 'target', phase: 'finished', ok: true, keepDays: 3,
    }), PROXY), 'keepDays is 7 to 3650'),
    'valid-event-move-progress': moveEvent(3, {
      kind: 'move.progress', moveId: MV, chunks: [{ id: 'clips:2026-10-20', state: 'verified' }, { id: 'clips:2026-10-21', state: 'pending' }, { id: 'events:2026-10-20', state: 'failed' }],
      bytesDone: 10_485_760, bytesTotal: 52_428_800, rateBps: 1_048_576, etaS: 40,
    }, 'copy progress; a chunk id is <kind>:<date>, failed = copied with failures'),
    'invalid-event-move-progress-bad-chunk': invalid('event', 'bad_message', signed(env('event', 3, {
      proxyId: PRX, connId: CON, kind: 'move.progress', moveId: MV, chunks: [{ id: 'clips', state: 'copied' }], bytesDone: 0, bytesTotal: 1, rateBps: 0, etaS: 0,
    }), PROXY), 'a chunk id without a date'),
    // --- the ptz kind (a camera's PTZ positions travel with it; cam-proxy plan D). $context.feature: the cross-check
    // treats the fixture as pending while cam-proxy's moves know no ptz kind.
    'valid-result-move-offer-kinds': { $note: 'the target accepts and lists the move kinds it takes (optional; absent = the five file kinds)', $command: 'move.offer', schema: 'result',
      message: result(5, { phase: 'done', status: 'ok', result: { accept: true, space, probeBps: 12_500_000, kinds: [...MOVE_KINDS] } }) },
    'valid-command-move-answer-kinds': { ...moveValid('move.answer', ['move.send'], { v: 1, moveId: MV, requestId: RQ, target: { proxyId: PRX_T, name: 'Pi' }, accept: true, space, estimateS: 1800, kinds: [...MOVE_KINDS] },
      "the target's accepted kinds, relayed only to a source whose hello announced move-ptz"), $context: { ...ctx({ allow: ['move.send'] }), feature: 'move-ptz' } },
    'valid-event-move-approve-ptz': moveEvent(3, { kind: 'move.approve', moveId: MV, plan: { ...plan, kinds: ['clips', 'ptz'] } }, "a plan with the camera's PTZ positions"),
    'valid-event-move-approve-ptz-only': moveEvent(3, { kind: 'move.approve', moveId: MV, plan: { ...plan, transfer: false, kinds: ['ptz'] } }, 'no content transfer: the PTZ positions still travel'),
    'valid-event-move-progress-ptz': moveEvent(3, {
      kind: 'move.progress', moveId: MV, chunks: [{ id: 'clips:2026-10-30', state: 'verified' }, { id: 'ptz:2026-10-30', state: 'verified' }], bytesDone: 1_048_576, bytesTotal: 1_048_576, rateBps: 1_048_576, etaS: 0,
    }, 'a ptz chunk: the positions as one chunk (no files)'),
    'valid-event-move-phase-check-ptz': moveEvent(3, { kind: 'move.phase', moveId: MV, role: 'target', phase: 'copied', ok: false, check: { complete: false, missing: {}, recovered: {}, failed: { ptz: 1 }, expired: {} }, keepDays: 30 },
      'the completeness check counts ptz too'),
    // --- a target's settings proposal (cam-proxy #240, phased). $context.feature 'move-settings': the cross-check treats the
    // command fixture as pending while cam-proxy's move.answer check does not take settingsProposal.
    'valid-result-move-offer-settings-proposal': { $note: 'the target accepts if the plan also widens its FTP passive range (optional; firewall says what its host firewall must allow)', $command: 'move.offer', schema: 'result',
      message: result(5, { phase: 'done', status: 'ok', result: { accept: true, space, probeBps: 12_500_000, settingsProposal } }) },
    'valid-command-move-answer-settings-proposal': { ...moveValid('move.answer', ['move.send'], { v: 1, moveId: MV, requestId: RQ, target: { proxyId: PRX_T, name: 'Pi' }, accept: true, space, estimateS: 1800, settingsProposal },
      "the target's settings proposal, relayed only to a source whose hello announced move-settings"), $context: { ...ctx({ allow: ['move.send'] }), feature: 'move-settings' } },
    'valid-event-move-approve-settings': moveEvent(3, { kind: 'move.approve', moveId: MV, plan: { ...plan, targetSettings: settingsProposal.settings } }, "a plan that approves the target's settings proposal: targetSettings carries its settings"),
    'drift-event-move-request-summary-ptz': drift('event', signed(env('event', 3, {
      proxyId: PRX, connId: CON, kind: 'move.request', requestId: RQ, camera: { proxyCameraId: 'cam1', ...camConn }, target: PRX_T, actor: { origin: 'local', label: 'admin' },
      summary: { ...summary, ptz: { files: 0, bytes: 0, rows: 3, oldest: null, newest: null } }, settings,
    }), PROXY), 'the summary keeps the five file kinds: lenient takes a sixth key, strict refuses it (cam-proxy never sends one)'),
  };

  // --- camera onboarding (the cams-admin onboarding plan, Task 1; cam-proxy plan A, Prerequisites 1). $context.feature:
  // the cross-check treats the command fixtures as pending while cam-proxy does not implement camera.onboarding.get.
  const onb = (f: { $context: object }) => ({ ...f, $context: { ...f.$context, feature: 'onboarding' } });
  const hbOnb = (onboarding: unknown) => env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, onboarding });
  const PIN = 'SHA256:' + 'AB'.repeat(32);
  const stepOf: Record<string, { ok: boolean | null; detail: string; action?: string }> = {
    ftp: { ok: false, detail: 'camera upload off', action: 'camera-ftp-setup' }, time: { ok: null, detail: 'zone unknown: set time.zone' }, poe: { ok: true, detail: 'none' },
  };
  const onboarding = {
    'valid-heartbeat-onboarding': valid('heartbeat', hbOnb({ cam1: { ready: true, missing: ['ftp'] }, cam2: { ready: false, missing: ['login', 'trust'] } }),
      'the onboarding status per camera (onboarding, optional): cam1 ready without FTP, cam2 not ready (login and trust missing)'),
    'valid-heartbeat-onboarding-null': valid('heartbeat', hbOnb(null), 'onboarding null: none'),
    'drift-heartbeat-onboarding-unknown-step': drift('heartbeat', hbOnb({ cam1: { ready: false, missing: ['lens'] } }),
      'run time keeps an unknown step (a newer proxy) clamped and the heartbeat; strict refuses (missing lists known steps)'),
    'drift-heartbeat-onboarding-ready-missing-login': drift('heartbeat', hbOnb({ cam1: { ready: true, missing: ['login'] } }),
      'run time reads ready: true with a required step missing as not ready and keeps the heartbeat; strict refuses'),
    'valid-command-onboarding-get': onb(p3Valid("read a camera's onboarding status (camera null: every camera; on by default on cam-proxy)", ['camera.onboarding.get'], 'camera.onboarding.get', { v: 1, camera: 'cam1' })),
    'valid-command-camera-time-set': onb(p3Valid("set the camera's time zone and DST rule (a disruptive camera action, off by default)", ['camera.action:camera-time-set'], 'camera.action', { v: 1, camera: 'cam1', action: 'camera-time-set' })),
    'refused-camera-action-time-set-not-allowed': onb(p3Refused('not_allowed', 'camera.action', { v: 1, camera: 'cam1', action: 'camera-time-set' }, ['camera.onboarding.get', 'camera.action:camera-ftp-setup'],
      'camera-time-set needs its own entry camera.action:camera-time-set')),
    'valid-result-onboarding-get': p3Result('camera.onboarding.get', 'one camera, all eleven steps: FTP off (not required), time unknown (no zone), ready', {
      status: 'ok', result: { cameras: { cam1: {
        camera: 'cam1', ready: true, checkedAt: NOW - 1000,
        steps: Object.fromEntries(ONBOARDING_STEPS.map((k) => [k, stepOf[k] ?? { ok: true, detail: '' }])),
        trust: { mode: 'pinned', fingerprint: PIN, served: PIN },
        time: { clockOffsetMs: -1200, zone: null, cameraStdOffsetMinutes: 60, cameraDst: true },
      } } },
    }),
    'valid-result-camera-time-set-verified': p3Result('camera.action', "camera-time-set: the camera's zone and DST rule written, re-read and compared", {
      status: 'ok', result: { action: 'camera-time-set', camera: 'cam1', httpStatus: 200, answer: { outcome: 'set' }, verified: true, mismatch: [] },
    }),
  };

  // --- Vision management (docs/superpowers/specs/2026-11-05-vision-management-design.md). $context.feature: the cross-check
  // treats the command fixtures as pending while cam-proxy does not implement analytics.usage.get.
  const vis = (f: { $context: object }) => ({ ...f, $context: { ...f.$context, feature: 'vision' } });
  const VISION = 'analytics.googleVision';
  const usage = {
    v: 1, at: NOW, providers: [{
      id: 'google-vision', name: 'Google Vision', enabled: true, key: 'env', monthlyLimit: 1000, remoteMaxMonthly: 1000, dailyCap: 0,
      month: { calls: 84 }, today: { calls: 9 }, paused: null, lastError: null,
      cameras: [{ id: 'cam1', today: 3, month: 40 }, { id: 'cam2', today: 6, month: 44 }],
    }],
  };
  const pausedUsage = {
    v: 1, at: NOW, providers: [{
      ...usage.providers[0], enabled: true, key: 'manual', remoteMaxMonthly: 0, dailyCap: 50,
      paused: { reason: 'invalid_key', until: null }, lastError: { at: NOW - 3_600_000, message: 'API key not valid. Please pass a valid API key.' }, cameras: [],
    }],
  };
  const ceilingDetail = 'cams-admin may allow up to 1000 calls a month (analytics.googleVision.remoteMaxMonthly)';
  const visionView = {
    revision: REV, schema: 1, cameras: ['cam1'], omittedCameras: [],
    paths: {
      [`${VISION}.enabled`]: { v: true, s: 'file' }, [`${VISION}.monthlyLimit`]: { v: 500, s: 'file' }, [`${VISION}.remoteMaxMonthly`]: { v: 1000, s: 'file' },
    },
    settable: {
      [`${VISION}.enabled`]: { type: 'boolean', dir: 'ceilingGated' },
      [`${VISION}.monthlyLimit`]: { type: 'integer', min: 0, max: 100000, dir: 'ceiling' },
    },
  };
  const vision = {
    'valid-command-analytics-usage-get': vis(p3Valid("read the proxy's analytics providers: settings, use, pause, last error, per camera (read only)", ['analytics.usage.get'], 'analytics.usage.get', { v: 1 })),
    'refused-analytics-usage-get-not-allowed': vis(p3Refused('not_allowed', 'analytics.usage.get', { v: 1 }, ['config.get'], 'analytics.usage.get needs its own entry (a proxy with a saved policy adds it once)')),
    'refused-analytics-usage-get-extra-arg': vis(p3Refused('invalid_args', 'analytics.usage.get', { v: 1, provider: 'google-vision' }, ['analytics.usage.get'], 'args are {v} only (strict args refuse)')),
    'valid-result-analytics-usage-get': p3Result('analytics.usage.get', 'Google Vision on, key from the environment, ceiling 1000, two cameras', { status: 'ok', result: usage }),
    'valid-result-analytics-usage-get-paused': p3Result('analytics.usage.get', 'paused (invalid key, no end), the last error, no ceiling, no camera counts yet', { status: 'ok', result: pausedUsage }),
    'valid-command-config-set-vision': p3Valid('Vision limit and switch together (enabled = limit > 0), a dry run', ['config.set'], 'config.set', setArgs({ [`${VISION}.enabled`]: true, [`${VISION}.monthlyLimit`]: 800 })),
    'valid-result-config-get-vision': p3Result('config.get', 'the Vision paths: the ceiling (local only) in paths, enabled ceilingGated and monthlyLimit ceiling in settable', { status: 'ok', result: visionView }),
    'valid-result-config-set-above-ceiling': p3Result('config.set', 'a monthly limit above the local ceiling', {
      status: 'failed', code: 'above_local_ceiling', result: { paths: [{ path: `${VISION}.monthlyLimit`, code: 'above_local_ceiling', detail: ceilingDetail }] },
    }),
    'valid-result-config-set-enable-no-ceiling': p3Result('config.set', 'switching Vision on with no ceiling at the proxy (0)', {
      status: 'failed', code: 'above_local_ceiling', result: { paths: [{ path: `${VISION}.enabled`, code: 'above_local_ceiling', detail: 'cams-admin may not switch it on: no ceiling at the proxy (analytics.googleVision.remoteMaxMonthly is 0)' }] },
    }),
    'valid-result-config-set-failed-ceiling': p3Result('config.set', 'the ceiling itself is local only', { status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: `${VISION}.remoteMaxMonthly`, code: 'not_remote_settable' }] } }),
  };

  // --- PoE switches as account resources (docs/superpowers/specs/2026-11-07-poe-switches-design.md). $context.feature: the
  // cross-check treats these as pending while cam-proxy does not vendor the switch and power messages.
  const poe = <T extends object>(f: T) => ({ ...f, $context: { ...(f as { $context?: object }).$context, feature: 'poe' } });
  const SW = 'sw_0123456789abcdefghij';
  const CAMID = 'cam_0123456789ABCDEFGHJK';
  const swRef = { id: SW, model: 'sscpoe-web', host: '192.0.2.217', ports: 8, offSeconds: 10 };
  const poePorts = [{ port: 8, poe: true, watts: 4.2, link: true, tx: 1200, rx: 80000 }, { port: 7, poe: false, watts: 0, link: null, tx: 0, rx: 0 }];
  const poeFixtures = {
    'valid-command-switch-read': poe(p3Valid('read a switch: serial, firmware and the PoE state of every port', ['switch.read'], 'switch.read', { v: 1, switch: swRef })),
    'valid-command-switch-cycle-force': poe(p3Valid('power-cycle one port with force (a person confirmed, disruptive)', ['switch.cycle'], 'switch.cycle',
      { v: 1, switch: swRef, port: 8, host: '192.0.2.10', force: true, camera: CAMID })),
    'refused-switch-cycle-bad-id': poe(p3Refused('invalid_args', 'switch.cycle', { v: 1, switch: { ...swRef, id: 'sw_x' }, port: 8, host: null, force: false, camera: CAMID }, ['switch.cycle'],
      'a switch id is sw_ and 20 letters or digits (strict args refuse)')),
    'valid-event-camera-power-cycle-request': poe(valid('event', signed(env('event', 3, { proxyId: PRX, connId: CON, kind: 'camera.power.cycle.request', camera: 'cam1', requestId: 'req-0123456789' }), PROXY),
      "the camera's proxy asks cams-admin to power-cycle the camera through its switch (no force from a proxy)")),
    // cam-proxy #364 (phased): a survey's per-camera switch error, poeCut on camera.power.cycled, askedAt on a request.
    'valid-result-switch-survey-switch-error': poe(p3Result('switch.survey', 'one camera found, one whose switch read failed (switch_error, detail in words): the survey goes on', {
      status: 'ok', result: { sn: 'SN-EXAMPLE', results: [{ camera: CAMID, found: true, port: 8, poe: true, watts: 4.2, link: true, ratio: 12.5 }, { camera: 'cam_1123456789ABCDEFGHJK', found: false, reason: 'switch_error', detail: 'the switch answered HTTP 500' }] },
    })),
    'valid-command-camera-power-cycled': poe(p3Valid('PoE is on again: the power-cycle is over', ['camera.power.cycled'], 'camera.power.cycled', { v: 1, camera: 'cam1', ok: true, message: 'power-cycled on Switch port 8' })),
    'valid-command-camera-power-cycled-poe-cut': { ...p3Valid('the power-cycle failed after PoE was cut and turned on again (poeCut, optional): the camera is rebooting, the proxy keeps watching', ['camera.power.cycled'], 'camera.power.cycled',
      { v: 1, camera: 'cam1', ok: false, message: 'PoE may still be off on the port: check the switch', poeCut: true }), $context: { ...ctx({ allow: ['camera.power.cycled'] }), feature: 'power-poe-cut' } },
    'valid-event-camera-power-cycle-request-asked-at': poe(valid('event', signed(env('event', 3, { proxyId: PRX, connId: CON, kind: 'camera.power.cycle.request', camera: 'cam1', requestId: 'pc_01K6000000000000000000000A', askedAt: NOW - 1000 }), PROXY),
      'a request with askedAt (optional): when the page asked; cams-admin ignores one asked over 5 minutes ago')),
  };

  // --- remove a camera, decommission a proxy (decommission spec 2026-11-08). $context.feature: the cross-check treats these
  // as pending until cam-proxy implements camera.remove.
  const dec = <T extends object>(f: T) => ({ ...f, $context: { ...(f as { $context?: object }).$context, feature: 'decommission' } });
  const removed = ['camera FTP upload off', 'configuration', 'stored password', 'certificate trust', 'PTZ positions'];
  const decommission = {
    'valid-command-camera-remove-preview': dec(p3Valid('what the proxy holds for a camera before its removal (read only)', ['camera.remove.preview'], 'camera.remove.preview', { v: 1, camera: 'cam2' })),
    'valid-command-camera-remove-keep': dec(p3Valid('remove a camera, its content left to retention (disruptive)', ['camera.remove'], 'camera.remove', { v: 1, camera: 'cam2', content: 'keep', archive: false })),
    'valid-command-camera-remove-delete-archive': dec(p3Valid('remove a camera and delete its clips, stills and archived clips now (disruptive)', ['camera.remove'], 'camera.remove', { v: 1, camera: 'cam2', content: 'delete', archive: true })),
    'refused-camera-remove-not-allowed': dec(p3Refused('not_allowed', 'camera.remove', { v: 1, camera: 'cam2', content: 'keep', archive: false }, ['camera.remove.preview'], 'camera.remove needs its own entry (the preview entry is not enough)')),
    'refused-camera-remove-archive-keep': dec(p3Refused('invalid_args', 'camera.remove', { v: 1, camera: 'cam2', content: 'keep', archive: true }, ['camera.remove'], 'archive: true only with content: delete (strict args refuse)')),
    'refused-camera-remove-budget': dec(p3Refused('rate_limited', 'camera.remove', { v: 1, camera: 'cam2', content: 'delete', archive: false }, ['camera.remove'],
      'five disruptive actions and one camera.remove within the hour: the shared journal budget', { journal: [...journal(5, 'camera.action', () => 'camera-reboot'), ...journal(1, 'camera.remove').map((e) => ({ ...e, cmdId: `cmd_${'9'.repeat(20)}`, at: NOW - 30 * 60_000 }))] })),
    'valid-command-proxy-unenroll': dec(p3Valid('the proxy unenrolls itself after the result (disruptive)', ['proxy.unenroll'], 'proxy.unenroll', { v: 1 })),
    'refused-proxy-unenroll-not-allowed': dec(p3Refused('not_allowed', 'proxy.unenroll', { v: 1 }, ['proxy.restart'], 'proxy.unenroll needs its own entry')),
    'valid-result-camera-remove-preview': p3Result('camera.remove.preview', 'clips, stills and archived clips the proxy holds for the camera', { status: 'ok', result: { camera: 'cam2', clips: 412, stills: 8_640, archivedClips: 3, bytes: 9_876_543_210 } }),
    'valid-result-camera-remove-preview-not-found': p3Result('camera.remove.preview', 'an unknown camera', { status: 'failed', code: 'not_found' }),
    'valid-result-camera-remove': p3Result('camera.remove', 'removed with content deleted now, archived clips kept', { status: 'ok', result: { camera: 'cam2', removed, leftovers: [], deleted: { clips: 412, stills: 8_640, archivedClips: 0 } } }),
    'valid-result-camera-remove-leftovers': p3Result('camera.remove', 'removed, content kept for retention; one thing the proxy could not clean up', { status: 'ok', result: { camera: 'cam2', removed: removed.slice(1), leftovers: ['camera FTP upload off (camera offline)'], deleted: { clips: 0, stills: 0, archivedClips: 0 } } }),
    'valid-result-camera-remove-move-open': p3Result('camera.remove', 'a move of this camera is open', { status: 'failed', code: 'move_open' }),
    'valid-result-proxy-unenroll': p3Result('proxy.unenroll', 'the proxy unenrolls itself right after this result', { status: 'ok', result: { unenrollAt: NOW + 1_000 } }),
    'valid-result-proxy-unenroll-has-cameras': p3Result('proxy.unenroll', 'refused while the proxy holds cameras', { status: 'failed', code: 'has_cameras' }),
  };

  return {
    'valid-heartbeat-4cam': valid('heartbeat', hb(four, false, makeProxyInfo({ now: NOW, site: 'garage', publicUrl: 'https://proxy.example.net' })), 'four cameras, site CA, cam3 offline'),
    'valid-heartbeat-1cam-pi': valid('heartbeat', hb(pi), 'the Pi: one camera, host stats'),
    'valid-heartbeat-1cam-sd': valid('heartbeat', hb(withSd), "the Pi with its camera's SD card (cam-proxy #199): overwrite off, a warning item"),
    'valid-heartbeat-profile': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: makeProfile() }),
      'the proxy profile (proxy profile design §2): set, one camera held of three, FTP on, the firewall lines of its camera'),
    'valid-heartbeat-profile-unset': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: makeProfile({
      set: false, name: null, cameras: 1, storageGB: null, held: 1, ftp: false, passive: null, pi: 'Raspberry Pi 4 Model B Rev 1.5', budgetBytes: 50_000_000_000, diskBytes: 64_000_000_000, freeBytes: 40_000_000_000, usedBytes: 9_000_000_000,
    }) }), 'a profile not set yet: the defaults (cameras = cameras held), no name, no storageGB; FTP off, no firewall lines'),
    'valid-heartbeat-profile-tls': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW, site: 'garage' }), truncated: false, profile: makeProfile({ tls: { site: 'garage', cameraSubnet: '192.0.2.0/28' } }) }),
      "the profile's site CA (optional): its site and the camera subnet it covers (CIDR); each null when there is none"),
    'valid-heartbeat-profile-tls-none': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: makeProfile({ tls: { site: null, cameraSubnet: null } }) }),
      'no site CA: site and cameraSubnet null'),
    'drift-heartbeat-profile-tls-bad-subnet': drift('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: makeProfile({ tls: { site: 'garage', cameraSubnet: '192.0.2.0' } }) }),
      'run time reads the profile without the unreadable subnet (null) and keeps the heartbeat; strict refuses (cameraSubnet is a CIDR)'),
    'valid-heartbeat-move-leftovers': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false,
      moveLeftovers: [{ camera: 'cam4', moveId: 'mv_0123456789ABCDEFGHJK', items: ['config.json entry', 'env CAMPROXY_CAMERA_PASSWORD_CAM4_FILE'] }] }),
      'what the proxy could not clean up after a camera moved away (moveLeftovers, optional)'),
    'valid-heartbeat-move-leftovers-null': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, moveLeftovers: null }), 'moveLeftovers null: none'),
    'drift-heartbeat-move-leftovers-long': drift('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false,
      moveLeftovers: [{ camera: 'cam4', moveId: 'mv_0123456789ABCDEFGHJK', items: ['config.json entry', 'env CAMPROXY_CAMERA_PASSWORD_CAM4', 'env CAMPROXY_CAMERA_PASSWORD_CAM4_FILE', 'a', 'b'] }] }),
      'run time keeps the first four items and the heartbeat; strict refuses (at most 4 items)'),
    'valid-heartbeat-profile-null': valid('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: null }), 'profile null: the same as none'),
    'drift-heartbeat-profile-cameras-0': drift('heartbeat', env('heartbeat', 2, { summary: pi, proxy: makeProxyInfo({ now: NOW }), truncated: false, profile: { ...makeProfile(), cameras: 0 } }),
      'run time drops an unreadable profile and keeps the heartbeat; strict refuses (cameras is 1..64)'),
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
    ...moves,
    ...onboarding,
    ...vision,
    ...poeFixtures,
    ...decommission,
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
