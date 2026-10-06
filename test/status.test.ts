import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { FakeRes } from './helpers/live';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

function setup(dir: string) {
  const r = makeRegistry(dir);
  const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 25_000 });
  const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000 });
  const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
  r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(prx.id);
  r.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_1', ?, 'pk', 'fp', 1, 1)`).run(prx.id);
  const res = new FakeRes();
  live.subscribe('s1', res as never);
  const events = () => (r.db.prepare('SELECT kind, camera_ref FROM status_events ORDER BY id').all() as { kind: string; camera_ref: string | null }[]).map((e) => e.kind + (e.camera_ref ? `:${e.camera_ref}` : ''));
  const hb = (o: Parameters<typeof makeSummary>[0] = { cameras: 2, now: r.clock.now() }, info = makeProxyInfo({ now: r.clock.now() })) => store.heartbeat(prx.id, { summary: makeSummary(o), proxy: info, truncated: false }, r.clock.now());
  return { ...r, store, live, acc, prx, res, events, hb };
}

describe('status store', () => {
  const dir = tmpDir();
  const V = 'v2026.10.06.1'; // makeSummary's version

  it('hello, heartbeats, disconnect and ageing out write each transition once', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, 'v2026.10.06.1', s.clock.now() - 5000);
    expect(s.store.view(s.prx.id)).toMatchObject({ state: 'offline', connected: true, skewMs: -5000 });
    s.hb();
    expect(s.store.view(s.prx.id)).toMatchObject({ state: 'online', ok: true, problemCount: 0, cameras: [{ ref: 'cam1', online: true }, { ref: 'cam2', online: true }] });
    s.clock.advance(30_000);
    s.hb();
    s.clock.advance(30_000);
    s.hb({ cameras: 2, now: s.clock.now(), offline: ['cam2'] });
    s.store.disconnected(s.prx.id, '1006');
    s.clock.advance(89_999);
    s.store.tick();
    expect(s.store.view(s.prx.id).state).toBe('online');
    s.clock.advance(1);
    s.store.tick();
    s.store.tick();
    expect(s.store.view(s.prx.id)).toMatchObject({ state: 'offline', cameras: [{ ref: 'cam1', online: null }, { ref: 'cam2', online: null }] });
    expect(s.events()).toEqual(['connected', 'online', 'problems-changed', 'camera-offline:cam2', 'disconnected', 'offline']);
    expect(s.res.events('status').at(-1)).toMatchObject({ proxyId: s.prx.id, state: 'offline' });
  });

  it('a reconnect inside the window shows no outage', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, V, s.clock.now());
    s.hb();
    s.store.disconnected(s.prx.id, '1006');
    s.clock.advance(20_000);
    s.store.hello(s.prx.id, V, s.clock.now());
    s.hb();
    s.clock.advance(60_000);
    s.store.tick();
    expect(s.events()).toEqual(['connected', 'online', 'disconnected', 'connected']);
  });

  it('bye restart shows stopped, not offline, until the next hello', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, V, s.clock.now());
    s.hb();
    s.store.bye(s.prx.id, 'restart');
    s.store.disconnected(s.prx.id, 'bye:restart');
    expect(s.store.view(s.prx.id).state).toBe('stopped');
    s.clock.advance(200_000);
    s.store.tick();
    expect(s.store.view(s.prx.id).state).toBe('stopped');
    s.store.hello(s.prx.id, V, s.clock.now());
    s.hb();
    expect(s.store.view(s.prx.id).state).toBe('online');
    expect(s.events()).toEqual(['connected', 'online', 'stopped', 'disconnected', 'connected', 'online']);
  });

  it('version changes and pin checks become events', () => {
    const s = setup(dir);
    s.reg.updateProxy(ACTOR, s.acc.id, s.prx.id, { caFingerprints: ['AB'.repeat(32)], version: s.reg.getProxy(s.acc.id, s.prx.id).version });
    s.store.hello(s.prx.id, 'v1', s.clock.now());
    s.hb({ cameras: 1, now: s.clock.now(), version: 'v1' }, makeProxyInfo({ now: s.clock.now(), site: 'garage', caFingerprint: ['SHA256:' + 'CD'.repeat(32)] }));
    s.hb({ cameras: 1, now: s.clock.now(), version: 'v2' }, makeProxyInfo({ now: s.clock.now(), site: 'garage', caFingerprint: ['SHA256:' + 'AB'.repeat(32)] }));
    expect(s.events()).toEqual(['connected', 'online', 'pin-mismatch', 'version-changed', 'pin-match']);
    expect(s.store.view(s.prx.id)).toMatchObject({ version: 'v2', pin: 'match' });
  });

  it('an unreadable summary is stored as such and counts as a problem', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, V, s.clock.now());
    s.store.heartbeat(s.prx.id, { summary: { schema: 2 }, truncated: false }, s.clock.now());
    expect(s.store.view(s.prx.id)).toMatchObject({ state: 'online', ok: false, problemCount: 1, unreadable: 'unreadable summary (schema 2)' });
  });

  it('a heartbeat for a proxy deleted meanwhile is ignored', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, V, s.clock.now());
    s.reg.deleteProxy(ACTOR, s.acc.id, s.prx.id);
    expect(() => s.hb()).not.toThrow();
    expect(() => s.store.disconnected(s.prx.id, 'x')).not.toThrow();
    expect(() => s.store.tick()).not.toThrow();
  });

  it('skew over 60 s is a problem on the view', () => {
    const s = setup(dir);
    s.store.hello(s.prx.id, V, s.clock.now() + 600_000);
    s.store.heartbeat(s.prx.id, { summary: makeSummary({ cameras: 1, now: s.clock.now() }), truncated: false }, s.clock.now() + 600_000);
    expect(s.store.view(s.prx.id)).toMatchObject({ skewMs: 600_000, skewProblem: true });
  });
});

describe('live hub', () => {
  it('limits 5 streams per session and sends keep-alive comments', () => {
    const r = { clock: { now: () => 0 } };
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 25_000 });
    const rs = Array.from({ length: 6 }, () => new FakeRes());
    expect(rs.map((x) => live.subscribe('s', x as never))).toEqual([true, true, true, true, true, false]);
    expect(live.subscribe('other', new FakeRes() as never)).toBe(true);
    rs[0].end();
    expect(live.subscribe('s', new FakeRes() as never)).toBe(true);
    live.keepalive();
    expect(rs[1].chunks.at(-1)).toBe(': keep-alive\n\n');
    live.publishRegistry('account', 'acc_1');
    expect(rs[1].events('registry')).toEqual([{ type: 'account', id: 'acc_1' }]);
    expect(rs[1].headers['content-type']).toBe('text/event-stream');
    live.close();
  });

  it('ends a stream whose session is no longer valid at the next keep-alive', () => {
    const live = new LiveHub({ clock: { now: () => 0 }, maxPerSession: 5, keepaliveMs: 0 });
    let valid = true;
    const r = new FakeRes();
    live.subscribe('s', r as never, () => valid);
    live.keepalive();
    expect(r.ended).toBe(false);
    valid = false;
    live.keepalive();
    expect(r.ended).toBe(true);
    expect(live.count()).toBe(0);
  });
});
