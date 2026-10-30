// The contract has two implementations of the proxy-side command check in
// this repo's tests: the fixtures (written from the contract table) and the
// reference check in test-client/commands.ts (written from the contract text).
// cam-proxy's real check is the third (scripts/contract/cam-proxy-commands.ts).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import Ajv2020 from 'ajv/dist/2020';
import { join } from 'path';
import { refCheck } from '../test-client/commands';
import { keyFromSeed, privateFromB64, signEnvelope } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';
import { ALLOW_ENTRIES, MOVE_BEGIN_REFUSALS, MOVE_COMMANDS, WIRE_COMMANDS } from '../contract/build';
import { generateKeyPairSync } from 'crypto';
import { strictErrors, strictValid } from './helpers/contractV1';
import { validateMessage } from '../server/contract';

const DIR = join(__dirname, '../contract/v1/fixtures');
const all = readdirSync(DIR).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
const SERVER = privateFromB64(keyFromSeed(vectors.keys.server.seedHex).privateKeyPkcs8B64);
const resign = (m: Record<string, any>) => { const { sig: _s, ...rest } = m; return { ...rest, sig: signEnvelope(SERVER, rest) }; };

describe('the reference proxy check agrees with every proxy fixture', () => {
  const cases = all.filter((x) => x.$expect?.receiver === 'proxy' || (x.schema === 'command' && x.name.startsWith('valid-')));
  it('covers 66 fixtures (P2 17, P3 24, moves 22, onboarding 3)', () => expect(cases).toHaveLength(66));
  for (const f of cases) {
    it(f.name, () => {
      const c = f.$context;
      const d = refCheck(f.message, { ...c, seen: new Set(c.seen) });
      if (f.name.startsWith('valid-')) expect(d.kind).toBe('run');
      else expect(d.kind === 'nack' ? d.code : d.kind).toBe(f.$expect.runtime);
    });
  }
  const valid = all.find((x) => x.name === 'valid-command-tokens-apply')!;
  const ctx = (o: object = {}) => ({ ...valid.$context, seen: new Set<string>(), ...o });
  it('a journaled cmdId is answered as a duplicate before the pause check', () => {
    expect(refCheck(valid.message, ctx({ paused: true, answered: new Map([[valid.message.body.cmdId, {}]]) })).kind).toBe('duplicate');
  });
  it('the check records the envelope id: the same message twice is replayed', () => {
    const c = ctx();
    expect(refCheck(valid.message, c).kind).toBe('run');
    expect(refCheck(valid.message, c)).toEqual({ kind: 'nack', code: 'replayed' });
  });
  it('no readable cmdId: bad_message (before the signature)', () => {
    const m = structuredClone(valid.message);
    m.body.cmdId = 'nope';
    expect(refCheck(m, ctx()).kind).toBe('bad_message');
    expect(refCheck({ ...valid.message, body: [] }, ctx()).kind).toBe('bad_message');
  });
  it('duplicate ids or hashes in tokens.apply: invalid_args', () => {
    const m = structuredClone(valid.message);
    m.body.args.tokens.push({ ...m.body.args.tokens[0], hash: 'sha256:' + 'b'.repeat(64) });
    expect(refCheck(resign(m), ctx())).toEqual({ kind: 'nack', code: 'invalid_args' });
  });
  it('a label with a control character, 65 tokens, a revision of 0: invalid_args', () => {
    for (const mut of [
      (a: any) => { a.tokens[0].label = 'a\nb'; },
      (a: any) => { a.revision = 0; },
      (a: any) => { a.tokens = Array.from({ length: 65 }, (_, i) => ({ ...a.tokens[0], id: `tok_${String(i).padStart(20, '0')}`, hash: 'sha256:' + i.toString(16).padStart(64, '0') })); },
      (a: any) => { a.extra = 1; },
    ]) {
      const m = structuredClone(valid.message);
      mut(m.body.args);
      expect(refCheck(resign(m), ctx())).toEqual({ kind: 'nack', code: 'invalid_args' });
    }
  });
  it('revocationOnly: skips pause, allow-list and the admin entry only for a true subset of the current set; env off still refuses', () => {
    const f = all.find((x) => x.name === 'valid-command-revocation-while-paused')!;
    const c = (o: object = {}) => ({ ...f.$context, seen: new Set<string>(), ...o });
    expect(refCheck(f.message, c()).kind).toBe('run');
    // The same set is not a revocation when a token changed (here its label).
    const changed = structuredClone(f.message);
    changed.body.args.tokens[0].label = 'renamed';
    expect(refCheck(resign(changed), c())).toEqual({ kind: 'nack', code: 'invalid_args' });
    // Without the claim, the paused proxy refuses as before.
    const plain = structuredClone(f.message);
    delete plain.body.revocationOnly;
    expect(refCheck(resign(plain), c())).toEqual({ kind: 'nack', code: 'paused' });
    expect(refCheck(f.message, c({ enabled: false }))).toEqual({ kind: 'nack', code: 'paused' });
  });
  it('P3 step 11: the journal budget answers rate_limited with retryAfterS until the oldest entry is an hour old', () => {
    const f = all.find((x) => x.name === 'refused-proxy-restart-budget')!;
    const c = f.$context;
    expect(refCheck(f.message, { ...c, seen: new Set() })).toMatchObject({ kind: 'nack', code: 'rate_limited', retryAfterS: expect.any(Number) });
    // The oldest of the two entries leaves the hour: one restart fits again.
    const later = { ...c, seen: new Set<string>(), now: c.journal[1].at + 3_600_001 };
    const m = structuredClone(f.message);
    m.body.exp = later.now + 30_000;
    m.ts = later.now;
    expect(refCheck(resign(m), later).kind).toBe('run');
    // Non-disruptive camera actions are never counted.
    const t = all.find((x) => x.name === 'valid-command-camera-action')!;
    expect(refCheck(t.message, { ...t.$context, seen: new Set(), journal: Array.from({ length: 20 }, (_, i) => ({ cmdId: `cmd_${String(i).padStart(20, '0')}`, command: 'camera.action', action: 'camera-reboot', at: t.$context.now - 1000 })) }).kind).toBe('run');
  });
  it('P3 step 8: camera.action passes with any camera.action entry; step 11 then needs its own', () => {
    const f = all.find((x) => x.name === 'refused-camera-action-entry-missing')!;
    expect(refCheck(f.message, { ...f.$context, seen: new Set(), allow: [] })).toEqual({ kind: 'nack', code: 'not_allowed' });
    expect(refCheck(f.message, { ...f.$context, seen: new Set(), allow: ['camera.action:camera-reboot'] }).kind).toBe('run');
  });
  it('another command running: busy', () => {
    expect(refCheck(valid.message, ctx({ running: true }))).toEqual({ kind: 'nack', code: 'busy' });
  });
});

