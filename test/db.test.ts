import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tx, LATEST_VERSION, readEpoch } from '../server/db/open';
import { checkEpoch, writeEpochFile } from '../server/db/epoch';
import { MIGRATIONS } from '../server/db/migrations';
import { toKey } from '../server/registry';
import { tmpDir } from './helpers/tmp';
import { makeRegistry, ACTOR } from './helpers/registry';

const TABLES = ['accounts', 'account_users', 'proxies', 'proxy_keys', 'enrollment_codes', 'cameras', 'sims', 'proxy_status', 'status_events', 'audit_log', 'sessions', 'jobs', 'meta', 'commands', 'proxy_tokens', 'proxy_token_state',
  'cams_instances', 'cams_instance_keys', 'cams_enrollment_codes', 'cams_instance_accounts', 'cams_instance_routes', 'config_revision'];

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

  it('allows one active (confirmed) key and one pending key per proxy', () => {
    const db = openDb(join(dir, 'k.db'));
    seed(db);
    const ins = db.prepare(`INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,confirmed_at,revoked_at) VALUES (?,?,?,?,1,?,?)`);
    ins.run('key_1', 'prx_a', 'pk1', 'f1', 1, null);
    expect(() => ins.run('key_2', 'prx_a', 'pk2', 'f2', 1, null)).toThrow(/UNIQUE/);
    ins.run('key_p1', 'prx_a', 'pkp1', 'fp1', null, null);
    expect(() => ins.run('key_p2', 'prx_a', 'pkp2', 'fp2', null, null)).toThrow(/UNIQUE/);
    db.exec(`UPDATE proxy_keys SET revoked_at=2 WHERE id='key_1'`);
    expect(() => ins.run('key_2', 'prx_a', 'pk2', 'f2', 1, null)).not.toThrow();
  });

  it('migration 2: a key that was ever seen is confirmed; a never-used one becomes pending', () => {
    const f = join(dir, 'm2.db');
    const raw = new DatabaseSync(f);
    MIGRATIONS[0](raw);
    raw.exec('PRAGMA user_version = 1');
    seed(raw);
    raw.exec(`INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,last_seen_at) VALUES ('key_seen','prx_a','pk1','f1',1,5),('key_orphan','prx_b','pk2','f2',1,NULL)`);
    raw.close();
    const db = openDb(f);
    expect(db.prepare(`SELECT id, confirmed_at FROM proxy_keys ORDER BY id`).all()).toEqual([{ id: 'key_orphan', confirmed_at: null }, { id: 'key_seen', confirmed_at: 5 }]);
  });

  // Production, v2026.10.06.3: a key redeemed (old code) by a proxy that had
  // said hello before with its previous key. The redemption revoked the old
  // key; the status snapshot then stamped the proxy's last hello onto the new,
  // never-used key (last_seen_at before its created_at), and migration 2
  // turned that stamp into confirmed_at: the orphan showed as active.
  const oldRedeemSequence = (raw: DatabaseSync) => {
    seed(raw);
    raw.exec(`UPDATE proxies SET state='enrolled' WHERE id='prx_a';
      INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,last_seen_at) VALUES ('key_old','prx_a','pk0','f0',500,1000);
      INSERT INTO proxy_status (proxy_id,last_hello_at) VALUES ('prx_a',1000);`);
    // redeem at 2000 (old code): the active key revoked, the new key inserted
    raw.exec(`UPDATE proxy_keys SET revoked_at=2000, revoked_reason='re-enrolled' WHERE proxy_id='prx_a' AND revoked_at IS NULL;
      INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,enrollment_id) VALUES ('key_new','prx_a','pk1','f1',2000,'enr_1');`);
    // no hello with key_new; the old status snapshot (StatusStore.persist) runs
    raw.prepare('UPDATE proxy_keys SET last_seen_at = ? WHERE proxy_id = ? AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ?)').run(1000, 'prx_a', 1000);
  };

  it('redeem, no hello, snapshot, migrate: the never-used key is pending, never active', () => {
    const f = join(dir, 'm2-orphan.db');
    const raw = new DatabaseSync(f);
    MIGRATIONS[0](raw);
    raw.exec('PRAGMA user_version = 1');
    oldRedeemSequence(raw);
    raw.close();
    const db = openDb(f);
    expect(db.prepare(`SELECT id, confirmed_at, last_seen_at, revoked_at FROM proxy_keys ORDER BY id`).all()).toEqual([
      { id: 'key_new', confirmed_at: null, last_seen_at: null, revoked_at: null },
      { id: 'key_old', confirmed_at: 1000, last_seen_at: 1000, revoked_at: 2000 },
    ]);
    expect(toKey(db.prepare(`SELECT * FROM proxy_keys WHERE id='key_new'`).get() as Record<string, unknown>, 2000 + 25 * 3600_000).pending).toBe('expired');
  });

  it('migration 3 repairs a database already at version 2 (a stamped key wrongly active)', () => {
    const f = join(dir, 'm3.db');
    const raw = new DatabaseSync(f);
    MIGRATIONS[0](raw);
    raw.exec('PRAGMA user_version = 1');
    oldRedeemSequence(raw);
    // prx_b: a stamped key wrongly confirmed, and a newer pending key; plus a genuinely seen key
    raw.exec(`INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,last_seen_at) VALUES ('key_b_stamped','prx_b','pk2','f2',3000,2500)`);
    MIGRATIONS[1](raw);
    raw.exec('PRAGMA user_version = 2');
    raw.exec(`INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at) VALUES ('key_b_pending','prx_b','pk3','f3',4000);
      INSERT INTO accounts (id,name,display_name,created_at,updated_at) VALUES ('acc_c','gamma','C',1,1);
      INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES ('prx_c','acc_c','pc','PC','cluster','enrolled',1,1);
      INSERT INTO proxy_keys (id,proxy_id,public_key,fingerprint,created_at,last_seen_at,confirmed_at) VALUES ('key_c','prx_c','pk4','f4',100,200,150);`);
    expect(raw.prepare(`SELECT confirmed_at FROM proxy_keys WHERE id='key_new'`).get()).toEqual({ confirmed_at: 1000 }); // the production state
    raw.close();
    const db = openDb(f);
    const rows = db.prepare(`SELECT id, confirmed_at, last_seen_at, revoked_at IS NOT NULL revoked, revoked_reason FROM proxy_keys ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 'key_b_pending', confirmed_at: null, last_seen_at: null, revoked: 0, revoked_reason: null },
      { id: 'key_b_stamped', confirmed_at: null, last_seen_at: null, revoked: 1, revoked_reason: 're-enrolled' },
      { id: 'key_c', confirmed_at: 150, last_seen_at: 200, revoked: 0, revoked_reason: null },
      { id: 'key_new', confirmed_at: null, last_seen_at: null, revoked: 0, revoked_reason: null },
      { id: 'key_old', confirmed_at: 1000, last_seen_at: 1000, revoked: 1, revoked_reason: 're-enrolled' },
    ]);
  });

  it('migration 4 (P2): a version-3 database gains commands, proxy_tokens, proxy_token_state with its rows intact', () => {
    const f = join(dir, 'm4.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 3; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 3');
    seed(raw);
    raw.close();
    const db = openDb(f);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT id FROM proxies ORDER BY id').all()).toEqual([{ id: 'prx_a' }, { id: 'prx_b' }]);
    expect(db.prepare('SELECT count(*) n FROM commands').get()).toEqual({ n: 0 });
  });

  it('proxy_tokens: hash shape and unique; same-account proxy; a proxy delete removes its tokens and token state and keeps its commands', () => {
    const db = openDb(join(dir, 'tok.db'));
    seed(db);
    const H = (c: string) => 'sha256:' + c.repeat(64);
    const tok = (id: string, hash: string, acc = 'acc_a', prx = 'prx_a') => db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,'client','manual','l',?,'pending',1,1,'a@example.com')`).run(id, acc, prx, hash);
    tok('tok_1', H('a'));
    expect(() => tok('tok_2', H('a'))).toThrow(/UNIQUE/);
    expect(() => tok('tok_3', 'sha256:short')).toThrow(/CHECK/);
    expect(() => tok('tok_4', 'md5:' + 'a'.repeat(67))).toThrow(/CHECK/);
    expect(() => tok('tok_5', H('b'), 'acc_b', 'prx_a')).toThrow(/FOREIGN KEY/);
    db.prepare(`INSERT INTO proxy_token_state (proxy_id, revision) VALUES ('prx_a', 3)`).run();
    const cmd = (id: string, state: string) => db.prepare(`INSERT INTO commands (id,account_id,proxy_id,actor,command,args,state,created_at) VALUES (?,'acc_a','prx_a','a@example.com','tokens.apply','{}',?,1)`).run(id, state);
    cmd('cmd_1', 'done');
    expect(() => cmd('cmd_2', 'lost')).toThrow(/CHECK/);
    db.prepare(`DELETE FROM proxies WHERE id = 'prx_a'`).run();
    expect(db.prepare('SELECT count(*) n FROM proxy_tokens').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM proxy_token_state').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT proxy_id FROM commands WHERE id = 'cmd_1'`).get()).toEqual({ proxy_id: null });
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

  // --- P4 (cams instances) ---------------------------------------------------
  it('P4 migration: tables, one active and one pending key per instance; a route without a url is the registered URL', () => {
    const r = makeRegistry(dir);
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const px = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
    r.db.prepare(`INSERT INTO cams_instances (id, name, display_name, state, created_at, updated_at) VALUES ('cms_A', 'cluster', 'Cluster', 'pending', 1, 1)`).run();
    r.db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES ('cms_A', ?, NULL, 0)`).run(px.id);
    expect(() => r.db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES ('cms_A', ?, NULL, 2)`).run(px.id)).toThrow(/CHECK|UNIQUE|PRIMARY/);
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_1', 'cms_A', 'pk1', 'fp', 1, 1)`).run();
    expect(() => r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_2', 'cms_A', 'pk2', 'fp', 1, 2)`).run()).toThrow(/UNIQUE/);
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at) VALUES ('key_3', 'cms_A', 'pk3', 'fp', 1)`).run();
    expect(() => r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at) VALUES ('key_4', 'cms_A', 'pk4', 'fp', 1)`).run()).toThrow(/UNIQUE/);
  });
  it('config_revision: one row per account, bumped by every write cams can see, in the same transaction', () => {
    const r = makeRegistry(dir);
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const rev = () => (r.db.prepare('SELECT revision FROM config_revision WHERE account_id = ?').get(acc.id) as { revision: number }).revision;
    let pxId = '';
    const steps: [string, () => void][] = [
      ['user', () => r.reg.createUser(ACTOR, acc.id, { email: 'a@example.org', role: 'viewer' })],
      ['proxy', () => { pxId = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' }).id; }],
      ['camera', () => r.reg.createCamera(ACTOR, acc.id, { camsId: 'cam1', name: 'Yard', kind: 'camera' })],
      ['account', () => r.reg.updateAccount(ACTOR, acc.id, { displayName: 'Home 2', version: 1 })],
      ['route', () => tx(r.db, () => {
        r.db.prepare(`INSERT INTO cams_instances (id, name, display_name, state, created_at, updated_at) VALUES ('cms_R', 'r', 'R', 'pending', 1, 1)`).run();
        r.db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES ('cms_R', ?, NULL, 1)`).run(pxId);
      })],
      ['token', () => tx(r.db, () => r.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES ('tok_1',?,?,'client','manual','l',?,'pending',1,1,'a@example.com')`).run(acc.id, pxId, 'sha256:' + 'a'.repeat(64)))],
    ];
    for (const [what, fn] of steps) {
      const before = rev();
      const epoch = readEpoch(r.db);
      fn();
      expect(rev(), what).toBe(before + 1);
      expect(readEpoch(r.db) - epoch, what).toBe(1); // no extra write transaction
    }
  });
  it('audit_log accepts actor type cams', () => {
    const r = makeRegistry(dir);
    r.audit.write({ actorType: 'cams', actor: 'cms_0123456789ABCDEFGHJK', action: 'cams-auth-refused', outcome: 'refused', detail: { reason: 'bad_signature' } });
    expect(r.db.prepare(`SELECT count(*) n FROM audit_log WHERE actor_type = 'cams'`).get()).toEqual({ n: 1 });
    expect(() => r.db.prepare(`INSERT INTO audit_log (id, at, actor_type, actor, action, outcome) VALUES ('aud_x', 1, 'nobody', 'x', 'signin', 'ok')`).run()).toThrow(/CHECK/);
  });
  it('a version-4 database migrates with its audit rows, indexes and accounts intact (config_revision seeded)', () => {
    const f = join(dir, 'm5.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 4; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 4');
    seed(raw);
    for (let i = 0; i < 3; i++) raw.prepare(`INSERT INTO audit_log (id, at, actor_type, actor, action, outcome, detail) VALUES (?, ?, 'sysadmin', 'a@example.com', 'account-create', 'ok', '{}')`).run(`aud_${i}`, i);
    const before = raw.prepare('SELECT * FROM audit_log ORDER BY id').all();
    raw.close();
    const db = openDb(f);
    expect(db.prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(before);
    expect((db.prepare(`SELECT name FROM pragma_index_list('audit_log') WHERE origin = 'c' ORDER BY name`).all() as { name: string }[]).map((x) => x.name)).toEqual(['audit_account_at', 'audit_action_at', 'audit_at']);
    expect(db.prepare('SELECT account_id, revision FROM config_revision ORDER BY account_id').all()).toEqual([{ account_id: 'acc_a', revision: 1 }, { account_id: 'acc_b', revision: 1 }]);
  });
});
