// The contract has two implementations of the proxy-side command check in
// this repo's tests: the fixtures (written from the contract table) and the
// reference check in test-client/commands.ts (written from the contract text).
// cam-proxy's real check is the third (scripts/contract/cam-proxy-commands.ts).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { refCheck } from '../test-client/commands';
import { keyFromSeed, privateFromB64, signEnvelope } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';

const DIR = join(__dirname, '../contract/v1/fixtures');
const all = readdirSync(DIR).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
const SERVER = privateFromB64(keyFromSeed(vectors.keys.server.seedHex).privateKeyPkcs8B64);
const resign = (m: Record<string, any>) => { const { sig: _s, ...rest } = m; return { ...rest, sig: signEnvelope(SERVER, rest) }; };

describe('the reference proxy check agrees with every proxy fixture', () => {
  const cases = all.filter((x) => x.$expect?.receiver === 'proxy' || (x.schema === 'command' && x.name.startsWith('valid-')));
  it('covers 36 fixtures (P2 17, P3 19)', () => expect(cases).toHaveLength(36));
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
