import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { MIGRATIONS } from './migrations';

export type Db = DatabaseSync;
export const LATEST_VERSION = MIGRATIONS.length;

// One file, node:sqlite (no native module), WAL (Litestream needs it).
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`);
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (v > LATEST_VERSION) {
    db.close();
    throw new Error(`db_newer_than_code: database version ${v}, code knows ${LATEST_VERSION}`);
  }
  for (let i = v; i < LATEST_VERSION; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

let depth = 0;
// One write transaction; bumps meta.write_epoch (restore detection, §11.4).
// Nested calls join the outer transaction.
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    db.exec('UPDATE meta SET write_epoch = write_epoch + 1 WHERE id = 1');
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const readEpoch = (db: Db): number => (db.prepare('SELECT write_epoch FROM meta WHERE id = 1').get() as { write_epoch: number }).write_epoch;
