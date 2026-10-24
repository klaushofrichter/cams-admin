import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, LATEST_VERSION } from '../server/db/open';
import { MIGRATIONS } from '../server/db/migrations';
import { MoveStore, MoveBusy } from '../server/moves/store';
import { fakeClock } from './helpers/clock';
import { tmpDir } from './helpers/tmp';

function setup() {
  const dir = tmpDir();
  const db = openDb(join(dir, 'm.db'));
  db.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_a','alpha','A',1,1),('acc_b','beta','B',1,1);
    INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES
      ('prx_1','acc_a','p1','P1','cluster','enrolled',1,1),('prx_2','acc_a','p2','P2','cluster','enrolled',1,1),
      ('prx_3','acc_a','p3','P3','cluster','enrolled',1,1),('prx_4','acc_a','p4','P4','cluster','enrolled',1,1),('prx_x','acc_b','px','PX','cluster','enrolled',1,1);
    INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,host,created_at,updated_at) VALUES
      ('cam_1','acc_a','prx_1','c1','pc1','C1','camera','192.0.2.1',1,1),('cam_2','acc_a','prx_3','c2','pc2','C2','camera','192.0.2.2',1,1);`);
  const clock = fakeClock();
  return { db, clock, store: new MoveStore(db, clock) };
}
const nm = (o: Record<string, unknown> = {}) => ({
  accountId: 'acc_a', cameraId: 'cam_1', sourceProxyId: 'prx_1', targetProxyId: 'prx_2', requestId: 'req-1', actor: 'prx_1', ...o,
});

describe('MoveStore', () => {
  it('creates a move and reads it back', () => {
    const { store, db, clock } = setup();
    const m = store.create(nm({ reason: 'new host', tokenHash: 'sha256:' + 'a'.repeat(64) }));
    expect(m.id).toMatch(/^mv_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(m).toMatchObject({ phase: 'requested', accountId: 'acc_a', cameraId: 'cam_1', reason: 'new host', createdAt: clock.now(), updatedAt: clock.now(), endedAt: null, version: 1, offeredAt: null, approvedAt: null });
    expect(store.get(m.id)).toEqual(m);
    expect(store.get('mv_NOPE')).toBeNull();
    expect(store.active().map((x) => x.id)).toEqual([m.id]);
    expect(store.byProxy('prx_1')?.id).toBe(m.id);
    expect(store.byProxy('prx_2')?.id).toBe(m.id);
    expect(store.byProxy('prx_3')).toBeNull();
    expect(db.prepare(`SELECT move_id FROM cameras WHERE id='cam_1'`).get()).toEqual({ move_id: null });
    expect(store.list('acc_a').length).toBe(1);
    expect(store.list('acc_b').length).toBe(0);
  });

  it('second active move on the same source, target or camera throws MoveBusy', () => {
    const { store } = setup();
    store.create(nm());
    expect(() => store.create(nm({ cameraId: 'cam_2', targetProxyId: 'prx_3' }))).toThrow(MoveBusy); // same source
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_3' }))).toThrow(MoveBusy); // same target
    expect(() => store.create(nm({ sourceProxyId: 'prx_3', targetProxyId: 'prx_4' }))).toThrow(MoveBusy); // same camera
  });

  it('one active move per proxy across roles: P->Q then R->P and Q->R are busy', () => {
    const { store } = setup();
    store.create(nm()); // prx_1 -> prx_2
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_3', targetProxyId: 'prx_1' }))).toThrow(MoveBusy);
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_2', targetProxyId: 'prx_3' }))).toThrow(MoveBusy);
    expect(store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_3', targetProxyId: 'prx_4' })).phase).toBe('requested');
  });

  it('a move to the same proxy violates the CHECK', () => {
    const { store } = setup();
    expect(() => store.create(nm({ targetProxyId: 'prx_1' }))).toThrow(/CHECK/);
  });

  it('a move between proxies of two accounts violates the FK', () => {
    const { store } = setup();
    expect(() => store.create(nm({ targetProxyId: 'prx_x' }))).toThrow(/FOREIGN KEY/);
  });

  it('ended moves do not block a new one; the next move overwrites cameras.move_id', () => {
    const { store, db, clock } = setup();
    const a = store.create(nm());
    clock.advance(1000);
    const done = store.setPhase(a.id, 'done');
    expect(done).toMatchObject({ phase: 'done', endedAt: clock.now(), updatedAt: clock.now(), version: 2 });
    store.markCamera(a.id);
    expect(db.prepare(`SELECT move_id FROM cameras WHERE id='cam_1'`).get()).toEqual({ move_id: a.id });
    expect(store.active()).toEqual([]);
    expect(store.byProxy('prx_1')).toBeNull();
    const b = store.create(nm({ requestId: 'req-2' }));
    store.markCamera(b.id);
    expect(db.prepare(`SELECT move_id FROM cameras WHERE id='cam_1'`).get()).toEqual({ move_id: b.id });
    expect(() => store.markCamera('mv_NOPE')).toThrow(/not_found/);
    expect(store.list().length).toBe(2);
  });

  it('setPhase applies a patch, JSON fields round-trip, and an unknown move throws', () => {
    const { store, clock } = setup();
    const m = store.create(nm());
    clock.advance(5);
    const o = store.setPhase(m.id, 'offered', { offeredAt: clock.now(), plan: { a: 1 }, targetIp: '192.0.2.9', bytesTotal: 10 });
    expect(o).toMatchObject({ phase: 'offered', offeredAt: clock.now(), plan: { a: 1 }, targetIp: '192.0.2.9', bytesTotal: 10 });
    expect(store.get(m.id)).toEqual(o);
    expect(() => store.setPhase('mv_NOPE', 'failed')).toThrow(/not_found/);
    store.setPhase(m.id, 'cancelling');
    expect(store.get(m.id)!.endedAt).toBeNull();
    expect(store.setPhase(m.id, 'cancelled').endedAt).toBe(clock.now());
  });

  it('refuses a token hash that is not sha256:<hex>', () => {
    const { store } = setup();
    expect(() => store.create(nm({ tokenHash: 'plaintext-token' }))).toThrow(/CHECK/);
  });

  it('saveChunks upserts and keeps other chunks; chunks are deleted with the move', () => {
    const { store, db } = setup();
    const m = store.create(nm());
    store.saveChunks(m.id, [{ id: 'c1', state: 'pending' }, { id: 'c2', state: 'pending' }]);
    store.saveChunks(m.id, [{ id: 'c2', state: 'copied' }, { id: 'c3', state: 'failed' }]);
    expect(store.chunks(m.id)).toEqual([{ id: 'c1', state: 'pending' }, { id: 'c2', state: 'copied' }, { id: 'c3', state: 'failed' }]);
    expect(() => store.saveChunks(m.id, [{ id: 'c4', state: 'bogus' as never }])).toThrow(/CHECK/);
    expect(store.chunks(m.id).length).toBe(3);
    db.prepare('DELETE FROM moves WHERE id = ?').run(m.id);
    expect(db.prepare('SELECT count(*) n FROM move_chunks').get()).toEqual({ n: 0 });
  });

  it('migration 8 on a DB at version 7 keeps existing rows', () => {
    const f = join(tmpDir(), 'm8.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 7; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 7');
    raw.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_a','alpha','A',1,1);
      INSERT INTO cameras (id,account_id,cams_id,name,kind,host,created_at,updated_at) VALUES ('cam_1','acc_a','c1','C','camera','192.0.2.1',1,1);`);
    raw.close();
    const db = openDb(f);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(8);
    expect(db.prepare('SELECT id, host, move_id FROM cameras').all()).toEqual([{ id: 'cam_1', host: '192.0.2.1', move_id: null }]);
    expect(db.prepare('SELECT count(*) n FROM moves').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT strict FROM pragma_table_list WHERE name IN ('moves','move_chunks')`).all()).toEqual([{ strict: 1 }, { strict: 1 }]);
  });

  it('migration 11 on a DB at version 10 keeps existing moves with bounds NULL', () => {
    const f = join(tmpDir(), 'm11.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 10; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 10');
    raw.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_a','alpha','A',1,1);
      INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES
        ('prx_1','acc_a','p1','P1','cluster','enrolled',1,1),('prx_2','acc_a','p2','P2','cluster','enrolled',1,1);
      INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,host,created_at,updated_at) VALUES ('cam_1','acc_a','prx_1','c1','pc1','C1','camera','192.0.2.1',1,1);
      INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,created_at,updated_at,version) VALUES ('mv_OLD','acc_a','cam_1','prx_1','prx_2','rq_old','requested',1,1,1);`);
    raw.close();
    const db = openDb(f);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(11);
    expect(db.prepare('SELECT id, bounds FROM moves').all()).toEqual([{ id: 'mv_OLD', bounds: null }]);
    expect(new MoveStore(db, fakeClock()).get('mv_OLD')!.bounds).toBeNull();
  });
  it('accepts the return phases and links a return; returnFor finds it', () => {
    const { store, clock } = setup();
    const a = store.create(nm());
    const cancelled = store.setPhase(a.id, 'cancelled');
    expect(store.returnFor(cancelled.id)).toBeNull();
    clock.advance(10);
    const r = store.create(nm({ sourceProxyId: 'prx_2', targetProxyId: 'prx_1', requestId: cancelled.id, returnOf: cancelled.id, phase: 'returning', plan: { kinds: ['clips'] } }));
    expect(r).toMatchObject({ phase: 'returning', returnOf: cancelled.id, plan: { kinds: ['clips'] }, endedAt: null, check: null, keepDays: null, endRequested: null });
    expect(store.returnFor(cancelled.id)?.id).toBe(r.id);
    expect(store.returnFor(r.id)).toBeNull();
    expect(a.returnOf).toBeNull();
    clock.advance(10);
    const done = store.setPhase(r.id, 'returned');
    expect(done.endedAt).toBe(clock.now());
    expect(store.active()).toEqual([]);
  });

  it('a return blocks other moves on both proxies', () => {
    const { store } = setup();
    const a = store.create(nm());
    store.setPhase(a.id, 'cancelled');
    store.create(nm({ sourceProxyId: 'prx_2', targetProxyId: 'prx_1', requestId: a.id, returnOf: a.id, phase: 'returning' }));
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_3', targetProxyId: 'prx_1' }))).toThrow(MoveBusy);
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_2', targetProxyId: 'prx_3' }))).toThrow(MoveBusy);
    expect(() => store.create(nm({ requestId: 'req-9', sourceProxyId: 'prx_3', targetProxyId: 'prx_4' }))).toThrow(MoveBusy); // same camera
  });

  it('refuses a phase outside the list', () => {
    const { store } = setup();
    expect(() => store.create(nm({ phase: 'bogus' as never }))).toThrow(/CHECK/);
  });

  it('check, keepDays and endRequested round-trip; keepDays is 7 to 3650', () => {
    const { store } = setup();
    const m = store.create(nm());
    const check = { complete: false, missing: { stills: 2 }, recovered: { clips: 1 }, failed: {}, expired: {} };
    const endRequested = { at: 5, actorType: 'sysadmin', actor: 'admin@example.org' };
    const p = store.setPhase(m.id, 'copying', { check, keepDays: 30, endRequested });
    expect(p).toMatchObject({ check, keepDays: 30, endRequested });
    expect(store.get(m.id)).toEqual(p);
    expect(() => store.setPhase(m.id, 'copying', { keepDays: 6 })).toThrow(/CHECK/);
    expect(() => store.setPhase(m.id, 'copying', { keepDays: 3651 })).toThrow(/CHECK/);
    expect(store.setPhase(m.id, 'copying', { keepDays: null }).keepDays).toBeNull();
  });

  it('prune deletes ended moves after keepDays, never with cleanup pending or a linked return', () => {
    const { store, clock, db } = setup();
    const DAY = 86_400_000;
    const t0 = clock.now();
    // a: done, keepDays 7. b: done, no keepDays (default). c: done, cleanup pending. d: cancelled with a linked return r.
    const a = store.create(nm({ requestId: 'a' }));
    store.saveChunks(a.id, [{ id: 'c1', state: 'verified' }]);
    store.setPhase(a.id, 'done', { keepDays: 7 });
    const b = store.create(nm({ requestId: 'b' }));
    store.setPhase(b.id, 'done');
    const c = store.create(nm({ requestId: 'c' }));
    store.setPhase(c.id, 'done', { cleanupPending: true });
    const c2 = store.create(nm({ requestId: 'c2' }));
    store.setPhase(c2.id, 'done', { targetCleanupPending: true });
    const d = store.create(nm({ requestId: 'd' }));
    store.setPhase(d.id, 'cancelled', { keepDays: 7 });
    const r = store.create(nm({ sourceProxyId: 'prx_2', targetProxyId: 'prx_1', requestId: d.id, returnOf: d.id, phase: 'returning' }));
    const live = store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_3', targetProxyId: 'prx_4', requestId: 'live' }));

    expect(store.prune(t0 + 7 * DAY, 30)).toEqual([]); // not past 7 days yet
    expect(store.prune(t0 + 7 * DAY + 1, 30)).toEqual([a.id]);
    expect(store.get(a.id)).toBeNull();
    expect(db.prepare('SELECT count(*) n FROM move_chunks WHERE move_id = ?').get(a.id)).toEqual({ n: 0 });
    expect(store.prune(t0 + 30 * DAY + 1, 30)).toEqual([b.id]);
    store.setPhase(r.id, 'returned', { keepDays: 7 });
    expect(store.prune(t0 + 365 * DAY, 30)).toEqual([r.id]); // the return goes first; its original is still linked
    expect(store.prune(t0 + 365 * DAY, 30)).toEqual([d.id]);
    expect(store.get(c.id)).not.toBeNull();
    expect(store.get(c2.id)).not.toBeNull();
    expect(store.get(live.id)).not.toBeNull();
    store.setPhase(c.id, 'done', { cleanupPending: false });
    expect(store.prune(t0 + 365 * DAY, 30)).toEqual([c.id]);
  });

  it('migration 14 keeps every moves and move_chunks row and value', () => {
    const f = join(tmpDir(), 'm14.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 13; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 13');
    raw.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_a','alpha','A',1,1);
      INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES
        ('prx_1','acc_a','p1','P1','cluster','enrolled',1,1),('prx_2','acc_a','p2','P2','cluster','enrolled',1,1),
        ('prx_3','acc_a','p3','P3','cluster','enrolled',1,1),('prx_4','acc_a','p4','P4','cluster','enrolled',1,1);
      INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,host,created_at,updated_at,move_id) VALUES
        ('cam_1','acc_a','prx_2','c1','pc1','C1','camera','192.0.2.1',1,1,'mv_DONE'),('cam_2','acc_a','prx_3','c2','pc2','C2','camera','192.0.2.2',1,1,NULL);
      INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,reason,plan,summary,settings,token_hash,target_ip,target_public_key,leaf_fingerprint,copied_choice,
        offered_at,approved_at,budget_exceeded_at,bytes_total,bytes_done,rate_bps,eta_s,created_at,updated_at,ended_at,actor,version,cleanup_pending,target_cleanup_pending,bounds,switched_at) VALUES
        ('mv_DONE','acc_a','cam_1','prx_1','prx_2','rq_1','done','new host','{"transfer":true}','{"clips":{"files":1}}','{"a":1}','sha256:${'a'.repeat(64)}','192.0.2.9','pk','fp','delete',
          10,11,12,100,100,5,0,1,20,20,'prx_1',7,1,0,'{"transfer":true,"kinds":["clips"],"space":"all","maxBudgetS":60}',15),
        ('mv_CANC','acc_a','cam_1','prx_1','prx_2','rq_2','cancelled',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'age-out',NULL,NULL,NULL,NULL,NULL,NULL,NULL,2,30,30,NULL,3,0,1,NULL,NULL),
        ('mv_FAIL','acc_a','cam_2','prx_3','prx_4','rq_3','failed','x',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,3,31,31,NULL,2,0,0,NULL,NULL),
        ('mv_COPY','acc_a','cam_1','prx_2','prx_1','rq_4','copying',NULL,'{"kinds":["stills"]}',NULL,NULL,'sha256:${'b'.repeat(64)}',NULL,NULL,NULL,NULL,40,41,NULL,1000,250,9,30,40,45,NULL,'prx_2',4,0,0,NULL,42),
        ('mv_OFFR','acc_a','cam_2','prx_3','prx_4','rq_5','offered',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,50,NULL,NULL,NULL,NULL,NULL,NULL,50,50,NULL,NULL,1,0,0,NULL,NULL);
      INSERT INTO move_chunks (move_id,chunk_id,state) VALUES ('mv_DONE','d1','verified'),('mv_DONE','d2','skipped'),('mv_CANC','k1','abandoned'),
        ('mv_COPY','p1','pending'),('mv_COPY','p2','copied'),('mv_COPY','p3','failed'),('mv_FAIL','f1','failed');`);
    const movesBefore = raw.prepare('SELECT * FROM moves ORDER BY id').all();
    const chunksBefore = raw.prepare('SELECT * FROM move_chunks ORDER BY move_id, chunk_id').all();
    raw.close();

    const db = openDb(f);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(14);
    const after = db.prepare('SELECT * FROM moves ORDER BY id').all() as Record<string, unknown>[];
    expect(after.map(({ return_of, check_result, keep_days, end_requested, ...rest }) => {
      expect([return_of, check_result, keep_days, end_requested]).toEqual([null, null, null, null]);
      return rest;
    })).toEqual(movesBefore);
    expect(db.prepare('SELECT * FROM move_chunks ORDER BY move_id, chunk_id').all()).toEqual(chunksBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%m14%'`).all()).toEqual([]);
    // The rebuilt table still enforces its rules: busy trigger, partial unique indexes, cascade to chunks.
    const store = new MoveStore(db, fakeClock());
    expect(() => store.create(nm({ cameraId: 'cam_2', sourceProxyId: 'prx_4', targetProxyId: 'prx_1' }))).toThrow(MoveBusy);
    expect(store.get('mv_COPY')).toMatchObject({ phase: 'copying', bytesDone: 250, plan: { kinds: ['stills'] }, returnOf: null, check: null, keepDays: null, endRequested: null });
    db.prepare(`DELETE FROM moves WHERE id = 'mv_DONE'`).run();
    expect(db.prepare(`SELECT count(*) n FROM move_chunks WHERE move_id = 'mv_DONE'`).get()).toEqual({ n: 0 });
  });
});