// --- camera onboarding (the cams-admin onboarding plan, Task 1) --------------------------------
describe('onboarding commands', () => {
  const PIN = 'SHA256:' + 'AB'.repeat(32);
  const STEPS = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile'];
  const status = (): Record<string, any> => ({
    camera: 'cam1', ready: false, checkedAt: 1791273600000,
    steps: Object.fromEntries(STEPS.map((k) => [k, { ok: k === 'trust' ? false : true, detail: k === 'trust' ? 'certificate not trusted' : '', ...(k === 'trust' ? { action: 'camera-trust-pin' } : {}) }])),
    trust: { mode: 'none', fingerprint: null, served: PIN },
    time: { clockOffsetMs: null, zone: 'Europe/Berlin', cameraStdOffsetMinutes: -360, cameraDst: null },
  });
  const argsOk = (a: unknown) => strictValid('commands/camera.onboarding.get.args', a);
  const resultOk = (r: unknown) => strictValid('commands/camera.onboarding.get.result', r);
  it('camera.onboarding.get: args {v, camera | null} closed (strict)', () => {
    expect(argsOk({ v: 1, camera: 'cam1' }), strictErrors()).toBe(true);
    expect(argsOk({ v: 1, camera: null }), strictErrors()).toBe(true);
    expect(argsOk({ v: 1, camera: 'cam1', extra: 1 })).toBe(false);
    expect(argsOk({ v: 1, camera: 'Cam 1' })).toBe(false);
    expect(argsOk({ v: 2, camera: 'cam1' })).toBe(false);
    expect(argsOk({ v: 1 })).toBe(false);
    expect(argsOk({ v: 1, camera: 'cam1', password: 'x' })).toBe(false);
  });
  it('camera.onboarding.get result: {cameras: {<id>: status}, clamped?}; every step required, ok nullable, closed', () => {
    expect(resultOk({ cameras: { cam1: status() } }), strictErrors()).toBe(true);
    expect(resultOk({ cameras: {}, clamped: true }), strictErrors()).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`cam${i}`, { ...status(), camera: `cam${i}` }]));
    expect(resultOk({ cameras: many })).toBe(false);
    const st = (f: (s: Record<string, any>) => void) => { const s = status(); f(s); return { cameras: { cam1: s } }; };
    for (const [why, r] of [
      ['a step missing', st((s) => { delete s.steps.poe; })],
      ['an unknown step', st((s) => { s.steps.lens = { ok: true, detail: '' }; })],
      ['ok a string', st((s) => { s.steps.poe.ok = 'yes'; })],
      ['detail missing', st((s) => { delete s.steps.poe.detail; })],
      ['detail of 201', st((s) => { s.steps.poe.detail = 'x'.repeat(201); })],
      ['action of 33', st((s) => { s.steps.poe.action = 'x'.repeat(33); })],
      ['an extra step field', st((s) => { s.steps.poe.extra = 1; })],
      ['a bad trust mode', st((s) => { s.trust.mode = 'self'; })],
      ['a lower-case pin', st((s) => { s.trust.served = 'SHA256:' + 'ab'.repeat(32); })],
      ['no time', st((s) => { delete s.time; })],
      ['a zone of 65', st((s) => { s.time.zone = 'x'.repeat(65); })],
      ['an extra status field', st((s) => { s.password = 'x'; })],
      ['no checkedAt', st((s) => { delete s.checkedAt; })],
      ['a bad camera key', { cameras: { 'Cam 1': status() } }],
      ['an extra result field', { cameras: {}, extra: 1 }],
    ] as [string, unknown][]) expect(resultOk(r), why).toBe(false);
  });
  it('camera.action takes camera-time-set (camera required); there are no camera.ftp.setup or camera.time.set commands', () => {
    expect(strictValid('commands/camera.action.args', { v: 1, camera: 'cam1', action: 'camera-time-set' }), strictErrors()).toBe(true);
    expect(strictValid('commands/camera.action.args', { v: 1, camera: null, action: 'camera-time-set' })).toBe(false);
    for (const c of ['camera.ftp.setup', 'camera.time.set']) expect(() => readFileSync(join(__dirname, '../contract/v1/strict/commands', `${c}.args.schema.json`)), c).toThrow();
  });
  it('the journal budget counts camera-time-set with the disruptive camera actions; camera.onboarding.get is not counted', () => {
    const v = all.find((x) => x.name === 'valid-command-camera-time-set')!;
    const at = (i: number) => v.$context.now - (i + 1) * 60_000;
    const entry = (i: number, command: string, action?: string) => ({ cmdId: `cmd_${String(i).padStart(20, '0')}`, command, at: at(i), ...(action ? { action } : {}) });
    const mixed = [0, 1, 2].map((i) => entry(i, 'camera.action', 'camera-time-set')).concat([3, 4, 5].map((i) => entry(i, 'camera.action', 'camera-reboot')));
    expect(refCheck(v.message, { ...v.$context, seen: new Set<string>(), journal: mixed })).toMatchObject({ kind: 'nack', code: 'rate_limited' });
    const reads = [0, 1, 2, 3, 4, 5].map((i) => entry(i, 'camera.onboarding.get'));
    expect(refCheck(v.message, { ...v.$context, seen: new Set<string>(), journal: reads })).toEqual({ kind: 'run' });
  });
  it('the time-set not-allowed fixture is refused with not_allowed by the reference check; onboarding.get with camera null runs', () => {
    const f = all.find((x) => x.name === 'refused-camera-action-time-set-not-allowed')!;
    expect(refCheck(f.message, { ...f.$context, seen: new Set(f.$context.seen) })).toEqual({ kind: 'nack', code: 'not_allowed' });
    const g = all.find((x) => x.name === 'valid-command-onboarding-get')!;
    expect(refCheck(g.message, { ...g.$context, seen: new Set(g.$context.seen) })).toEqual({ kind: 'run' });
    const allCams = structuredClone(g.message);
    allCams.body.args = { v: 1, camera: null };
    expect(refCheck(resign(allCams), { ...g.$context, seen: new Set<string>() })).toEqual({ kind: 'run' });
    allCams.body.args = { v: 1, camera: 'cam1', extra: 1 };
    expect(refCheck(resign(allCams), { ...g.$context, seen: new Set<string>() })).toEqual({ kind: 'nack', code: 'invalid_args' });
  });
});

