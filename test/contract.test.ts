import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { buildSchemas } from '../contract/build';
import { fixtures } from '../contract/make';
import { validateCommandArgs, validateEnroll, validateMessage, validateSummary } from '../server/contract';
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
    expect(proxyFixtures.length).toBe(15);
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
    expect(validateCommandArgs('config.get', { v: 1 })).toMatchObject({ ok: false });
    expect(strictValidator('commands/tokens.apply.result')(fixture('valid-result-done-ok').message.body.result)).toBe(true);
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
