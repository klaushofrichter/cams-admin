// Site-CA pins from the proxy's report (cam-proxy onboarding design §5): a proxy whose registry row has no pins
// takes the fingerprints its enrolled proxy reports on the next heartbeat; a change of existing pins is never
// automatic (take() on the proxy page, or an ops `registry` token). An unreadable report is never taken.
import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

const FP1 = `SHA256:${'AB'.repeat(32)}`;
const FP2 = `SHA256:${'CD'.repeat(32)}`;
const FP3 = `SHA256:${'EF'.repeat(32)}`;
let n = 0;
const acc = a.registry.createAccount('admin@example.com', { name: 'pins', displayName: 'Pins' }).id;
const mkProxy = (state: 'enrolled' | 'pending' | 'revoked' = 'enrolled', caFingerprints: string[] = []) => {
  const p = a.registry.createProxy('admin@example.com', acc, { name: `pp${n++}`, displayName: 'P', runsOn: 'local-host', caFingerprints }).id;
  a.db.prepare('UPDATE proxies SET state = ? WHERE id = ?').run(state, p);
  return p;
};
const hb = (p: string, caFingerprint: unknown) => a.status.heartbeat(p, {
  summary: makeSummary({ cameras: 1, now: Date.now() }), truncated: false,
  proxy: { ...makeProxyInfo({ now: Date.now() }), tls: { site: 'home', caFingerprint } },
}, Date.now());
const audits = (p: string) => (a.db.prepare(`SELECT actor, actor_type, detail FROM audit_log WHERE action = 'proxy-update' AND target_id = ? ORDER BY id`).all(p) as { actor: string; actor_type: string; detail: string }[])
  .map((r) => ({ actor: r.actor, actorType: r.actor_type, detail: JSON.parse(r.detail) }));
const pins = (p: string) => a.registry.getProxy(acc, p).caFingerprints;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return [(e as { status: number }).status, (e as { code: string }).code]; }
  return 'no error';
};

describe('reported pins', () => {
  it('a proxy without pins takes the reported ones on its heartbeat (audit system:proxy-report, auto true)', () => {
    const p = mkProxy();
    const v = a.registry.getProxy(acc, p).version;
    hb(p, [FP1, FP2]);
    expect(pins(p)).toEqual([FP1, FP2]);
    expect(a.registry.getProxy(acc, p).version).toBe(v + 1);
    expect(audits(p)).toEqual([{ actor: 'system:proxy-report', actorType: 'system', detail: { fields: ['caFingerprints'], from: 'proxy-report', auto: true } }]);
    expect(a.status.view(p).pin).toBe('match');
    // The next heartbeat writes nothing.
    hb(p, [FP1, FP2]);
    expect(audits(p)).toHaveLength(1);
  });

  it('pins that differ are not changed by a heartbeat; take() changes them (audit with the session actor)', () => {
    const p = mkProxy('enrolled', [FP1]);
    hb(p, [FP3, FP1]);
    expect(pins(p)).toEqual([FP1]);
    expect(audits(p)).toHaveLength(0);
    expect(a.status.view(p).pin).toBe('mismatch');
    const r = a.pins.take('admin@example.com', acc, p);
    expect(r.changed).toBe(true);
    expect(r.proxy.caFingerprints).toEqual([FP3, FP1]);
    expect(audits(p)).toEqual([{ actor: 'admin@example.com', actorType: 'sysadmin', detail: { fields: ['caFingerprints'], from: 'proxy-report', auto: false } }]);
  });

  it('take() with equal pins writes nothing', () => {
    const p = mkProxy('enrolled', [FP1]);
    hb(p, [FP1]);
    const v = a.registry.getProxy(acc, p).version;
    expect(a.pins.take('admin@example.com', acc, p)).toMatchObject({ changed: false, proxy: { caFingerprints: [FP1], version: v } });
    expect(audits(p)).toHaveLength(0);
  });

  it.each([
    ['abc', ['abc']],
    ['three entries', [FP1, FP2, FP3]],
    ['lower-case hex', [FP1.toLowerCase()]],
    ['one good, one bad', [FP1, 'SHA256:XYZ']],
    ['not an array', FP1],
    ['numbers', [42]],
  ] as [string, unknown][])('unreadable reported pins are never taken: %s', (_why, reported) => {
    const p = mkProxy();
    expect(() => hb(p, reported)).not.toThrow();
    expect(a.status.row(p)!.lastHeartbeatAt).not.toBeNull();
    expect(pins(p)).toEqual([]);
    expect(audits(p)).toHaveLength(0);
    expect(code(() => a.pins.take('admin@example.com', acc, p))).toEqual([409, 'no_reported_pins']);
  });

  it('take() without a report is 409 no_reported_pins; another account is 404', () => {
    const p = mkProxy();
    expect(code(() => a.pins.take('admin@example.com', acc, p))).toEqual([409, 'no_reported_pins']);
    const other = a.registry.createAccount('admin@example.com', { name: 'pinsother', displayName: 'O' }).id;
    expect(code(() => a.pins.take('admin@example.com', other, p))).toEqual([404, 'not_found']);
  });

  it('a pending or revoked proxy takes nothing', () => {
    for (const state of ['pending', 'revoked'] as const) {
      const p = mkProxy(state);
      hb(p, [FP1]);
      expect(pins(p)).toEqual([]);
      expect(audits(p)).toHaveLength(0);
    }
  });

  it('the route: POST …/pins/from-report with the session', async () => {
    const p = mkProxy('enrolled', [FP1]);
    hb(p, [FP2]);
    const r = await a.api('post', `/accounts/${acc}/proxies/${p}/pins/from-report`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ changed: true, proxy: { caFingerprints: [FP2] } });
  });
});
