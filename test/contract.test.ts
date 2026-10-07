import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { ALLOW_ENTRIES, JOURNAL_BUDGET_ACTIONS, buildSchemas, DISRUPTIVE_ACTIONS, LOCAL_ONLY, NEVER_REMOTE_ACTIONS, P3_COMMANDS, PATH_PATTERN, REMOTE_ACTIONS, REMOTE_SETTABLE, SECRET_KEY_PATTERN, CAMERA_NAME_PATTERN } from '../contract/build';
import { fixtures } from '../contract/make';
import { validateCommandArgs, validateEnroll, validateMessage, validateResultPayload, validateSummary } from '../server/contract';
import { publicFromB64, verifyEnvelope } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';

const V1 = join(__dirname, '../contract/v1');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fixtureFiles = readdirSync(join(V1, 'fixtures')).filter((f) => f.endsWith('.json'));

function strictAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  const add = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) add(join(dir, e.name));
      else ajv.addSchema(read(join(dir, e.name)));
    }
  };
  add(join(V1, 'strict'));
  return ajv;
}
const strictValidate = (ajv: Ajv2020, schema: string, m: unknown) => ajv.validate(`https://cams-admin.skylar.technology/contract/v1/strict/${schema}.schema.json`, m);

// Server → proxy messages (challenge, welcome, ack) are the proxy's to judge:
// their verdict is the lenient schema's (a proxy sending one gets unsupported_type).
const lenientAjv = new Ajv2020({ strict: true, strictTypes: false });
const OUTBOUND = ['challenge', 'welcome', 'ack'];
for (const n of OUTBOUND) lenientAjv.addSchema(read(join(V1, `${n}.schema.json`)), n);

// What the receiver does with one message, as a single verdict.
function runtimeVerdict(schema: string, m: unknown): string {
  if (schema === 'enroll-response') return 'accepted'; // the server writes it; cam-proxy checks it
  if (OUTBOUND.includes(schema)) return lenientAjv.validate(schema, m) ? 'accepted' : 'bad_message';
  if (schema.startsWith('enroll-request')) {
    const r = validateEnroll(m);
    return r.ok ? 'accepted' : r.code;
  }
  const r = validateMessage(m);
  if (!r.ok) return r.code;
  if (r.msg.type === 'heartbeat') {
    const b = r.msg.body as { summary: unknown; truncated?: boolean };
    const s = validateSummary(b.summary, b.truncated === true);
    return s.ok ? 'accepted' : 'unreadable_summary';
  }
  return 'accepted';
}

