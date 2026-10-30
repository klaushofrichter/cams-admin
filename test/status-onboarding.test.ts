// The heartbeat's onboarding (contract v1 heartbeat `onboarding`, cam-proxy onboarding design §4.5): each camera's
// compact onboarding status. Read with clamps; what can't be read is dropped, never the heartbeat.
import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { parseOnboarding, type CameraOnboarding } from '../server/status/onboarding';

type Map_ = Record<string, CameraOnboarding> | null;

describe('parseOnboarding', () => {
  it('parseOnboarding reads a valid map', () => {
    const x = { cam1: { ready: true, missing: [] }, cam2: { ready: false, missing: ['login', 'ftp'] } };
    expect(parseOnboarding(x)).toEqual(x);
    expect(parseOnboarding({})).toEqual({});
  });
  it('parseOnboarding returns null for none', () => {
    for (const x of [undefined, null, 'x', []]) expect(parseOnboarding(x)).toBeNull();
  });
  it.each([
    ['200 cameras', Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`cam${i}`, { ready: true, missing: [] }])), (r: Map_) => {
      expect(Object.keys(r!)).toHaveLength(64);
      expect(r!.cam0).toBeDefined();
    }],
    ['key Cam 1', { 'Cam 1': { ready: true, missing: [] }, cam2: { ready: true, missing: [] } }, (r: Map_) => expect(Object.keys(r!)).toEqual(['cam2'])],
    ['ready yes', { cam1: { ready: 'yes', missing: [] } }, (r: Map_) => expect(r).toEqual({})],
    ['a value that is not an object', { cam1: 'ready' }, (r: Map_) => expect(r).toEqual({})],
    ['a step of 500 characters', { cam1: { ready: false, missing: ['x'.repeat(500)] } }, (r: Map_) => expect(r!.cam1.missing[0]).toHaveLength(32)],
    ['missing as a string', { cam1: { ready: false, missing: 'login' } }, (r: Map_) => expect(r!.cam1.missing).toEqual([])],
    ['duplicate steps', { cam1: { ready: false, missing: ['ftp', 'ftp', 'time'] } }, (r: Map_) => expect(r!.cam1.missing).toEqual(['ftp', 'time'])],
    ['20 steps', { cam1: { ready: false, missing: Array.from({ length: 20 }, (_, i) => `step${i}`) } }, (r: Map_) => expect(r!.cam1.missing).toHaveLength(16)],
    ['ready true with login missing', { cam1: { ready: true, missing: ['login'] } }, (r: Map_) => expect(r!.cam1).toEqual({ ready: false, missing: ['login'] })],
    ['an unknown step lens', { cam1: { ready: true, missing: ['lens'] } }, (r: Map_) => expect(r!.cam1).toEqual({ ready: true, missing: ['lens'] })],
    ['steps that are not names', { cam1: { ready: false, missing: [42, '', 'Bad step', '-x', 'ftp'] } }, (r: Map_) => expect(r!.cam1.missing).toEqual(['ftp'])],
    ['extra fields', { cam1: { ready: true, missing: [], password: 'x' } }, (r: Map_) => expect(r!.cam1).toEqual({ ready: true, missing: [] })],
  ] as [string, unknown, (r: Map_) => void][])('parseOnboarding clamps and drops: %s', (_why, input, check) => {
    check(parseOnboarding(input));
  });
});

describe('the heartbeat keeps onboarding', () => {
  const dir = tmpDir();
  function setup() {
    const r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 25_000 });
    const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000 });
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(prx.id);
    const hb = (onboarding: unknown) => store.heartbeat(prx.id, { summary: makeSummary({ cameras: 1, now: r.clock.now() }), proxy: makeProxyInfo({ now: r.clock.now() }), truncated: false, onboarding }, r.clock.now());
    const events = (kind: string) => r.db.prepare('SELECT camera_ref, detail FROM status_events WHERE proxy_id = ? AND kind = ?').all(prx.id, kind) as { camera_ref: string; detail: string }[];
    return { ...r, store, prx, hb, events };
  }
  it('the heartbeat keeps onboarding; a later one without it clears it to null', () => {
    const s = setup();
    s.hb('nope');
    expect(s.store.row(s.prx.id)!.lastHeartbeatAt).toBe(s.clock.now());
    expect(s.store.row(s.prx.id)!.reported?.onboarding).toBeNull();
    s.hb({ cam1: { ready: true, missing: [] } });
    expect(s.store.row(s.prx.id)!.reported?.onboarding).toEqual({ cam1: { ready: true, missing: [] } });
    s.hb(undefined);
    expect(s.store.row(s.prx.id)!.reported?.onboarding).toBeNull();
  });
  it('a ready flip writes one status event; the first report and an unchanged one write none', () => {
    const s = setup();
    s.hb({ cam1: { ready: false, missing: ['login'] } });
    s.hb({ cam1: { ready: false, missing: ['login'] } });
    expect(s.events('onboarding-ready')).toEqual([]);
    expect(s.events('onboarding-not-ready')).toEqual([]);
    s.hb({ cam1: { ready: true, missing: ['ftp'] } });
    s.hb({ cam1: { ready: true, missing: ['ftp'] } });
    expect(s.events('onboarding-ready')).toEqual([{ camera_ref: 'cam1', detail: JSON.stringify({ missing: ['ftp'] }) }]);
    s.hb({ cam1: { ready: false, missing: ['stream'] } });
    expect(s.events('onboarding-not-ready')).toEqual([{ camera_ref: 'cam1', detail: JSON.stringify({ missing: ['stream'] }) }]);
    // A camera seen for the first time: no event.
    s.hb({ cam1: { ready: false, missing: ['stream'] }, cam2: { ready: true, missing: [] } });
    expect(s.events('onboarding-ready')).toHaveLength(1);
  });
});
