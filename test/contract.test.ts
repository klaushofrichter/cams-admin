import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { buildSchemas } from '../contract/build';
import { fixtures } from '../contract/make';
import { validateEnroll, validateMessage, validateSummary } from '../server/contract';

const V1 = join(__dirname, '../contract/v1');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fixtureFiles = readdirSync(join(V1, 'fixtures')).filter((f) => f.endsWith('.json'));

function strictAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  for (const f of readdirSync(join(V1, 'strict'))) ajv.addSchema(read(join(V1, 'strict', f)));
  return ajv;
}
const strictValidate = (ajv: Ajv2020, schema: string, m: unknown) => ajv.validate(`https://cams-admin.skylar.technology/contract/v1/strict/${schema}.schema.json`, m);

// What the server does with one message, as a single verdict.
function runtimeVerdict(schema: string, m: unknown): string {
  if (schema === 'enroll-response') return 'accepted'; // the server writes it; cam-proxy checks it
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
    it(`${file}: strict ${f.$expect ? 'refuses' : 'accepts'}, the server ${f.$expect?.runtime ?? 'accepts'}`, () => {
      expect(strictValidate(ajv, f.schema, f.message), JSON.stringify(ajv.errors)).toBe(!f.$expect);
      expect(runtimeVerdict(f.schema, f.message)).toBe(f.$expect?.runtime ?? 'accepted');
    });
  }

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