// --- camera move (contract amendments A4, A5, A33, X4, X13, X20) -----------------------------
const MOVE = ['move.begin', 'move.summary', 'move.targets', 'move.open', 'move.offer', 'move.answer', 'move.start', 'move.go', 'move.release', 'move.finish', 'move.cancel', 'move.return.open', 'move.return.start'];
const MV = 'mv_0123456789ABCDEFGHJK';
const RQ = 'rq_0123456789ABCDEFGHJK';
const MV2 = 'mv_1123456789ABCDEFGHJK';
const HASH = 'sha256:' + 'a'.repeat(64);
const FP = 'SHA256:' + 'AB'.repeat(32);
const x25519 = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const KINDS = ['stills', 'clips', 'events', 'checks', 'archive'];
const summary = () => Object.fromEntries(KINDS.map((k) => [k, { files: 2, bytes: 100, rows: 2, oldest: 1791273600000, newest: 1791273700000 }]));
const plan = () => ({ transfer: true, kinds: ['clips', 'events'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 600 });
const cameraConn = { proxyCameraId: 'cam1', name: 'Front door', host: '192.0.2.10', protocol: 'https', user: 'cams', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 };
const spaceOk = { needed: 100, available: 1000, fits: true, perKind: { clips: 90, events: 10 }, retentionProposal: null };
const SRC = { proxyId: 'prx_0123456789ABCDEFGHJK', name: 'Garage', url: 'https://192.0.2.1:8480', caFingerprints: [FP], tlsServername: 'proxy.example.net' };
const bounds = { transfer: true, kinds: ['clips'], space: 'fit', maxBudgetS: 3600 };
const args = (c: string): Record<string, unknown> => ({
  'move.begin': { v: 1, camera: 'cam1', target: 'prx_1123456789ABCDEFGHJK', bounds },
  'move.summary': { v: 1, camera: 'cam1' },
  'move.targets': { v: 1, requestId: RQ, targets: [{ proxyId: 'prx_0123456789ABCDEFGHJK', name: 'Garage', site: 'garage' }, { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'Pi', site: null }] },
  'move.open': { v: 1, moveId: MV, requestId: RQ, camera: 'cam1', tokenHash: 'sha256:' + 'a'.repeat(64), targetIp: '192.0.2.20' },
  'move.offer': {
    v: 1, moveId: MV, token: 'tok-placeholder', source: { proxyId: 'prx_0123456789ABCDEFGHJK', name: 'Garage', url: 'https://192.0.2.1:8480', caFingerprints: [FP], tlsServername: 'proxy.example.net' },
    camera: { camsId: 'cam1', ...cameraConn }, summary: summary(), settings: { name: 'Front door' },
  },
  'move.answer': { v: 1, moveId: MV, requestId: RQ, target: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'Pi' }, accept: true, space: spaceOk, estimateS: 600 },
  'move.start': { v: 1, moveId: MV, plan: plan(), settings: {}, done: ['clips:2026-10-20'] },
  'move.go': { v: 1, moveId: MV, plan: plan(), targetPublicKey: x25519, expectedLeaf: FP },
  'move.release': { v: 1, moveId: MV },
  'move.finish': { v: 1, moveId: MV, role: 'source', abandoned: false },
  'move.cancel': { v: 1, moveId: MV, role: 'target', copied: 'delete' },
  'move.return.open': { v: 1, moveId: MV, returnOf: MV2, tokenHash: HASH, targetIp: '192.0.2.10' },
  'move.return.start': { v: 1, moveId: MV, returnOf: MV2, token: 'x'.repeat(43), source: SRC, done: [] },
}[c] as Record<string, unknown>);
const argsOk = (c: string, a: unknown) => strictValid(`commands/${c}.args`, a);
const resultOk = (c: string, r: unknown) => strictValid(`commands/${c}.result`, r);