describe('the v1 contract', () => {
  it('committed schemas equal a fresh build (run npm run contract:make)', () => {
    for (const mode of ['lenient', 'strict'] as const) {
      const dir = mode === 'strict' ? join(V1, 'strict') : V1;
      for (const [name, s] of Object.entries(buildSchemas(mode))) expect(read(join(dir, `${name}.schema.json`)), `${mode} ${name}`).toEqual(s);
    }
  });

  it('committed fixtures equal a fresh build', () => {
    const fresh = fixtures();
    expect(fixtureFiles.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(Object.keys(fresh).sort());
    for (const [name, f] of Object.entries(fresh)) expect(read(join(V1, 'fixtures', `${name}.json`)), name).toEqual(JSON.parse(JSON.stringify(f)));
  });

  const ajv = strictAjv();
  for (const file of fixtureFiles) {
    const f = read(join(V1, 'fixtures', file));
    const strictOk = (f.$expect?.strict ?? 'valid') === 'valid';
    // A command is the proxy's to judge (test/contract-commands.test.ts); the server's verdict on the rest.
    const toProxy = f.$expect?.receiver === 'proxy' || (f.schema === 'command' && !f.$expect);
    it(`${file}: strict ${strictOk ? 'accepts' : 'refuses'}, the ${toProxy ? 'proxy' : 'server'} ${f.$expect?.runtime ?? 'accepts'}`, () => {
      expect(strictValidate(ajv, f.schema, f.message), JSON.stringify(ajv.errors)).toBe(strictOk);
      if (!toProxy) expect(runtimeVerdict(f.schema, f.message)).toBe(f.$expect?.runtime ?? 'accepted');
    });
  }

  const allFixtures = () => fixtureFiles.map((file) => ({ name: file.replace(/\.json$/, ''), ...read(join(V1, 'fixtures', file)) }));
  const fixture = (n: string) => read(join(V1, 'fixtures', `${n}.json`));
  const strictValidator = (schema: string) => (m: unknown) => strictValidate(ajv, schema, m);

  it('fixture classes: valid-* and refused-* pass strict; invalid-* and drift-* fail strict', () => {
    const names = allFixtures().map((f) => f.name);
    for (const n of ['valid-command-tokens-apply', 'valid-result-received', 'valid-result-done-ok', 'valid-result-refused-paused', 'valid-event-command-done', 'valid-heartbeat-p2',
      'refused-command-bad-signature', 'refused-command-wrong-proxy', 'refused-command-wrong-conn', 'refused-command-replayed', 'refused-command-expired', 'refused-command-exp-too-far',
      'refused-command-paused', 'refused-command-not-allowed', 'refused-command-args-v2', 'refused-tokens-apply-bad-hash', 'refused-tokens-apply-admin-not-allowed',
      'invalid-command-unsigned', 'invalid-command-unknown-name', 'invalid-type-command', 'drift-result-new-field',
      'valid-command-revocation-while-paused', 'refused-command-revocation-mismatch', 'refused-command-revocation-env-off']) expect(names, n).toContain(n);
    for (const f of allFixtures()) {
      const ok = strictValidator(f.schema)(f.message);
      if (f.name.startsWith('valid-') || f.name.startsWith('refused-')) expect(ok, f.name).toBe(true);
      else expect(ok, f.name).toBe(false);
    }
  });
  it('every proxy-receiver fixture has a $context and a runtime code from the nack list', () => {
    const NACKS = ['bad_signature', 'wrong_target', 'expired', 'replayed', 'not_allowed', 'paused', 'rate_limited', 'invalid_args', 'unsupported_version', 'busy'];
    const proxyFixtures = allFixtures().filter((x) => x.$expect?.receiver === 'proxy');
    expect(proxyFixtures.length).toBe(31);
    for (const f of proxyFixtures) {
      expect(f.$context, f.name).toMatchObject({ now: expect.any(Number), proxyId: expect.stringMatching(/^prx_/), connId: expect.stringMatching(/^con_/), serverKeys: [vectors.keys.server.publicKey] });
      expect(NACKS, f.name).toContain(f.$expect.runtime);
    }
  });
  it('the signed fixtures verify (or fail) as their name says', () => {
    const cmd = fixture('valid-command-tokens-apply');
    expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), cmd.message)).toBe(true);
    expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), fixture('refused-command-bad-signature').message)).toBe(false);
    for (const n of ['valid-result-received', 'valid-result-done-ok', 'valid-result-refused-paused', 'valid-event-command-done', 'drift-result-new-field']) expect(verifyEnvelope(publicFromB64(vectors.keys.proxy.publicKey), fixture(n).message), n).toBe(true);
  });
  it('revocationOnly is an optional boolean of the command body (strict too)', () => {
    const m = fixture('valid-command-revocation-while-paused').message;
    expect(m.body.revocationOnly).toBe(true);
    expect(strictValidator('command')(m)).toBe(true);
    expect(strictValidator('command')({ ...m, body: { ...m.body, revocationOnly: 'yes' } })).toBe(false);
    expect(fixture('valid-command-revocation-while-paused').$context).toMatchObject({ paused: true, allow: [], tokens: expect.any(Array) });
  });
  it('a P1 heartbeat stays valid in strict (the new proxy fields are optional)', () => {
    expect(strictValidator('heartbeat')(fixture('valid-heartbeat-1cam-pi').message)).toBe(true);
    expect(strictValidator('heartbeat')(fixture('valid-heartbeat-p2').message)).toBe(true);
  });
  it('run time: a proxy may send result and event; command from a proxy is unsupported_type', () => {
    expect(validateMessage(fixture('valid-result-done-ok').message)).toMatchObject({ ok: true });
    expect(validateMessage(fixture('valid-event-command-done').message)).toMatchObject({ ok: true });
    expect(validateMessage(fixture('invalid-type-command').message)).toMatchObject({ ok: false, code: 'unsupported_type' });
    expect(validateMessage(fixture('valid-command-tokens-apply').message)).toMatchObject({ ok: false, code: 'unsupported_type' });
    for (const n of ['valid-challenge', 'valid-welcome', 'valid-ack']) expect(validateMessage(fixture(n).message), n).toMatchObject({ ok: false, code: 'unsupported_type' });
    expect(validateMessage(fixture('drift-result-new-field').message)).toMatchObject({ ok: true });
  });
  it('a done result without a status is refused (both modes)', () => {
    const m = structuredClone(fixture('valid-result-done-ok').message);
    delete m.body.status;
    expect(validateMessage(m)).toMatchObject({ ok: false, code: 'bad_message' });
    expect(strictValidator('result')(m)).toBe(false);
  });
  it('what cams-admin sends: tokens.apply args pass the strict args schema', () => {
    const args = fixture('valid-command-tokens-apply').message.body.args;
    expect(validateCommandArgs('tokens.apply', args)).toEqual({ ok: true });
    expect(validateCommandArgs('tokens.apply', fixture('refused-tokens-apply-bad-hash').message.body.args)).toMatchObject({ ok: false });
    expect(validateCommandArgs('tokens.apply', { ...args, tokens: [args.tokens[0], { ...args.tokens[0], hash: 'sha256:' + 'b'.repeat(64) }] })).toEqual({ ok: false, detail: 'duplicate id or hash' });
    expect(validateCommandArgs('tokens.apply', { ...args, tokens: [args.tokens[0], { ...args.tokens[0], id: 'tok_ZZZZZZZZZZZZZZZZZZZZ' }] })).toEqual({ ok: false, detail: 'duplicate id or hash' });
    expect(validateCommandArgs('frobnicate', { v: 1 })).toMatchObject({ ok: false });
    expect(strictValidator('commands/tokens.apply.result')(fixture('valid-result-done-ok').message.body.result)).toBe(true);
  });

  // --- P3: remote configuration ("The P3 contract") ---------------------------
  it('every P3 command has strict args and result schemas; the valid fixtures pass them', () => {
    for (const c of P3_COMMANDS) {
      expect(existsSync(join(V1, 'strict/commands', `${c}.args.schema.json`)), c).toBe(true);
      expect(existsSync(join(V1, 'strict/commands', `${c}.result.schema.json`)), c).toBe(true);
      expect(existsSync(join(V1, 'commands', `${c}.args.schema.json`)), c).toBe(true);
      expect(existsSync(join(V1, 'commands', `${c}.result.schema.json`)), c).toBe(true);
    }
    for (const n of ['valid-command-config-get', 'valid-command-config-set', 'valid-command-config-unset', 'valid-command-config-rollback', 'valid-command-camera-action', 'valid-command-camera-name-set', 'valid-command-proxy-restart']) {
      const m = fixture(n).message;
      expect(strictValidator(`commands/${m.body.command}.args`)(m.body.args), n).toBe(true);
      expect(validateCommandArgs(m.body.command, m.body.args), n).toEqual({ ok: true });
    }
  });
  it('the starred refused fixtures fail their strict args schema (the contract table)', () => {
    for (const n of ['refused-camera-action-never-remote', 'refused-camera-action-no-camera', 'refused-config-set-bad-path', 'refused-config-set-object-value', 'refused-config-set-65-paths', 'refused-camera-name-set-bidi', 'refused-camera-name-set-alm', 'refused-camera-name-set-tag', 'refused-camera-name-set-surrogate']) {
      const m = fixture(n).message;
      expect(strictValidator('command')(m), n).toBe(true);
      expect(strictValidator(`commands/${m.body.command}.args`)(m.body.args), n).toBe(false);
    }
  });
  it('the P3 refused fixtures: each names the nack the contract table says', () => {
    const want: Record<string, string> = {
      'refused-config-set-not-allowed': 'not_allowed', 'refused-camera-action-entry-missing': 'not_allowed', 'refused-camera-action-never-remote': 'not_allowed',
      'refused-camera-action-no-camera': 'invalid_args', 'refused-config-set-bad-path': 'invalid_args', 'refused-config-set-object-value': 'invalid_args',
      'refused-config-set-65-paths': 'invalid_args', 'refused-config-set-args-v2': 'unsupported_version', 'refused-proxy-restart-budget': 'rate_limited',
      'refused-camera-action-budget': 'rate_limited', 'refused-proxy-restart-paused': 'paused', 'refused-camera-name-set-bidi': 'invalid_args', 'refused-camera-name-set-alm': 'invalid_args', 'refused-camera-name-set-tag': 'invalid_args', 'refused-camera-name-set-surrogate': 'invalid_args', 'refused-camera-action-ftp-off': 'not_allowed',
    };
    for (const [n, code] of Object.entries(want)) expect(fixture(n).$expect, n).toEqual({ runtime: code, strict: 'valid', receiver: 'proxy' });
    expect(fixture('refused-config-set-not-allowed').$context.allow).toEqual(['config.get']);
    expect(fixture('refused-camera-action-entry-missing').$context.allow).toEqual(['camera.action:camera-test']);
    expect(fixture('refused-camera-action-never-remote').message.body.args.action).toBe('find-camera');
    expect(fixture('refused-proxy-restart-budget').$context.journal).toHaveLength(2);
    expect(fixture('refused-camera-action-budget').$context.journal).toHaveLength(6);
    for (const e of fixture('refused-camera-action-budget').$context.journal) expect(DISRUPTIVE_ACTIONS).toContain(e.action);
    expect(Object.keys(fixture('refused-config-set-65-paths').message.body.args.set)).toHaveLength(65);
  });
  it('action lists: never-remote and remote are disjoint; disruptive ⊂ remote', () => {
    for (const a of NEVER_REMOTE_ACTIONS) expect(REMOTE_ACTIONS as readonly string[], a).not.toContain(a);
    for (const a of DISRUPTIVE_ACTIONS) expect(REMOTE_ACTIONS as readonly string[], a).toContain(a);
    expect([...DISRUPTIVE_ACTIONS]).toEqual(['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ntp-set', 'camera-cert-push']);
    // Contract change (cam-proxy #196): camera-ftp-off is never remote; the journal budget still counts it.
    expect(NEVER_REMOTE_ACTIONS as readonly string[]).toContain('camera-ftp-off');
    expect(REMOTE_ACTIONS as readonly string[]).not.toContain('camera-ftp-off');
    expect(ALLOW_ENTRIES).not.toContain('camera.action:camera-ftp-off');
    expect([...JOURNAL_BUDGET_ACTIONS].sort()).toEqual([...DISRUPTIVE_ACTIONS, 'camera-ftp-off'].sort());
    const hb = JSON.parse(readFileSync(join(V1, 'strict/heartbeat.schema.json'), 'utf8'));
    expect(JSON.stringify(hb)).not.toContain('camera.action:camera-ftp-off');
  });
  it('remote-settable.json is the contract text; no remote path is denied; narrow ⊂ remote', () => {
    const r = JSON.parse(readFileSync(join(V1, 'remote-settable.json'), 'utf8'));
    expect(r).toEqual(REMOTE_SETTABLE);
    const under = (p: string, d: string) => p === d || p.startsWith(`${d}.`);
    for (const p of r.remote) expect(r.denied.some((d: string) => under(p, d)), p).toBe(false);
    for (const p of Object.keys(r.narrow)) expect(r.remote, p).toContain(p);
    for (const p of r.remote) expect(p).toMatch(new RegExp(PATH_PATTERN.replace('[a-z0-9][A-Za-z0-9-]{0,31}', '(\\*|[a-z0-9][A-Za-z0-9-]{0,31})')));
    expect(r.remote).toHaveLength(37);
    // The coordinator's ruling: no remote write may make a proxy delete data.
    for (const p of ['retention.stillsDays', 'retention.previewsDays', 'retention.clipsDays', 'retention.eventsDays', 'retention.auditDays', 'retention.streamLogDays', 'stills.maxGB', 'previews.maxGB', 'ftp.maxGB']) expect(r.narrow[p], p).toBe('more');
    for (const p of ['analytics.googleVision.monthlyLimit', 'analytics.googleVision.dailyCap', 'analytics.googleVision.checksPerDay', 'analytics.googleVision.perCameraDailyCap']) expect(r.narrow[p], p).toBe('less');
    expect(Object.keys(r.narrow)).toHaveLength(13);
    // Coordinator ruling (security review I4): capture and listener switches and health thresholds are local only in P3.
    const localOnly = ['stills.enabled', 'events.poll.enabled', 'ftp.enabled', 'ftp.stalledHours', 'archive.enabled', 'archive.warnPercent', 'health.diskPercent', 'health.tempC', 'host.stats',
      'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'analytics.googleVision.enabled',
      'cameras.*.stills.enabled', 'cameras.*.ftp.enabled', 'cameras.*.events.poll.enabled', 'cameras.*.analytics.kinds.person', 'cameras.*.analytics.kinds.vehicle', 'cameras.*.analytics.kinds.pet'];
    expect([...LOCAL_ONLY].sort()).toEqual([...localOnly].sort());
    for (const p of localOnly) {
      expect(r.remote, p).not.toContain(p);
      expect(r.denied.some((d: string) => under(p, d)), p).toBe(true);
    }
    for (const p of r.remote) expect(p.endsWith('.enabled'), p).toBe(false);
    // No remote path looks secret; the secret pattern catches the usual names.
    const secret = new RegExp(SECRET_KEY_PATTERN, 'i');
    for (const p of r.remote) expect(secret.test(p), p).toBe(false);
    for (const p of ['camsAdmin.token', 'ftp.password', 'analytics.googleVision.apiKey', 'tls.keyFile', 'x.clientSecret', 'cookie', 'certPem']) expect(secret.test(p), p).toBe(true);
    expect(r.remote.some((p: string) => p.startsWith('storage.') || /^cameras\.\*\.storage\./.test(p))).toBe(false);
    for (const d of ['storage', 'cameras.*.storage', 'camsAdmin', 'cameras.*.host', 'server']) expect(r.denied, d).toContain(d);
  });
  it('results: the P3 result fixtures pass strict and the server; a config.get result with a denied settable entry still passes lenient (the server filters it)', () => {
    for (const n of ['valid-result-config-get', 'valid-result-config-set-ok', 'valid-result-config-set-conflict', 'valid-result-config-set-failed', 'valid-result-camera-action-verified', 'valid-result-config-set-failed-retention', 'valid-result-config-set-failed-storage']) {
      const f = fixture(n);
      expect(P3_COMMANDS as readonly string[], n).toContain(f.$command);
      expect(strictValidator(`commands/${f.$command}.result`)(f.message.body.result), `${n} ${JSON.stringify(ajv.errors)}`).toBe(true);
      expect(validateResultPayload(f.$command, f.message.body.result), n).toBe(true);
      expect(verifyEnvelope(publicFromB64(vectors.keys.proxy.publicKey), f.message), n).toBe(true);
    }
    expect(fixture('valid-result-config-set-failed-retention').message.body).toMatchObject({ status: 'failed', code: 'widening_local_only', result: { paths: [{ path: 'retention.clipsDays', code: 'widening_local_only', detail: 'a remote change may only keep data longer' }] } });
    expect(fixture('valid-result-config-set-failed-storage').message.body).toMatchObject({ status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'storage.maxPercent', code: 'not_remote_settable' }] } });
    const view = structuredClone(fixture('valid-result-config-get').message.body.result);
    view.settable['camsAdmin.url'] = { type: 'string' };
    expect(validateResultPayload('config.get', view)).toBe(true);
    expect(validateResultPayload('config.get', { paths: {} })).toBe(false);
    expect(validateResultPayload('config.set', 'nope')).toBe(false);
  });
  it('config.rollback can fail widening_local_only (a fixture; the README outcomes table)', () => {
    const f = fixture('valid-result-config-rollback-failed-widening');
    expect(f.$command).toBe('config.rollback');
    expect(f.message.body).toMatchObject({ status: 'failed', code: 'widening_local_only', result: { paths: [{ path: 'retention.clipsDays', code: 'widening_local_only' }] } });
    expect(strictValidator('commands/config.rollback.result')(f.message.body.result)).toBe(true);
    expect(readFileSync(join(__dirname, '../contract/README.md'), 'utf8')).toMatch(/`config.rollback` \| the change list \| [^|]+\| `no_backup`, `already_rolled_back`, `not_remote_settable`, `widening_local_only`/);
  });
  it('deny fixtures: a capture switch and a health threshold are refused remotely (not_remote_settable)', () => {
    for (const [n, path] of [['valid-result-config-set-failed-ftp-enabled', 'ftp.enabled'], ['valid-result-config-set-failed-health', 'health.diskPercent']]) {
      const f = fixture(n);
      expect(f.$command).toBe('config.set');
      expect(f.message.body).toMatchObject({ status: 'failed', code: 'not_remote_settable', result: { paths: [{ path, code: 'not_remote_settable' }] } });
      expect(strictValidator('commands/config.set.result')(f.message.body.result)).toBe(true);
    }
  });
  it('validateCommandArgs: what cams-admin sends for every P3 command', () => {
    const REV = `sha256:${'a'.repeat(64)}`;
    expect(validateCommandArgs('config.get', { v: 1 })).toEqual({ ok: true });
    expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': 5 } })).toEqual({ ok: true });
    expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': null } })).toMatchObject({ ok: false });
    expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { __proto__x: 1 } })).toMatchObject({ ok: false });
    expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: {} })).toMatchObject({ ok: false });
    expect(validateCommandArgs('config.unset', { v: 1, dryRun: true, baseRevision: REV, paths: ['sse.pingS', 'sse.pingS'] })).toMatchObject({ ok: false });
    expect(validateCommandArgs('config.unset', { v: 1, dryRun: false, baseRevision: REV, paths: ['sse.pingS'] })).toEqual({ ok: true });
    expect(validateCommandArgs('config.rollback', { v: 1, dryRun: true, cmdId: 'cmd_0123456789ABCDEFGHJK' })).toEqual({ ok: true });
    expect(validateCommandArgs('camera.action', { v: 1, camera: 'cam1', action: 'find-camera' })).toMatchObject({ ok: false }); // never sent
    expect(validateCommandArgs('camera.action', { v: 1, camera: null, action: 'retention-run' })).toEqual({ ok: true });
    expect(validateCommandArgs('camera.action', { v: 1, camera: null, action: 'camera-reboot' })).toMatchObject({ ok: false });
    expect(validateCommandArgs('camera.action', { v: 1, camera: 'cam1', action: 'retention-run' })).toMatchObject({ ok: false });
    expect(validateCommandArgs('camera.action', { v: 1, camera: 'cam1', action: 'inventory', input: { kind: 'clips' } })).toEqual({ ok: true });
    expect(validateCommandArgs('camera.name.set', { v: 1, camera: 'cam1', name: 'a\nb' })).toMatchObject({ ok: false });
    // One name rule (security review M3): no C0/C1, no bidi controls, no line separators, no zero-width characters; ≤ 64.
    for (const bad of ['a\u0085b', 'evil\u202Egnp.exe', 'a\u2066b', 'a\u2028b', 'a\u200Bb', '\uFEFFa', 'x'.repeat(65), 'a\u061Cb', 'a\u{E0041}b', 'a\uD800b', 'a\uE000b', 'a\u0378b']) expect(validateCommandArgs('camera.name.set', { v: 1, camera: 'cam1', name: bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    expect(validateCommandArgs('camera.name.set', { v: 1, camera: 'cam1', name: 'Café 😀 Ost' })).toEqual({ ok: true });
    expect(validateCommandArgs('camera.name.set', fixture('valid-command-camera-name-set-accents').message.body.args)).toEqual({ ok: true });
    expect(fixture('valid-command-camera-name-set-accents').message.body.args.name).toBe('Garage Süd – Einfahrt');
    expect(new RegExp(CAMERA_NAME_PATTERN, 'u').test('evil\u202Egnp')).toBe(false);
    expect(validateCommandArgs('proxy.restart', { v: 1 })).toEqual({ ok: true });
    expect(validateCommandArgs('proxy.restart', { v: 1, now: true })).toMatchObject({ ok: false });
    // 64 entries of 512 characters: within the schema, over the 16 KiB args bound.
    const big = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`sse.p${i}`, 'x'.repeat(512)]));
    expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: big })).toEqual({ ok: false, detail: 'args over 16 KiB' });
  });

  it('the server clamps text over 200 characters', () => {
    const f = read(join(V1, 'fixtures', 'drift-heartbeat-long-label.json'));
    const r = validateSummary(f.message.body.summary, false);
    expect(r.ok && (r.summary as { items: { label: string }[] }).items[0].label.length).toBe(200);
  });

  it('a __proto__ key from a proxy never becomes a prototype', () => {
    const f = read(join(V1, 'fixtures', 'valid-heartbeat-1cam-pi.json'));
    const hostile = JSON.parse(JSON.stringify(f.message.body.summary).replace(/^\{/, '{"__proto__":{"polluted":1,"ok":false},'));
    hostile.camera = JSON.parse(JSON.stringify(hostile.camera).replace(/^\{/, '{"__proto__":{"admin":true},'));
    const r = validateSummary(hostile, false);
    expect(r.ok).toBe(true);
    const out = (r as { summary: Record<string, any> }).summary;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.camera)).toBe(Object.prototype);
    expect(out.camera.admin).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a depth bomb in an unknown field is accepted and never walked deeply', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1000; i++) deep = { d: deep };
    const f = read(join(V1, 'fixtures', 'valid-heartbeat-1cam-pi.json'));
    const s = { ...f.message.body.summary, bomb: deep };
    expect(validateSummary(s, false).ok).toBe(true);
  });

  it('500 random mutations of the four-camera heartbeat: strict and the server agree on what they share', () => {
    const base = read(join(V1, 'fixtures', 'valid-heartbeat-4cam.json')).message.body.summary;
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, p: (string | number)[]) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
      else paths.push(p);
    };
    walk(base, []);
    let refused = 0;
    for (let i = 0; i < 500; i++) {
      const s = structuredClone(base);
      const p = paths[rnd(paths.length)];
      let o = s;
      for (const k of p.slice(0, -1)) o = o[k];
      const last = p[p.length - 1];
      const old = o[last];
      // A type change the server must refuse (strings become objects, the rest strings).
      o[last] = typeof old === 'string' ? { x: 1 } : 'mutated';
      if (old === null) o[last] = { x: 1 };
      const strictOk = strictValidate(ajv, 'health-summary', s);
      const serverOk = validateSummary(s, false).ok;
      // The server is lenient on enums and unknown fields only; every type change here is judged alike.
      if (!strictOk) refused++;
      // (null → {x:1} differs on purpose: lenient objects require little.)
      if (old !== null) expect(serverOk, `${p.join('.')}: ${JSON.stringify(o[last])} for ${JSON.stringify(old)}`).toBe(strictOk);
    }
    expect(refused).toBeGreaterThan(400);
  });
});
