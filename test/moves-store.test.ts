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
});