describe('move commands', () => {
  it.each(MOVE)('%s has args and result schemas, strict and lenient', (c) => {
    expect(strictValid(`commands/${c}.args`, args(c)), `${c} ${strictErrors()}`).toBe(true);
    for (const dir of ['strict/commands', 'commands']) {
      expect(() => readFileSync(join(__dirname, '../contract/v1', dir, `${c}.args.schema.json`))).not.toThrow();
      expect(() => readFileSync(join(__dirname, '../contract/v1', dir, `${c}.result.schema.json`))).not.toThrow();
    }
  });
  it.each(MOVE)('%s is a wire command and refuses another args version, an extra field and a bad move id (strict)', (c) => {
    expect(WIRE_COMMANDS as readonly string[]).toContain(c);
    expect(argsOk(c, { ...args(c), v: 2 })).toBe(false);
    expect(argsOk(c, { ...args(c), extra: 1 })).toBe(false);
    if (c !== 'move.targets' && c !== 'move.begin' && c !== 'move.summary') expect(argsOk(c, { ...args(c), moveId: 'mv_0123456789ABCDEFGHJI' })).toBe(false);
  });
  it('move.begin args: bounds null or the closed bounds object', () => {
    const ok = args('move.begin') as { bounds: Record<string, unknown> };
    expect(argsOk('move.begin', ok)).toBe(true);
    expect(argsOk('move.begin', { ...ok, bounds: null })).toBe(true);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 59 } })).toBe(false);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 604801 } })).toBe(false);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 60 } })).toBe(true);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 604800 } })).toBe(true);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, kinds: ['clips', 'clips'] } })).toBe(false);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, space: 'some' } })).toBe(false);
    expect(argsOk('move.begin', { ...ok, bounds: { ...ok.bounds, extra: 1 } })).toBe(false);
    expect(argsOk('move.begin', { ...ok, password: 'x' })).toBe(false);
    expect(argsOk('move.begin', { ...ok, bounds: undefined })).toBe(false);
    expect(argsOk('move.begin', { ...ok, target: 'proxy-b' })).toBe(false);
  });
  it('move.summary: args {v, camera} closed; the result is {summary}, the summary shape of move.request', () => {
    expect(argsOk('move.summary', { v: 1, camera: 'cam1' })).toBe(true);
    expect(argsOk('move.summary', { v: 1 })).toBe(false);
    expect(argsOk('move.summary', { v: 1, camera: 'Cam 1' })).toBe(false);
    expect(argsOk('move.summary', { v: 1, camera: 'cam1', target: 'prx_1123456789ABCDEFGHJK' })).toBe(false);
    expect(resultOk('move.summary', { summary: summary() })).toBe(true);
    expect(resultOk('move.summary', {})).toBe(false);
    expect(resultOk('move.summary', { summary: summary(), extra: 1 })).toBe(false);
    const { archive: _a, ...four } = summary();
    expect(resultOk('move.summary', { summary: four })).toBe(false);
    expect(resultOk('move.summary', { summary: { ...summary(), clips: { files: 1, bytes: 1, rows: 1, oldest: null, newest: null } } })).toBe(true);
    expect(resultOk('move.summary', { summary: { ...summary(), clips: { files: -1, bytes: 1, rows: 1, oldest: null, newest: null } } })).toBe(false);
    // The same shape as move.request's summary.
    const strictSchema = (n: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/strict', n), 'utf8'));
    const ev = strictSchema('event.schema.json').properties.body.anyOf.find((b: any) => b.properties?.kind?.const === 'move.request');
    expect(strictSchema('commands/move.summary.result.schema.json').properties.summary).toEqual(ev.properties.summary);
    const r = all.find((x) => x.name === 'valid-result-move-summary')!;
    expect(r.$command).toBe('move.summary');
    expect(resultOk('move.summary', r.message.body.result)).toBe(true);
  });
  it('move.begin result is {requestId}; the refusal codes are exported', () => {
    expect(resultOk('move.begin', { requestId: RQ })).toBe(true);
    expect(resultOk('move.begin', {})).toBe(false);
    expect(MOVE_BEGIN_REFUSALS).toEqual(['no_site_ca', 'external_cert', 'moves_not_allowed', 'busy', 'unknown_camera']);
  });
  it('heartbeat allow enum contains move.send and move.receive', () => {
    expect(ALLOW_ENTRIES).toEqual(expect.arrayContaining(['move.send', 'move.receive']));
    const hb = JSON.parse(readFileSync(join(__dirname, '../contract/v1/strict/heartbeat.schema.json'), 'utf8'));
    expect(JSON.stringify(hb)).toContain('"move.send"');
    expect(JSON.stringify(hb)).toContain('"move.receive"');
  });
  it('move.offer refuse reasons are the closed list; move.answer adds eight', () => {
    const offerReasons = ['moves_not_allowed', 'camera_unreachable', 'camera_limit', 'id_taken', 'busy', 'incompatible', 'no_site_ca', 'ca_does_not_cover_camera', 'external_cert'];
    const answerReasons = [...offerReasons, 'other_account', 'target_offline', 'not_routed', 'host_overridden', 'target_failed', 'offer_expired', 'not_registered', 'internal'];
    for (const reason of offerReasons) expect(resultOk('move.offer', { accept: false, reason }), reason).toBe(true);
    expect(resultOk('move.offer', { accept: false, reason: 'other_account' })).toBe(false);
    for (const reason of answerReasons) expect(argsOk('move.answer', { ...(args('move.answer') as object), accept: false, reason }), reason).toBe(true);
    expect(argsOk('move.answer', { ...(args('move.answer') as object), accept: false, reason: 'nope' })).toBe(false);
  });
  it('move.offer result: accepted with space and probe rate, or refused with a reason', () => {
    expect(resultOk('move.offer', { accept: true, space: spaceOk, probeBps: 1000000 })).toBe(true);
    expect(resultOk('move.offer', { accept: true, space: spaceOk })).toBe(false);
    expect(resultOk('move.offer', { accept: false })).toBe(false);
    expect(resultOk('move.offer', { accept: true, reason: 'busy', space: spaceOk, probeBps: 1 })).toBe(false);
  });
  it('move.offer carries the token and the camera connection fields, never a password', () => {
    const a = args('move.offer') as { camera: Record<string, unknown> };
    expect(argsOk('move.offer', { ...(a as object), camera: { ...a.camera, password: 'x' } })).toBe(false);
    expect(argsOk('move.offer', { ...(a as object), settings: { name: null } })).toBe(false);
    expect(argsOk('move.offer', { ...(a as object), source: { ...(args('move.offer') as { source: object }).source, caFingerprints: ['sha256:ab'] } })).toBe(false);
  });
  it('move.targets: proxy id, name and a site that is null or a short lower-case name', () => {
    const t = (site: unknown) => ({ ...(args('move.targets') as object), targets: [{ proxyId: 'prx_0123456789ABCDEFGHJK', name: 'Garage', site }] });
    expect(argsOk('move.targets', t('a'.repeat(31)))).toBe(true);
    expect(argsOk('move.targets', t('a'.repeat(32)))).toBe(false);
    expect(argsOk('move.targets', t('-bad'))).toBe(false);
    expect(argsOk('move.targets', t('Upper'))).toBe(false);
    expect(resultOk('move.targets', {})).toBe(true);
    expect(argsOk('move.targets', { v: 1, requestId: 'short', targets: [] })).toBe(false);
  });
  it('move.start result: an X25519 SPKI public key and the leaf fingerprint', () => {
    expect(x25519).toHaveLength(60);
    expect(resultOk('move.start', { publicKey: x25519, leafFingerprint: FP })).toBe(true);
    expect(resultOk('move.start', { publicKey: x25519.slice(0, 40), leafFingerprint: FP })).toBe(false);
    expect(resultOk('move.start', { publicKey: x25519, leafFingerprint: FP.toLowerCase() })).toBe(false);
    expect(argsOk('move.go', { ...(args('move.go') as object), expectedLeaf: 'SHA256:ab' })).toBe(false);
    expect(argsOk('move.go', { ...(args('move.go') as object), targetPublicKey: 'AAAA' })).toBe(false);
    // An Ed25519 SPKI (MCowBQYDK2Vw...) has the same length but is not an X25519 key.
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(ed).toHaveLength(60);
    expect(ed.startsWith('MCowBQYDK2Vw')).toBe(true);
    expect(x25519.startsWith('MCowBQYDK2VuAyEA')).toBe(true);
    expect(argsOk('move.go', { ...(args('move.go') as object), targetPublicKey: ed })).toBe(false);
    expect(resultOk('move.start', { publicKey: ed, leafFingerprint: FP })).toBe(false);
  });
  it('plan: kinds, space choice, target settings (paths to leaves) or null', () => {
    const p = (o: object) => ({ ...(args('move.start') as object), plan: { ...plan(), ...o } });
    expect(argsOk('move.start', p({ targetSettings: { 'retention.clipsDays': 30 } }))).toBe(true);
    for (const space of ['all', 'omit', 'fit', 'retention']) expect(argsOk('move.start', p({ space })), space).toBe(true);
    expect(argsOk('move.start', p({ space: 'some' }))).toBe(false);
    expect(argsOk('move.start', p({ kinds: ['photos'] }))).toBe(false);
    expect(argsOk('move.start', p({ targetSettings: { 'Bad path': 1 } }))).toBe(false);
    expect(argsOk('move.start', p({ targetSettings: { 'retention.clipsDays': { a: 1 } } }))).toBe(false);
    expect(argsOk('move.start', { ...(args('move.start') as object), done: ['clips'] })).toBe(false);
  });
  it('A4: move.cancel needs copied only when role is target', () => {
    const c = (o: object) => ({ v: 1, moveId: MV, ...o });
    expect(argsOk('move.cancel', c({ role: 'source', expectedLeaf: FP }))).toBe(true);
    expect(argsOk('move.cancel', c({ role: 'source' }))).toBe(true);
    expect(argsOk('move.cancel', c({ role: 'target', copied: 'age-out' }))).toBe(true);
    expect(argsOk('move.cancel', c({ role: 'target' }))).toBe(false);
    expect(argsOk('move.cancel', c({ role: 'target', copied: 'keep' }))).toBe(false);
    expect(argsOk('move.cancel', c({ role: 'both', copied: 'delete' }))).toBe(false);
  });
  it('A5: move.finish names the side; X13: its result keys are only the five kinds', () => {
    expect(argsOk('move.finish', { v: 1, moveId: MV, role: 'target', abandoned: true })).toBe(true);
    expect(argsOk('move.finish', { v: 1, moveId: MV, abandoned: false })).toBe(false);
    expect(argsOk('move.finish', { v: 1, moveId: MV, role: 'source' })).toBe(false);
    expect(resultOk('move.finish', { deleted: { clips: { files: 3, bytes: 30 }, stills: { files: 0, bytes: 0 } } })).toBe(true);
    expect(resultOk('move.finish', { deleted: {} })).toBe(true);
    expect(resultOk('move.finish', { deleted: { recordings: { files: 1, bytes: 1 } } })).toBe(false);
    expect(resultOk('move.finish', { deleted: { clips: { files: 3 } } })).toBe(false);
  });
  it('move.return.open and move.return.start are strict move commands', () => {
    expect(MOVE_COMMANDS).toContain('move.return.open');
    expect(argsOk('move.return.open', args('move.return.open'))).toBe(true);
    expect(argsOk('move.return.open', { ...(args('move.return.open') as object), camera: 'cam1' })).toBe(false);
    expect(argsOk('move.return.open', { ...(args('move.return.open') as object), returnOf: undefined })).toBe(false);
    expect(argsOk('move.return.start', args('move.return.start'))).toBe(true);
    expect(argsOk('move.return.start', { ...(args('move.return.start') as object), done: Array(513).fill('clips:2026-10-20') })).toBe(false);
    expect(resultOk('move.return.open', { chunks: 3, bytes: 1024 })).toBe(true);
    expect(resultOk('move.return.open', { chunks: 3 })).toBe(false);
    expect(resultOk('move.return.start', {})).toBe(true);
  });
  it('move.finish takes an optional return flag', () => {
    expect(argsOk('move.finish', { v: 1, moveId: MV, role: 'source', abandoned: false, return: true })).toBe(true);
    expect(argsOk('move.finish', { v: 1, moveId: MV, role: 'source', abandoned: false })).toBe(true);
    expect(argsOk('move.finish', { v: 1, moveId: MV, role: 'source', abandoned: false, return: 'yes' })).toBe(false);
  });
  it('return entries: open needs move.receive, start move.send, finish+return flips the role mapping', () => {
    const run = (name: string, a: object, allow: string[]) => {
      const f = all.find((x) => x.name === 'valid-command-move-open')!;
      const m = resign({ ...f.message, body: { ...f.message.body, command: name, args: a } });
      return refCheck(m, { ...f.$context, allow, seen: new Set() });
    };
    expect(run('move.return.open', args('move.return.open') as object, ['move.receive']).kind).toBe('run');
    expect(run('move.return.open', args('move.return.open') as object, ['move.send'])).toEqual({ kind: 'nack', code: 'not_allowed' });
    expect(run('move.return.start', args('move.return.start') as object, ['move.send']).kind).toBe('run');
    expect(run('move.return.start', args('move.return.start') as object, ['move.receive'])).toEqual({ kind: 'nack', code: 'not_allowed' });
    const fin = (role: string) => ({ v: 1, moveId: MV, role, abandoned: false, return: true });
    expect(run('move.finish', fin('source'), ['move.receive']).kind).toBe('run');
    expect(run('move.finish', fin('source'), ['move.send'])).toEqual({ kind: 'nack', code: 'not_allowed' });
    expect(run('move.finish', fin('target'), ['move.send']).kind).toBe('run');
  });
  it('a refusal may carry a detail (1-300 characters): move.offer result and move.answer args, both optional', () => {
    const fxr = (n: string) => all.find((x) => x.name === n)!.message.body.result;
    const refused = fxr('valid-result-move-offer-refused-detail');
    expect(refused).toMatchObject({ accept: false, reason: 'incompatible', detail: expect.any(String) });
    expect(resultOk('move.offer', refused)).toBe(true);
    expect(resultOk('move.offer', fxr('valid-result-move-offer-refused'))).toBe(true);
    expect(resultOk('move.offer', { ...refused, detail: '' })).toBe(false);
    expect(resultOk('move.offer', { ...refused, detail: 'x'.repeat(301) })).toBe(false);
    expect(resultOk('move.offer', { ...refused, detail: 'x'.repeat(300) })).toBe(true);
    expect(resultOk('move.offer', { ...refused, extra: 1 })).toBe(false);
    const ans = all.find((x) => x.name === 'valid-command-move-answer-refused-detail')!.message.body.args;
    expect(argsOk('move.answer', ans)).toBe(true);
    const { detail: _d, ...noDetail } = ans;
    expect(argsOk('move.answer', noDetail)).toBe(true);
    expect(argsOk('move.answer', { ...ans, detail: '' })).toBe(false);
    expect(argsOk('move.answer', { ...ans, detail: 'x'.repeat(301) })).toBe(false);
  });
  it('move.answer with kinds: lenient and strict valid; kinds [ptz, ptz] or [video] refused', () => {
    const f = all.find((x) => x.name === 'valid-command-move-answer-kinds')!;
    const a = f.message.body.args;
    expect(f.$context.feature).toBe('move-ptz');
    expect(a.kinds).toEqual(['stills', 'clips', 'events', 'checks', 'archive', 'ptz']);
    expect(argsOk('move.answer', a), strictErrors()).toBe(true);
    const lenient = new Ajv2020({ strict: true, strictTypes: false }).compile(JSON.parse(readFileSync(join(__dirname, '../contract/v1/commands/move.answer.args.schema.json'), 'utf8')));
    expect(lenient(a)).toBe(true);
    expect(argsOk('move.answer', { ...a, kinds: ['ptz'] })).toBe(true);
    expect(argsOk('move.answer', { ...a, kinds: ['ptz', 'ptz'] })).toBe(false);
    expect(argsOk('move.answer', { ...a, kinds: ['video'] })).toBe(false);
    expect(argsOk('move.answer', { ...a, kinds: [...a.kinds, 'clips'] })).toBe(false);
    expect(argsOk('move.answer', args('move.answer'))).toBe(true); // without kinds
  });
  it('the move.offer result with kinds validates; without kinds still does', () => {
    const r = all.find((x) => x.name === 'valid-result-move-offer-kinds')!;
    expect(r.$command).toBe('move.offer');
    const res = r.message.body.result;
    expect(res).toMatchObject({ accept: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive', 'ptz'] });
    expect(resultOk('move.offer', res), strictErrors()).toBe(true);
    expect(resultOk('move.offer', { accept: true, space: spaceOk, probeBps: 1 })).toBe(true);
    expect(resultOk('move.offer', { accept: true, space: spaceOk, probeBps: 1, kinds: ['ptz', 'ptz'] })).toBe(false);
    expect(resultOk('move.offer', { accept: true, space: spaceOk, probeBps: 1, kinds: ['video'] })).toBe(false);
    expect(resultOk('move.offer', { accept: false, reason: 'busy', kinds: ['ptz'] })).toBe(false);
  });
  it('plan and bounds take ptz; space.perKind does not', () => {
    expect(argsOk('move.start', { ...(args('move.start') as object), plan: { ...plan(), kinds: ['clips', 'ptz'] } })).toBe(true);
    expect(argsOk('move.start', { ...(args('move.start') as object), plan: { ...plan(), transfer: false, kinds: ['ptz'] } })).toBe(true);
    expect(argsOk('move.start', { ...(args('move.start') as object), done: ['ptz:2026-10-30'] })).toBe(true);
    expect(argsOk('move.begin', { ...(args('move.begin') as object), bounds: { ...bounds, kinds: ['ptz'] } })).toBe(true);
    expect(argsOk('move.answer', { ...(args('move.answer') as object), space: { ...spaceOk, perKind: { ptz: 1 } } })).toBe(false);
    expect(argsOk('move.offer', { ...(args('move.offer') as object), summary: { ...summary(), ptz: { files: 1, bytes: 1, rows: 1, oldest: null, newest: null } } })).toBe(false);
  });
  it('A33: the token is a plain string in move.offer only; move.open carries its hash', () => {
    expect(argsOk('move.offer', { ...(args('move.offer') as object), token: undefined })).toBe(false);
    expect(argsOk('move.open', { ...(args('move.open') as object), tokenHash: 'sha256:ABC' })).toBe(false);
    expect(argsOk('move.open', { ...(args('move.open') as object), token: 'x' })).toBe(false);
  });
  it('move fixtures: the valid ones pass their args schema; the refused ones fail it or the allow check', () => {
    const names = readdirSync(DIR).map((f) => f.replace(/\.json$/, '')).filter((n) => /-move-/.test(n));
    expect(names.filter((n) => n.startsWith('valid-command-move-') && n !== 'valid-command-move-begin-no-bounds' && n !== 'valid-command-move-finish-return' && n !== 'valid-command-move-answer-refused-detail' && n !== 'valid-command-move-answer-kinds').sort()).toEqual(MOVE.map((c) => `valid-command-${c.replaceAll('.', '-')}`).sort());
    for (const f of all.filter((x) => /^valid-command-move-/.test(x.name))) expect(argsOk(f.message.body.command, f.message.body.args), f.name).toBe(true);
    expect(names.filter((n) => n.startsWith('valid-command-move-begin')).sort()).toEqual(['valid-command-move-begin', 'valid-command-move-begin-no-bounds']);
    const ns = all.find((x) => x.name === 'refused-move-summary-not-allowed')!;
    expect(ns.$expect).toEqual({ runtime: 'not_allowed', strict: 'valid', receiver: 'proxy' });
    expect(ns.$context.allow).not.toContain('move.send');
    expect(argsOk('move.summary', ns.message.body.args)).toBe(true);
    expect(all.find((x) => x.name === 'valid-command-move-begin-no-bounds')!.message.body.args.bounds).toBeNull();
    const nb = all.find((x) => x.name === 'refused-move-begin-not-allowed')!;
    expect(nb.$expect).toEqual({ runtime: 'not_allowed', strict: 'valid', receiver: 'proxy' });
    expect(nb.$context.allow).not.toContain('move.send');
    expect(argsOk('move.begin', nb.message.body.args)).toBe(true);
    const na = all.find((x) => x.name === 'refused-move-offer-not-allowed')!;
    expect(na.$expect).toEqual({ runtime: 'not_allowed', strict: 'valid', receiver: 'proxy' });
    expect(na.$context.allow).not.toContain('move.receive');
    const tc = all.find((x) => x.name === 'refused-move-cancel-target-no-copied')!;
    expect(tc.$expect.runtime).toBe('invalid_args');
    expect(argsOk('move.cancel', tc.message.body.args)).toBe(false);
  });
  it('the reference check gates each move command by role: source commands need move.send, target commands move.receive', () => {
    const send = ['move.begin', 'move.summary', 'move.targets', 'move.open', 'move.answer', 'move.go', 'move.release', 'move.finish'];
    const recv = ['move.offer', 'move.start'];
    for (const c of [...send, ...recv]) {
      const f = all.find((x) => x.name === `valid-command-${c.replaceAll('.', '-')}`)!;
      const want = recv.includes(c) ? 'move.receive' : 'move.send';
      const other = recv.includes(c) ? 'move.send' : 'move.receive';
      expect(f.$context.allow, c).toEqual([want]);
      expect(refCheck(f.message, { ...f.$context, seen: new Set() }).kind, c).toBe('run');
      expect(refCheck(f.message, { ...f.$context, seen: new Set(), allow: [other] }), c).toEqual({ kind: 'nack', code: 'not_allowed' });
    }
  });
  it('move.finish and move.cancel are gated by args.role', () => {
    for (const [c, role, entry] of [['move.finish', 'target', 'move.receive'], ['move.cancel', 'source', 'move.send']] as const) {
      const f = all.find((x) => x.name === `valid-command-${c.replaceAll('.', '-')}`)!;
      const m = structuredClone(f.message);
      m.body.args.role = role;
      if (role === 'source') delete m.body.args.copied;
      const ctx = { ...f.$context, seen: new Set<string>() };
      expect(refCheck(resign(m), { ...ctx, allow: [entry] }).kind, `${c} ${role}`).toBe('run');
      expect(refCheck(resign(m), { ...ctx, seen: new Set(), allow: [entry === 'move.send' ? 'move.receive' : 'move.send'] }), `${c} ${role}`).toEqual({ kind: 'nack', code: 'not_allowed' });
    }
  });
  it('a move command from a proxy is still unsupported_type at the server', () => {
    const f = all.find((x) => x.name === 'valid-command-move-release')!;
    expect(validateMessage(f.message)).toMatchObject({ ok: false, code: 'unsupported_type' });
  });
});
