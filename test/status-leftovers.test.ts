// The heartbeat's moveLeftovers (contract v1 heartbeat `moveLeftovers`): what a proxy could not clean up after a
// camera moved away. Read with clamps; what can't be read is dropped, never the heartbeat.
import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { parseMoveLeftovers } from '../server/status/leftovers';

const MV = 'mv_0123456789ABCDEFGHJK';
const entry = { camera: 'cam4', moveId: MV, items: ['config.json entry', 'env CAMPROXY_CAMERA_PASSWORD_CAM4_FILE'] };

describe('parseMoveLeftovers', () => {
  it('parseMoveLeftovers reads a valid list', () => {
    expect(parseMoveLeftovers([entry])).toEqual([entry]);
    expect(parseMoveLeftovers([entry, { camera: 'cam5', moveId: 'mv_1123456789ABCDEFGHJK', items: ['env CAMPROXY_CAMERA_PASSWORD_CAM5'] }])).toHaveLength(2);
    expect(parseMoveLeftovers(null)).toEqual([]);
    expect(parseMoveLeftovers(undefined)).toEqual([]);
  });
  it.each([
    ['not an array', { a: 1 }, (r: unknown[]) => expect(r).toEqual([])],
    ['20 entries', Array(20).fill(entry), (r: unknown[]) => expect(r).toHaveLength(16)],
    ['an item of 500 characters', [{ ...entry, items: ['x'.repeat(500)] }], (r: any[]) => expect(r[0].items[0]).toHaveLength(80)],
    ['6 items', [{ ...entry, items: ['a', 'b', 'c', 'd', 'e', 'f'] }], (r: any[]) => expect(r[0].items).toEqual(['a', 'b', 'c', 'd'])],
    ['camera 42', [{ ...entry, camera: 42 }], (r: unknown[]) => expect(r).toEqual([])],
    ['moveId x', [{ ...entry, moveId: 'x' }], (r: unknown[]) => expect(r).toEqual([])],
    ['items []', [{ ...entry, items: [] }], (r: unknown[]) => expect(r).toEqual([])],
    ['items of numbers and empty strings', [{ ...entry, items: [1, '', null] }], (r: unknown[]) => expect(r).toEqual([])],
    ['items not an array', [{ ...entry, items: 'config.json entry' }], (r: unknown[]) => expect(r).toEqual([])],
    ['an entry that is null', [null, entry], (r: unknown[]) => expect(r).toEqual([entry])],
  ] as [string, unknown, (r: any[]) => void][])('parseMoveLeftovers clamps and drops: %s', (_why, input, check) => {
    check(parseMoveLeftovers(input));
  });
  it('only the three fields are kept', () => {
    expect(parseMoveLeftovers([{ ...entry, extra: 'x' }])).toEqual([entry]);
  });
});

describe('the heartbeat keeps moveLeftovers', () => {
  const dir = tmpDir();
  function setup() {
    const r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 25_000 });
    const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000 });
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(prx.id);
    const hb = (moveLeftovers: unknown) => store.heartbeat(prx.id, { summary: makeSummary({ cameras: 1, now: r.clock.now() }), proxy: makeProxyInfo({ now: r.clock.now() }), truncated: false, moveLeftovers }, r.clock.now());
    return { ...r, store, prx, hb };
  }
  it('a heartbeat with malformed moveLeftovers is still taken', () => {
    const s = setup();
    s.hb('nope');
    const row = s.store.row(s.prx.id)!;
    expect(row.lastHeartbeatAt).toBe(s.clock.now());
    expect(row.reported?.moveLeftovers).toEqual([]);
  });
  it('a readable list is kept on the reported state; a later heartbeat without it clears it', () => {
    const s = setup();
    s.hb([entry]);
    expect(s.store.row(s.prx.id)!.reported?.moveLeftovers).toEqual([entry]);
    s.hb(undefined);
    expect(s.store.row(s.prx.id)!.reported?.moveLeftovers).toEqual([]);
  });
});
