import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tx, LATEST_VERSION, readEpoch } from '../server/db/open';
import { checkEpoch, writeEpochFile } from '../server/db/epoch';
import { tmpDir } from './helpers/tmp';

const TABLES = ['accounts', 'account_users', 'proxies', 'proxy_keys', 'enrollment_codes', 'cameras', 'sims', 'proxy_status', 'status_events', 'audit_log', 'sessions', 'jobs', 'meta'];

function seed(db: DatabaseSync) {
  db.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_a','alpha','A',1,1),('acc_b','beta','B',1,1);
    INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES ('prx_a','acc_a','pa','PA','cluster','pending',1,1),('prx_b','acc_b','pb','PB','cluster','pending',1,1);`);
}

describe('database', () => {
  const dir = tmpDir();

  it('creates every table, STRICT, at the latest version, with WAL and foreign keys', () => {
    const db = openDb(join(dir, 'a.db'));
    const strict = db.prepare(`SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; strict: number }[];
    for (const t of TABLES) expect(strict.find((x) => x.name === t)?.strict, t).toBe(1);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_VERSION);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  it('refuses a database newer than the code', () => {
    const f = join(dir, 'n.db');
    const raw = new DatabaseSync(f);
    raw.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    raw.close();
    expect(() => openDb(f)).toThrow(/db_newer_than_code/);
  });

  it('is idempotent on reopen', () => {
    const f = join(dir, 'r.db');
    openDb(f).close();
    expect(() => openDb(f).close()).not.toThrow();
  });

  it('enforces UNIQUE(account_id, email)', () => {
    const db = openDb(join(dir, 'u.db'));
    seed(db);
    const ins = db.prepare(`INSERT INTO account_users (id,account_id,email,role,created_at,updated_at) VALUES (?,?,?,?,1,1)`);
    ins.run('usr_1', 'acc_a', 'x@example.com', 'admin');
    expect(() => ins.run('usr_2', 'acc_a', 'x@example.com', 'viewer')).toThrow(/UNIQUE/);
    expect(() => ins.run('usr_3', 'acc_b', 'x@example.com', 'viewer')).not.toThrow();
    expect(() => ins.run('usr_4', 'acc_b', 'y@example.com', 'owner')).toThrow(/CHECK/);
  });

  it('a camera can only belong to a proxy of its own account, and survives the proxy', () => {
    const db = openDb(join(dir, 'c.db'));
    seed(db);
    const ins = db.prepare(`INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)`);
    expect(() => ins.run('cam_x', 'acc_a', 'prx_b', 'c1', 'cam1', 'X', 'camera')).toThrow(/FOREIGN KEY/);
    ins.run('cam_1', 'acc_a', 'prx_a', 'c1', 'cam1', 'One', 'camera');
    db.exec(`DELETE FROM proxies WHERE id='prx_a'`);
    expect(db.prepare(`SELECT account_id, proxy_id FROM cameras WHERE id='cam_1'`).get()).toEqual({ account_id: 'acc_a', proxy_id: null });
  });

  it('allows one active key per proxy', () => {
    const db = openDb(join(dir, 'k.db'));
    seed(db);
    const ins = db.prepare(`INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,revoked_at) VALUES (?,?,?,?,1,?)`);
    ins.run('key_1', 'prx_a', 'pk1', 'f1', null);
    expect(() => ins.run('key_2', 'prx_a', 'pk2', 'f2', null)).toThrow(/UNIQUE/);
    db.exec(`UPDATE proxy_keys SET revoked_at=2 WHERE id='key_1'`);
    expect(() => ins.run('key_2', 'prx_a', 'pk2', 'f2', null)).not.toThrow();
  });

  it('refuses sim details for a camera that is not a sim', () => {
    const db = openDb(join(dir, 's.db'));
    seed(db);
    db.exec(`INSERT INTO cameras (id,account_id,cams_id,name,kind,created_at,updated_at) VALUES ('cam_c','acc_a','c','C','camera',1,1),('cam_s','acc_a','s','S','sim',1,1)`);
    expect(() => db.exec(`INSERT INTO sims (camera_id, runs_on) VALUES ('cam_c','mac')`)).toThrow(/not a sim/);
    expect(() => db.exec(`INSERT INTO sims (camera_id, runs_on) VALUES ('cam_s','mac')`)).not.toThrow();
  });

  it('account delete cascades', () => {
    const db = openDb(join(dir, 'd.db'));
    seed(db);
    db.exec(`INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,created_at,updated_at) VALUES ('cam_1','acc_a','prx_a','c1','cam1','One','camera',1,1)`);
    db.exec(`DELETE FROM accounts WHERE id='acc_a'`);
    expect(db.prepare(`SELECT count(*) n FROM cameras`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) n FROM proxies`).get()).toEqual({ n: 1 });
  });

  it('tx bumps the write epoch and rolls back on error', () => {
    const db = openDb(join(dir, 'e.db'));
    const e0 = readEpoch(db);
    tx(db, () => db.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_z','zz','Z',1,1)`));
    expect(readEpoch(db)).toBe(e0 + 1);
    expect(() => tx(db, () => { db.exec(`INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_y','yy','Y',1,1)`); throw new Error('boom'); })).toThrow('boom');
    expect(readEpoch(db)).toBe(e0 + 1);
    expect(db.prepare(`SELECT count(*) n FROM accounts WHERE id='acc_y'`).get()).toEqual({ n: 0 });
  });

  it('detects a restore by the epoch file', () => {
    const db = openDb(join(dir, 'p.db'));
    const ef = join(dir, 'p.epoch');
    expect(checkEpoch(db, ef)).toBe('fresh');
    tx(db, () => undefined);
    writeEpochFile(db, ef);
    expect(checkEpoch(db, ef)).toBe('same');
    writeFileSync(ef, String(readEpoch(db) + 5));
    expect(checkEpoch(db, ef)).toBe('restored');
  });
});
