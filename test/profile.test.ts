// The proxy profile (proxy profile design §2, §3): read from the heartbeat with
// clamps, kept with the reported status (memory and the 10-minute snapshot),
// the precheck rules capacity and ftp_ports, and the request-time space figures.
import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { FakeRes } from './helpers/live';
import { StatusStore } from '../server/status/store';
import { parseProfile } from '../server/status/profile';
import { LiveHub } from '../server/live';
import { makeProfile, makeProxyInfo, makeSummary } from '../test-client/summaries';
import { profileRules } from '../server/moves/precheck';
import { spaceCheck } from '../server/moves/space';

function setup(dir: string, file?: string) {
  const r = makeRegistry(dir, file ? { file } : {});
  const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 25_000 });
  const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000 });
  live.subscribe('s1', new FakeRes() as never);
  return { ...r, store };
}
function proxy(s: ReturnType<typeof setup>) {
  const acc = s.reg.createAccount(ACTOR, { name: `a${Math.random().toString(36).slice(2, 8)}`, displayName: 'Home' });
  const prx = s.reg.createProxy(ACTOR, acc.id, { name: 'een', displayName: 'een', runsOn: 'local-host' });
  s.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(prx.id);
  s.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, 'pk', 'fp', 1, 1)`).run(`key_${prx.id}`, prx.id);
  const hb = (profile?: unknown) => s.store.heartbeat(prx.id, { summary: makeSummary({ cameras: 1, now: s.clock.now() }), proxy: makeProxyInfo({ now: s.clock.now() }), truncated: false, ...(profile === undefined ? {} : { profile }) }, s.clock.now());
  return { acc, prx, hb };
}

describe('parseProfile', () => {
  it('reads the contract shape as it is', () => {
    expect(parseProfile(makeProfile())).toEqual(makeProfile());
    const unset = makeProfile({ set: false, name: null, storageGB: null, ftp: false, passive: null, budgetBytes: null, cpuTempC: null });
    expect(parseProfile(unset)).toEqual(unset);
  });
  it('drops an unreadable profile: no set, cameras or held as the contract has them', () => {
    for (const bad of [null, 'x', [], {}, { ...makeProfile(), set: 'yes' }, { ...makeProfile(), cameras: 0 }, { ...makeProfile(), cameras: 65 }, { ...makeProfile(), held: -1 }, { ...makeProfile(), held: 1.5 }]) {
      expect(parseProfile(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('clamps the rest: text lengths, list sizes, numbers out of range become null', () => {
    const p = parseProfile({
      ...makeProfile(), name: 'x'.repeat(80), storageGB: 0, extra: 1,
      ftp: { enabled: true, port: 70000, passive: { from: 30000, to: 'x' } },
      storage: { budgetBytes: -1, usedBytes: 5, diskBytes: 1.5, freeBytes: 'a' },
      hardware: { pi: 7, cpuCores: 0, cpuModel: 'm'.repeat(150), memoryBytes: -2, load5: -1, cpuTempC: 'hot' },
      warnings: ['profile_ftp_ports', 'profile_ftp_ports', 'w'.repeat(100), 3, ...Array(20).fill('x')],
      firewall: { tool: 'iptables', lines: [...Array(70).fill('l'.repeat(250)), 5] },
    })!;
    expect(p.name).toHaveLength(60);
    expect(p.storageGB).toBeNull();
    expect('extra' in p).toBe(false);
    expect(p.ftp).toEqual({ enabled: true, port: null, passive: null });
    expect(p.storage).toEqual({ budgetBytes: null, usedBytes: 5, diskBytes: null, freeBytes: null });
    expect(p.hardware).toEqual({ pi: null, cpuCores: null, cpuModel: 'm'.repeat(100), memoryBytes: null, load5: null, cpuTempC: null });
    expect(p.warnings[0]).toBe('profile_ftp_ports');
    expect(new Set(p.warnings).size).toBe(p.warnings.length);
    expect(p.warnings.length).toBeLessThanOrEqual(8);
    expect(p.warnings.every((w) => w.length <= 64)).toBe(true);
    expect(p.firewall.tool).toBeNull();
    expect(p.firewall.lines).toHaveLength(64);
    expect(p.firewall.lines[0]).toHaveLength(200);
  });
});

describe('the status store keeps the profile', () => {
  const dir = tmpDir();
  it('the latest heartbeat profile is reported; a heartbeat without one clears it', () => {
    const s = setup(dir);
    const { prx, hb } = proxy(s);
    s.store.hello(prx.id, 'v1', s.clock.now());
    hb(makeProfile());
    expect(s.store.row(prx.id)?.reported?.profile).toEqual(makeProfile());
    hb(makeProfile({ held: 2 }));
    expect(s.store.row(prx.id)?.reported?.profile?.held).toBe(2);
    hb();
    expect(s.store.row(prx.id)?.reported?.profile).toBeNull();
    expect(s.store.row(prx.id)?.reported?.profileUnreadable).toBe(false);
  });
  it('an unreadable profile is null and marked, the heartbeat itself counts', () => {
    const s = setup(dir);
    const { prx, hb } = proxy(s);
    s.store.hello(prx.id, 'v1', s.clock.now());
    hb({ ...makeProfile(), cameras: 0 });
    expect(s.store.view(prx.id).state).toBe('online');
    expect(s.store.row(prx.id)?.reported).toMatchObject({ profile: null, profileUnreadable: true });
  });
  it('a profile change alone writes no status event (the snapshot keeps it) and survives a restart', () => {
    const s = setup(dir);
    const { prx, hb } = proxy(s);
    s.store.hello(prx.id, 'v1', s.clock.now());
    hb(makeProfile());
    const events = () => (s.db.prepare('SELECT count(*) n FROM status_events').get() as { n: number }).n;
    const before = events();
    hb(makeProfile({ held: 3, name: 'een (N100)' }));
    expect(events()).toBe(before);
    s.store.flush(true);
    const again = new StatusStore({ db: s.db, clock: s.clock, registry: s.reg, live: new LiveHub({ clock: s.clock, maxPerSession: 5, keepaliveMs: 25_000 }), offlineAfterMs: 90_000 });
    expect(again.row(prx.id)?.reported?.profile).toMatchObject({ held: 3, name: 'een (N100)' });
  });
});

describe('precheck: capacity and ftp_ports (design §3)', () => {
  const rules = (p: ReturnType<typeof makeProfile> | null) => profileRules('een', p);
  it('skipped (ok) when the target reports no profile', () => {
    expect(rules(null)).toEqual([
      { rule: 'capacity', ok: true, reason: 'camera_limit', detail: 'een reports no profile' },
      { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: 'een reports no profile' },
    ]);
  });
  it('capacity: held < cameras, else camera_limit "een holds 3 of 3 cameras"', () => {
    expect(rules(makeProfile({ cameras: 3, held: 2 }))[0]).toMatchObject({ rule: 'capacity', ok: true });
    expect(rules(makeProfile({ cameras: 3, held: 3 }))[0]).toEqual({ rule: 'capacity', ok: false, reason: 'camera_limit', detail: 'een holds 3 of 3 cameras' });
    expect(rules(makeProfile({ cameras: 3, held: 4 }))[0]).toMatchObject({ ok: false, detail: 'een holds 4 of 3 cameras' });
    // Not set: the defaults are the cameras held, so a proxy that holds one has no room until a person sets it.
    expect(rules(makeProfile({ set: false, cameras: 1, held: 1 }))[0]).toEqual({ rule: 'capacity', ok: false, reason: 'camera_limit', detail: "een holds 1 of 1 camera (its profile is not set: set it on the proxy's home page)" });
  });
  it('ftp_ports: with FTP on, at least 10 × (held + 1) passive ports', () => {
    expect(rules(makeProfile({ held: 1, passive: { from: 30000, to: 30019 } }))[1]).toMatchObject({ rule: 'ftp_ports', ok: true });
    expect(rules(makeProfile({ held: 1, passive: { from: 30000, to: 30009 } }))[1]).toEqual({
      rule: 'ftp_ports', ok: false, reason: 'camera_limit', detail: "een's FTP passive range 30000-30009 has 10 ports; 2 cameras need 20",
    });
    expect(rules(makeProfile({ held: 0, passive: { from: 30000, to: 30009 } }))[1]).toMatchObject({ ok: true });
    expect(rules(makeProfile({ ftp: false, held: 5, passive: null }))[1]).toMatchObject({ ok: true, detail: 'FTP is off on een' });
    expect(rules(makeProfile({ held: 1, passive: null }))[1]).toMatchObject({ ok: true, detail: 'een reports no FTP passive range' });
  });
});

describe('space at request time (design §3: not a precheck rule)', () => {
  const summary = { clips: { files: 10, bytes: 30_000_000_000 }, stills: { files: 100, bytes: 5_000_000_000 }, events: { files: 3, bytes: 1000 }, checks: { files: 0, bytes: 0 }, archive: { files: 1, bytes: 2_000_000_000 } };
  it('compares the summary with the budget left and the per-kind caps', () => {
    const p = makeProfile({ budgetBytes: 600_000_000_000, usedBytes: 41_000_000_000 });
    expect(spaceCheck(summary, p, {}, 1000)).toEqual({
      at: 1000, needBytes: 37_000_001_000, budgetBytes: 600_000_000_000, usedBytes: 41_000_000_000, leftBytes: 559_000_000_000, fits: true, overCaps: [],
    });
    const tight = spaceCheck(summary, makeProfile({ budgetBytes: 50_000_000_000, usedBytes: 41_000_000_000 }), { stills: 4_000_000_000 }, 1000)!;
    expect(tight).toMatchObject({ leftBytes: 9_000_000_000, fits: false, overCaps: [{ kind: 'stills', bytes: 5_000_000_000, capBytes: 4_000_000_000 }] });
    // Over budget already: nothing left (never negative).
    expect(spaceCheck(summary, makeProfile({ budgetBytes: 10, usedBytes: 20 }), {}, 1)!.leftBytes).toBe(0);
  });
  it('null when the target reports no profile or no budget', () => {
    expect(spaceCheck(summary, null, {}, 1)).toBeNull();
    expect(spaceCheck(summary, makeProfile({ budgetBytes: null }), {}, 1)).toBeNull();
    expect(spaceCheck(summary, makeProfile({ usedBytes: null }), {}, 1)).toBeNull();
  });
});
