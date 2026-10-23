// Camera move step 4 (plan Task 18): ended moves age out after the proxy's
// keepDays (30 days when it reported none), pruned at most hourly; never while
// cleanup is pending or a return names the move; an idle hour writes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { readEpoch } from '../server/db/open';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, resetAccounts, startServer, type Running } from './helpers/server';
import { DEFAULT_KEEP_DAYS, PRUNE_EVERY_MS } from '../server/moves/service';
import { RETURN_GRACE_MS } from '../server/moves/store';

const ACTOR = 'admin@example.com';
const DAY = 86_400_000;
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  await s.stop();
});

const store = () => s.built.moves.store;
const epoch = () => readEpoch(s.built.db);
const audits = () => (s.built.db.prepare(`SELECT * FROM audit_log WHERE action = 'moves-pruned' ORDER BY id`).all() as { outcome: string; account_id: string | null; detail: string }[])
  .map((a) => ({ ...a, d: JSON.parse(a.detail) as { count: number; ids: string[] } }));

async function fixture() {
  const src = await enrolled(s, `pr${n++}`, 'home');
  const tgt = await enrolled(s, `pr${n++}`, 'home');
  const cam = s.built.registry.createCamera(ACTOR, src.accountId, { camsId: `cam${n}`, name: 'Cam', kind: 'camera', proxyId: src.proxyId, proxyCameraId: `cam${n}`, host: '192.0.2.10', protocol: 'https' });
  const mk = (requestId: string, o: Record<string, unknown> = {}) => store().create({ accountId: src.accountId, cameraId: cam.id, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, requestId, actor: src.proxyId, ...o } as any);
  return { src, tgt, cam, mk };
}

describe('ended moves age out', () => {
  it('a done move with keepDays 7 is gone 7 days + 1 ms after it ended; chunk states go, audit rows stay', async () => {
    const f = await fixture();
    const m = f.mk('a');
    store().saveChunks(m.id, [{ id: 'c1', state: 'verified' }]);
    store().setPhase(m.id, 'done', { keepDays: 7 });
    s.built.audit.write({ actorType: 'system', actor: 'system', action: 'move-done', accountId: f.src.accountId, targetType: 'camera', targetId: f.cam.id, outcome: 'ok', detail: { moveId: m.id } });
    clock.advance(7 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(0);
    clock.advance(1);
    expect(s.built.moves.pruneEnded()).toBe(1);
    expect(store().get(m.id)).toBeNull();
    expect(s.built.db.prepare('SELECT count(*) n FROM move_chunks WHERE move_id = ?').get(m.id)).toEqual({ n: 0 });
    expect(s.built.db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'move-done'`).get()).toEqual({ n: 1 });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ outcome: 'ok', account_id: f.src.accountId });
    expect(audits()[0].d).toEqual({ count: 1, ids: [m.id] });
  });

  it('without keepDays a move waits the default 30 days', async () => {
    const f = await fixture();
    const m = f.mk('b');
    store().setPhase(m.id, 'done');
    expect(DEFAULT_KEEP_DAYS).toBe(30);
    clock.advance(30 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(0);
    clock.advance(1);
    expect(s.built.moves.pruneEnded()).toBe(1);
  });

  it('cleanup pending keeps a move (source or target) until it lands', async () => {
    const f = await fixture();
    const a = f.mk('c1');
    store().setPhase(a.id, 'done', { cleanupPending: true });
    const b = f.mk('c2');
    store().setPhase(b.id, 'done', { targetCleanupPending: true });
    clock.advance(400 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(0);
    store().setPhase(a.id, 'done', { cleanupPending: false });
    expect(s.built.moves.pruneEnded()).toBe(1);
    expect(store().get(b.id)).not.toBeNull();
  });

  it('a cancelled move with a return is kept until the return is pruned, then goes on the next run', async () => {
    const f = await fixture();
    const d = f.mk('d');
    store().setPhase(d.id, 'cancelled', { keepDays: 7 });
    const r = f.mk(d.id, { returnOf: d.id, phase: 'returning' });
    clock.advance(365 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(0); // the return is not ended
    store().setPhase(r.id, 'returned', { keepDays: 7 });
    clock.advance(8 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(1);
    expect(store().get(r.id)).toBeNull();
    expect(store().get(d.id)).not.toBeNull();
    expect(s.built.moves.pruneEnded()).toBe(1);
    expect(store().get(d.id)).toBeNull();
  });

  it('a cancelled switched-over move whose return is not created yet is never pruned in its grace', async () => {
    const f = await fixture();
    const d = f.mk('e');
    s.built.db.prepare('UPDATE moves SET switched_at = ? WHERE id = ?').run(clock.now(), d.id);
    store().setPhase(d.id, 'cancelled', { keepDays: 7 });
    clock.advance(7 * DAY + 1);
    expect(store().prunable(clock.now(), 30)).toEqual([]);
    expect(s.built.moves.pruneEnded()).toBe(0);
    clock.advance(RETURN_GRACE_MS);
    expect(s.built.moves.pruneEnded()).toBe(1); // a return that never came is not waited for forever
    // A cancel before the switch-over has no return and no grace.
    const g = f.mk('g');
    store().setPhase(g.id, 'cancelled', { keepDays: 7 });
    clock.advance(7 * DAY + 1);
    expect(s.built.moves.pruneEnded()).toBe(1);
  });

  it('live moves are never pruned', async () => {
    const f = await fixture();
    const m = f.mk('h');
    clock.advance(400 * DAY);
    expect(s.built.moves.pruneEnded()).toBe(0);
    expect(store().get(m.id)).not.toBeNull();
  });

  it('writes nothing when nothing is due (no epoch bump, no audit row)', async () => {
    const f = await fixture();
    const m = f.mk('i');
    store().setPhase(m.id, 'done', { keepDays: 30 });
    const before = epoch();
    clock.advance(DAY);
    expect(s.built.moves.pruneEnded()).toBe(0);
    expect(store().prune(clock.now(), 30)).toEqual([]);
    expect(epoch()).toBe(before);
    expect(audits()).toHaveLength(0);
  });

  it('prunes in one transaction with its audit row', async () => {
    const f = await fixture();
    const a = f.mk('j1');
    store().setPhase(a.id, 'done', { keepDays: 7 });
    const b = f.mk('j2');
    store().setPhase(b.id, 'failed', { keepDays: 7 });
    clock.advance(8 * DAY);
    const before = epoch();
    expect(s.built.moves.pruneEnded()).toBe(2);
    expect(epoch()).toBe(before + 1);
    expect(audits()[0].d.count).toBe(2);
    expect([...audits()[0].d.ids].sort()).toEqual([a.id, b.id].sort());
  });

  it('two ticks within an hour prune once', async () => {
    const f = await fixture();
    const MIN = 60_000;
    const a = f.mk('k1');
    store().setPhase(a.id, 'done', { keepDays: 7 });
    clock.advance(10 * MIN);
    const b = f.mk('k2');
    store().setPhase(b.id, 'done', { keepDays: 7 });
    clock.advance(7 * DAY - 10 * MIN + 1); // a is due, b is not (10 min later)
    s.built.moves.tick();
    expect(store().get(a.id)).toBeNull();
    expect(store().get(b.id)).not.toBeNull();
    clock.advance(15 * MIN); // b is due, but the last prune was 15 min ago
    s.built.moves.tick();
    expect(store().get(b.id)).not.toBeNull();
    clock.advance(46 * MIN);
    s.built.moves.tick();
    expect(store().get(b.id)).toBeNull();
    expect(audits().map((x) => x.d.count)).toEqual([1, 1]);
  });
});
