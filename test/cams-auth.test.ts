import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { camsResponseText, generateKeyPair, publicFromB64, verify } from '../server/crypto/ed25519';
import { readEpoch } from '../server/db/open';
import { tmpDir } from './helpers/tmp';
import { fakeClock } from './helpers/clock';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch, type CamsKeyT, type SignOpts } from './helpers/cams';

const REPORT = { v: 1, mode: 'file', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] };

describe('cams-v1 signed requests (CamsAuth)', () => {
  const dir = tmpDir();
  const clock = fakeClock(Date.now());
  let s: Running;
  let acc: { id: string };
  const now = () => clock.now();
  const fresh = async (name: string) => {
    const inst = await s.api('POST', '/cams-instances', { name, displayName: name, accounts: [acc.id] });
    const key = await enrollCamsKey(s, inst.id);
    return { inst, key };
  };
  const call = (key: CamsKeyT, method: string, path: string, body?: unknown, o: SignOpts = {}) => signedFetch(s, key, method, path, body, { now, ...o });
  const sigOk = async (r: Awaited<ReturnType<typeof call>>) => {
    const body = Buffer.from(await r.clone().arrayBuffer());
    return verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(r.status, r.nonce, body), r.headers.get('x-cams-admin-sig'));
  };

  beforeAll(async () => {
    s = await startServer(dir, {}, 0, clock);
    acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
  });
  afterAll(() => s.stop());

  it('a correctly signed request passes; the answer carries X-Cams-Admin-Sig over status, nonce and body', async () => {
    const { key } = await fresh('a1');
    const r = await call(key, 'GET', '/cams/v1/ping');
    expect(r.status).toBe(200);
    expect(await sigOk(r)).toBe(true);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('the first verified request confirms a pending key and sets the instance enrolled; an older active key is revoked re-enrolled', async () => {
    const { inst, key } = await fresh('a2');
    expect(s.built.camsInstances.get(inst.id).state).toBe('pending');
    expect((await call(key, 'GET', '/cams/v1/ping')).status).toBe(200);
    expect(s.built.camsInstances.get(inst.id).state).toBe('enrolled');
    expect(s.built.camsInstances.keys(inst.id)[0]).toMatchObject({ id: key.keyId, confirmedAt: expect.any(Number) });
    const key2 = await enrollCamsKey(s, inst.id);
    // The old key keeps working until the new one signs.
    expect((await call(key, 'GET', '/cams/v1/ping')).status).toBe(200);
    expect((await call(key2, 'GET', '/cams/v1/ping')).status).toBe(200);
    expect(s.built.camsInstances.keys(inst.id).find((k) => k.id === key.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
    const old = await call(key, 'GET', '/cams/v1/ping');
    expect([old.status, (await old.json()).error]).toEqual([401, 'unknown_key']);
    expect(s.built.audit.list({ action: 'cams-key-confirmed' }).items.filter((x) => x.actor === inst.id)).toHaveLength(2);
  });

  const other = generateKeyPair().privateKeyPkcs8B64;
  const cases: [string, SignOpts & { otherInstanceKey?: boolean; blocked?: boolean }, string, number][] = [
    ['missing header', { drop: 'X-Cams-Nonce' }, 'bad_request', 400],
    ['missing signature', { drop: 'X-Cams-Sig' }, 'bad_request', 400],
    ['unknown key', { keyId: 'key_ZZZZZZZZZZZZZZZZZZZZ' }, 'unknown_key', 401],
    ['key of another instance', { otherInstanceKey: true }, 'unknown_key', 401],
    ['signed by another key', { sigWith: other }, 'bad_signature', 401],
    ['body changed after signing', { tamperBody: true }, 'bad_signature', 401],
    ['path changed after signing', { signPath: '/cams/v1/config' }, 'bad_signature', 401],
    ['ts 301 s old', { tsOffset: -301_000 }, 'clock_skew', 401],
    ['revoked instance', { blocked: true }, 'revoked', 403],
  ];
  for (const [name, mutate, code, status] of cases) {
    it(`refuses: ${name} → ${status} ${code} (signed)`, async () => {
      const { inst, key } = await fresh(`r-${name.replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`);
      expect((await call(key, 'GET', '/cams/v1/ping')).status).toBe(200);
      const o: SignOpts = { ...mutate };
      if (mutate.otherInstanceKey) o.instanceId = (await fresh(`o-${inst.name}`.slice(0, 32))).inst.id;
      if (mutate.blocked) await s.api('POST', `/cams-instances/${inst.id}/block`, {});
      const r = await call(key, 'POST', '/cams/v1/report', REPORT, o);
      expect([r.status, (await r.clone().json()).error]).toEqual([status, code]);
      if (mutate.drop === 'X-Cams-Nonce') expect(r.headers.get('x-cams-admin-sig')).toBeNull();
      else expect(await sigOk(r)).toBe(true);
    });
  }

  it('clock_skew carries serverTime, and the answer is signed', async () => {
    const { key } = await fresh('skew');
    const r = await call(key, 'GET', '/cams/v1/ping', undefined, { tsOffset: -3600_000 });
    expect(await sigOk(r)).toBe(true);
    expect(await r.json()).toEqual({ error: 'clock_skew', serverTime: clock.now() });
    // The retry with the offset passes.
    expect((await call(key, 'GET', '/cams/v1/ping', undefined, { ts: clock.now() })).status).toBe(200);
  });

  it('a nonce reused within 10 min is replayed; after the sweep window it is refused by the ts check instead', async () => {
    const { key } = await fresh('nonce');
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    const t0 = clock.now();
    expect((await call(key, 'GET', '/cams/v1/ping', undefined, { nonce, ts: t0 })).status).toBe(200);
    const again = await call(key, 'GET', '/cams/v1/ping', undefined, { nonce, ts: t0 });
    expect([again.status, (await again.json()).error]).toEqual([401, 'replayed']);
    clock.advance(601_000);
    s.built.tick();
    const late = await call(key, 'GET', '/cams/v1/ping', undefined, { nonce, ts: t0 });
    expect([late.status, (await late.json()).error]).toEqual([401, 'clock_skew']);
    clock.advance(60_000); // a fresh minute for the next tests' budgets
  });

  it('61 requests in a minute from one instance → 429 rate_limited with retryAfterS; another instance is unaffected', async () => {
    clock.advance(60_000);
    const a = await fresh('rate-a');
    const b = await fresh('rate-b');
    for (let i = 0; i < 60; i++) expect((await call(a.key, 'GET', '/cams/v1/ping')).status).toBe(200);
    const r = await call(a.key, 'GET', '/cams/v1/ping');
    const j = await r.json();
    expect([r.status, j.error]).toEqual([429, 'rate_limited']);
    expect(j.retryAfterS).toBeGreaterThan(0);
    expect((await call(b.key, 'GET', '/cams/v1/ping')).status).toBe(200);
    clock.advance(61_000);
    expect((await call(a.key, 'GET', '/cams/v1/ping')).status).toBe(200);
  });

  it('a body over 64 KiB → 400 bad_request (signed), nothing parsed', async () => {
    const { key } = await fresh('big');
    const r = await call(key, 'POST', '/cams/v1/report', { ...REPORT, version: 'x'.repeat(70_000) });
    expect([r.status, (await r.clone().json()).error]).toEqual([400, 'bad_request']);
    expect(await sigOk(r)).toBe(true);
  });

  it('an unknown path past the check → 404 not_found, signed; the SPA never answers /cams/', async () => {
    const { key } = await fresh('nf');
    const r = await call(key, 'GET', '/cams/v1/nope');
    expect([r.status, (await r.clone().json()).error]).toEqual([404, 'not_found']);
    expect(await sigOk(r)).toBe(true);
  });

  it('refusals are audited cams-auth-refused, throttled per instance and reason; no header value, nonce or signature in the detail', async () => {
    const { inst, key } = await fresh('aud');
    const nonce = 'CCCCCCCCCCCCCCCCCCCCCC';
    for (let i = 0; i < 5; i++) await call(key, 'GET', '/cams/v1/ping', undefined, { sigWith: other, nonce });
    const rows = s.built.audit.list({ action: 'cams-auth-refused', limit: 200 }).items.filter((x) => x.actor === inst.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'cams', outcome: 'refused', detail: { reason: 'bad_signature' } });
    expect(JSON.stringify(rows)).not.toContain(nonce);
    expect(JSON.stringify(rows)).not.toContain(key.keyId);
  });

  it('refusals for instance ids that do not exist share one audit window (no audit spam from made-up ids)', async () => {
    const { key } = await fresh('ghosts');
    const before = s.built.audit.list({ action: 'cams-auth-refused', limit: 200 }).items.length;
    for (let i = 0; i < 5; i++) await call(key, 'GET', '/cams/v1/ping', undefined, { instanceId: `cms_${String(i).padStart(20, '0')}` });
    const rows = s.built.audit.list({ action: 'cams-auth-refused', limit: 200 }).items;
    expect(rows.length - before).toBeLessThanOrEqual(1);
  });

  it('pulls and pings write nothing once the key is confirmed', async () => {
    const { key } = await fresh('quiet');
    await call(key, 'GET', '/cams/v1/ping');
    const e = readEpoch(s.built.db);
    for (let i = 0; i < 10; i++) await call(key, 'GET', '/cams/v1/ping');
    expect(readEpoch(s.built.db)).toBe(e);
  });

  it('300 failed signatures in 10 min (all instances) → 429 for everyone until the window ends; never keyed on the address', async () => {
    clock.advance(600_001);
    const a = await fresh('fail-a');
    const b = await fresh('fail-b');
    await call(b.key, 'GET', '/cams/v1/ping');
    for (let i = 0; i < 300; i++) await call(a.key, 'GET', '/cams/v1/ping', undefined, { sigWith: other, headers: { 'X-Forwarded-For': `198.51.100.${i % 250}` } });
    const r = await call(b.key, 'GET', '/cams/v1/ping');
    expect([r.status, (await r.json()).error]).toEqual([429, 'rate_limited']);
    clock.advance(600_001);
    expect((await call(b.key, 'GET', '/cams/v1/ping')).status).toBe(200);
  });
});
