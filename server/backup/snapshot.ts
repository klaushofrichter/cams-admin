import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock';
import type { Audit } from '../audit';
import { tx, type Db } from '../db/open';
import type { ObjectStore } from './store';

// The daily snapshot (spec §13.4): VACUUM INTO, integrity check, gzip,
// upload with its SHA-256, local copy removed, the run recorded, old
// snapshots pruned (never the newest).

export interface SnapshotDeps { db: Db; dbFile: string; clock: Clock; audit: Audit; store: ObjectStore; prefix: string; retentionDays: number; actor?: string }

const pad = (n: number) => String(n).padStart(2, '0');
export function snapshotKey(prefix: string, at: number): string {
  const d = new Date(at);
  const [y, m, day, h, mi, s] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()), pad(d.getUTCMinutes()), pad(d.getUTCSeconds())];
  return `${prefix}snapshots/${y}/${m}/${day}/cams-admin-${y}${m}${day}T${h}${mi}${s}Z.sqlite.gz`;
}

let running: Promise<{ ok: boolean; key?: string; bytes?: number; error?: string }> | null = null;

export function runSnapshot(d: SnapshotDeps): Promise<{ ok: boolean; key?: string; bytes?: number; error?: string }> {
  // One at a time: the daily run and an on-demand click share the result.
  running ??= doSnapshot(d).finally(() => (running = null));
  return running;
}

async function doSnapshot(d: SnapshotDeps): Promise<{ ok: boolean; key?: string; bytes?: number; error?: string }> {
  const at = d.clock.now();
  const dir = join(dirname(d.dbFile), 'snap');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `cams-admin-${at}-${randomBytes(4).toString('hex')}.sqlite`);
  const key = snapshotKey(d.prefix, at);
  let result: { ok: boolean; key?: string; bytes?: number; error?: string };
  try {
    d.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(file, { readOnly: true });
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    copy.close();
    if (check.integrity_check !== 'ok') throw new Error(`integrity_check: ${check.integrity_check}`);
    const gz = gzipSync(readFileSync(file));
    await d.store.put(key, gz, createHash('sha256').update(gz).digest('base64'));
    result = { ok: true, key, bytes: gz.length };
  } catch (e) {
    result = { ok: false, error: (e as Error).message.slice(0, 300) };
  } finally {
    rmSync(file, { force: true });
  }
  let pruned = 0;
  try {
    pruned = await prune(d);
  } catch {
    /* pruning failures don't fail the snapshot */
  }
  tx(d.db, () => {
    d.db.prepare(`INSERT INTO jobs (name, last_run_at, last_ok_at, last_outcome, last_detail) VALUES ('snapshot', ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = COALESCE(excluded.last_ok_at, jobs.last_ok_at), last_outcome = excluded.last_outcome, last_detail = excluded.last_detail`)
      .run(at, result.ok ? at : null, result.ok ? 'ok' : 'failed', JSON.stringify(result.ok ? { key, bytes: result.bytes, pruned } : { error: result.error }));
    d.audit.write({ actorType: d.actor ? 'sysadmin' : 'system', actor: d.actor ?? 'system', action: 'backup-snapshot', outcome: result.ok ? 'ok' : 'failed', detail: result.ok ? { key, bytes: result.bytes, pruned, store: d.store.describe() } : { error: result.error } });
  });
  return result;
}

async function prune(d: SnapshotDeps): Promise<number> {
  const all = (await d.store.list(`${d.prefix}snapshots/`)).sort((a, b) => b.lastModified - a.lastModified);
  const cutoff = d.clock.now() - d.retentionDays * 86400_000;
  const old = all.slice(1).filter((o) => o.lastModified < cutoff).map((o) => o.key);
  if (old.length) await d.store.delete(old);
  return old.length;
}
