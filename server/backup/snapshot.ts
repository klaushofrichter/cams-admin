import { createHash, randomBytes } from 'crypto';
import { request } from 'http';
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

export function manualKey(prefix: string, at: number): string {
  return snapshotKey(prefix, at).replace(/snapshots\/\d{4}\/\d{2}\/\d{2}\/cams-admin-/, 'snapshots/manual-');
}

type SnapResult = { ok: boolean; key?: string; bytes?: number; error?: string };
let running: Promise<SnapResult> | null = null;

export function runSnapshot(d: SnapshotDeps): Promise<SnapResult> {
  // One at a time: the daily run and a click share the result.
  running ??= doSnapshot(d).finally(() => (running = null));
  return running;
}

// VACUUM INTO, integrity check, gzip, upload; the local copy always goes.
async function makeSnapshot(d: SnapshotDeps, key: string): Promise<SnapResult> {
  const at = d.clock.now();
  const dir = join(dirname(d.dbFile), 'snap');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `cams-admin-${at}-${randomBytes(4).toString('hex')}.sqlite`);
  let result: SnapResult;
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
  return result;
}

async function doSnapshot(d: SnapshotDeps): Promise<SnapResult> {
  const at = d.clock.now();
  const key = snapshotKey(d.prefix, at);
  const result = await makeSnapshot(d, key);
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

// Litestream 0.5.17's control socket: POST /sync {path, wait, timeout}.
export function litestreamSync(socketPath: string, dbFile: string, timeoutS = 30): Promise<{ ok: boolean; status?: string; txid?: number; error?: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ path: dbFile, wait: true, timeout: timeoutS });
    const req = request({ socketPath, path: '/sync', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: (timeoutS + 5) * 1000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let j: { status?: string; replicated_txid?: number; error?: string } = {};
        try {
          j = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        if (res.statusCode === 200 && (j.status === 'synced' || j.status === 'no_change')) resolve({ ok: true, status: j.status, txid: j.replicated_txid });
        else resolve({ ok: false, error: `Litestream: ${(j.error ?? text ?? `HTTP ${res.statusCode}`).slice(0, 200)}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ ok: false, error: `Litestream control socket unreachable (${(e as NodeJS.ErrnoException).code ?? e.message})` }));
    req.end(body);
  });
}

export interface BackupNowResult { ok: boolean; at: number; litestream: { ok: boolean; status?: string; txid?: number; error?: string }; snapshot: SnapResult }

// "Backup now" (Klaus 2026-10-06), ahead of a major change: (1) Litestream
// uploads its pending changes, (2) a manual snapshot next to the daily ones
// (snapshots/manual-<UTC>.sqlite.gz, the same 30-day lifecycle).
let runningNow: Promise<BackupNowResult> | null = null;
export function backupNow(d: SnapshotDeps & { socketPath: string | null }): Promise<BackupNowResult> {
  runningNow ??= (async () => {
    const at = d.clock.now();
    const litestream = d.socketPath ? await litestreamSync(d.socketPath, d.dbFile) : { ok: false, error: 'Litestream is not configured (LITESTREAM_SOCKET)' };
    const snapshot = await makeSnapshot(d, manualKey(d.prefix, at));
    const ok = litestream.ok && snapshot.ok;
    const result: BackupNowResult = { ok, at, litestream, snapshot };
    tx(d.db, () => {
      d.db.prepare(`INSERT INTO jobs (name, last_run_at, last_ok_at, last_outcome, last_detail) VALUES ('backup-now', ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = COALESCE(excluded.last_ok_at, jobs.last_ok_at), last_outcome = excluded.last_outcome, last_detail = excluded.last_detail`)
        .run(at, ok ? at : null, ok ? 'ok' : 'failed', JSON.stringify(result));
      d.audit.write({
        actorType: 'sysadmin', actor: d.actor ?? 'system', action: 'backup-now', outcome: ok ? 'ok' : 'failed',
        detail: { litestream: litestream.ok ? (litestream as { status?: string }).status : litestream.error, snapshot: snapshot.ok ? snapshot.key : snapshot.error, bytes: snapshot.bytes ?? null },
      });
    });
    return result;
  })().finally(() => (runningNow = null));
  return runningNow;
}
