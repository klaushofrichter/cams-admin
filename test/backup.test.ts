import { describe, expect, it } from 'vitest';
import { createServer } from 'http';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db/open';
import { Audit } from '../server/audit';
import { Registry } from '../server/registry';
import { fileStore } from '../server/backup/store';
import { backupNow, runSnapshot, snapshotKey } from '../server/backup/snapshot';
import { LitestreamWatch, parseMetrics } from '../server/backup/litestream';
import { nextRunAt } from '../server/backup/scheduler';
import { backupAlerts } from '../server/backup/service';
import { fakeClock } from './helpers/clock';
import { loadConfig } from '../server/config';
import { tmpDir } from './helpers/tmp';

let n = 0;
function setup(dir: string) {
  const dbFile = join(dir, `b${n}/cams-admin.db`);
  const db = openDb(dbFile);
  const clock = fakeClock(Date.UTC(2026, 9, 6, 8, 15, 0));
  const audit = new Audit(db, clock);
  const reg = new Registry(db, clock, audit);
  reg.createAccount('a@example.com', { name: 'home', displayName: 'Home' });
  const store = fileStore(join(dir, `store${n++}`));
  const deps = { db, dbFile, clock, audit, store, prefix: 'cams-admin/test/', retentionDays: 30 };
  return { ...deps, reg };
}

describe('snapshot', () => {
  const dir = tmpDir();

  it('names the object by UTC time under snapshots/', () => {
    expect(snapshotKey('cams-admin/prod/', Date.UTC(2026, 9, 6, 8, 15, 0))).toBe('cams-admin/prod/snapshots/2026/10/06/cams-admin-20261006T081500Z.sqlite.gz');
  });

  it('VACUUM INTO, integrity check, gzip, upload, local file removed, recorded', async () => {
    const s = setup(dir);
    const r = await runSnapshot(s);
    expect(r).toMatchObject({ ok: true, key: 'cams-admin/test/snapshots/2026/10/06/cams-admin-20261006T081500Z.sqlite.gz' });
    const body = await s.store.get(r.key!);
    const out = join(dir, 'restored.db');
    writeFileSync(out, gunzipSync(body));
    const copy = new DatabaseSync(out, { readOnly: true });
    expect(copy.prepare('SELECT name FROM accounts').all()).toEqual([{ name: 'home' }]);
    expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(readdirSync(join(s.dbFile, '../snap'))).toEqual([]);
    expect(s.db.prepare(`SELECT last_outcome FROM jobs WHERE name='snapshot'`).get()).toEqual({ last_outcome: 'ok' });
    expect(s.audit.list({ action: 'backup-snapshot' }).items[0]).toMatchObject({ outcome: 'ok', detail: { key: r.key } });
  });

  it('a failing upload is recorded as failed and leaves no local file', async () => {
    const s = setup(dir);
    const r = await runSnapshot({ ...s, store: { ...s.store, put: async () => { throw new Error('S3 down'); } } });
    expect(r).toMatchObject({ ok: false, error: 'S3 down' });
    expect(readdirSync(join(s.dbFile, '../snap'))).toEqual([]);
    expect(s.audit.list({ action: 'backup-snapshot' }).items[0]).toMatchObject({ outcome: 'failed' });
  });

  it('prunes snapshots older than the retention, never the newest', async () => {
    const s = setup(dir);
    const day = 86400_000;
    for (const age of [40, 31, 29]) await s.store.put(snapshotKey(s.prefix, s.clock.now() - age * day), Buffer.from('x'), '', s.clock.now() - age * day);
    await runSnapshot(s);
    const keys = (await s.store.list(`${s.prefix}snapshots/`)).map((o) => o.key);
    expect(keys).toHaveLength(2);
    // Only old ones: the newest stays even past the retention.
    const s2 = setup(dir);
    await s2.store.put(snapshotKey(s2.prefix, s2.clock.now() - 100 * day), Buffer.from('x'), '', s2.clock.now() - 100 * day);
    await runSnapshot({ ...s2, store: { ...s2.store, put: async () => { throw new Error('down'); } } });
    expect(await s2.store.list(`${s2.prefix}snapshots/`)).toHaveLength(1);
  });
});

describe('litestream watch', () => {
  const text = (sync: number, err: number) => `# HELP x\nlitestream_sync_count{db="/var/lib/cams-admin/cams-admin.db"} ${sync}\nlitestream_sync_error_count{db="/var/lib/cams-admin/cams-admin.db"} ${err}\nlitestream_txid{db="x"} 9\n`;
  it('parses the Litestream 0.5.17 metric names', () => {
    expect(parseMetrics(text(6, 0))).toEqual({ sync: 6, errors: 0 });
    expect(parseMetrics('garbage')).toBeNull();
  });
  it('records lastReplicationAt when syncs advance without errors', async () => {
    let body = text(1, 0);
    const srv = createServer((_q, r) => r.end(body));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const clock = fakeClock(1000);
    const w = new LitestreamWatch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/metrics`, clock);
    await w.poll();
    expect(w.lastReplicationAt).toBeNull();
    clock.set(2000); body = text(3, 0); await w.poll();
    expect(w.lastReplicationAt).toBe(2000);
    clock.set(3000); body = text(5, 1); await w.poll();
    expect(w.lastReplicationAt).toBe(2000);
    clock.set(4000); srv.close(); await w.poll();
    expect(w.lastReplicationAt).toBe(2000);
    expect(w.lastError).toBeTruthy();
  });
});

describe('alerts and schedule', () => {
  const NOW = Date.UTC(2026, 9, 6, 12);
  it('red when the last snapshot failed, is older than 26 h, or replication lags 5 min', () => {
    expect(backupAlerts({ now: NOW, configured: true, lastOkAt: NOW - 3600_000, lastOutcome: 'ok', litestream: false, lastReplicationAt: null, startedAt: NOW - 86400_000 * 2 })).toEqual([]);
    expect(backupAlerts({ now: NOW, configured: true, lastOkAt: NOW - 27 * 3600_000, lastOutcome: 'ok', litestream: false, lastReplicationAt: null, startedAt: NOW - 86400_000 * 2 })).toEqual(['snapshot-stale']);
    expect(backupAlerts({ now: NOW, configured: true, lastOkAt: NOW - 3600_000, lastOutcome: 'failed', litestream: true, lastReplicationAt: NOW - 7 * 60_000, startedAt: NOW - 86400_000, syncIntervalMs: 30_000 })).toEqual(['snapshot-failed', 'replication-lag']);
    expect(backupAlerts({ now: NOW, configured: false, lastOkAt: null, lastOutcome: null, litestream: false, lastReplicationAt: null, startedAt: NOW })).toEqual(['backup-not-configured']);
  });
  it('replication lag is judged against the configured sync interval (2 × interval + 5 min)', () => {
    const base = { now: NOW, configured: true, lastOkAt: NOW - 3600_000, lastOutcome: 'ok', litestream: true, startedAt: NOW - 86400_000 };
    const hour = 3600_000;
    expect(backupAlerts({ ...base, syncIntervalMs: hour, lastReplicationAt: NOW - 6 * 60_000 })).toEqual([]);
    expect(backupAlerts({ ...base, syncIntervalMs: hour, lastReplicationAt: NOW - (2 * hour + 4 * 60_000) })).toEqual([]);
    expect(backupAlerts({ ...base, syncIntervalMs: hour, lastReplicationAt: NOW - (2 * hour + 6 * 60_000) })).toEqual(['replication-lag']);
    expect(backupAlerts({ ...base, syncIntervalMs: 30_000, lastReplicationAt: NOW - 7 * 60_000 })).toEqual(['replication-lag']);
  });

  it('LITESTREAM_SYNC_INTERVAL_S defaults to one hour', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net' }).litestreamSyncIntervalS).toBe(3600);
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net', LITESTREAM_SYNC_INTERVAL_S: '30' }).litestreamSyncIntervalS).toBe(30);
  });

  it('the next run at HH:MM in a time zone, across DST', () => {
    // 2026-11-01 is the DST end in America/Chicago.
    const before = Date.UTC(2026, 9, 31, 12); // 07:00 CDT
    expect(new Date(nextRunAt(before, '03:15', 'America/Chicago')).toISOString()).toBe('2026-11-01T09:15:00.000Z'); // 03:15 CST = UTC-6
    expect(new Date(nextRunAt(Date.UTC(2026, 9, 6, 7, 0), '03:15', 'America/Chicago')).toISOString()).toBe('2026-10-06T08:15:00.000Z');
    expect(new Date(nextRunAt(Date.UTC(2026, 9, 6, 9, 0), '03:15', 'America/Chicago')).toISOString()).toBe('2026-10-07T08:15:00.000Z');
  });
});

void existsSync;

describe('backup now', () => {
  const dir = tmpDir();
  // A stand-in for Litestream's control socket (POST /sync, 0.5.17).
  async function fakeSocket(path: string, answer: (body: any) => [number, object]) {
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const [code, out] = answer(JSON.parse(b || '{}'));
        res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => srv.listen(path, r));
    return srv;
  }

  it('forces a Litestream sync and writes a manual snapshot; audited; recorded', async () => {
    const s = setup(dir);
    const sock = join(dir, 'ls1.sock');
    let asked: any = null;
    const srv = await fakeSocket(sock, (b) => { asked = b; return [200, { status: 'synced', path: b.path, txid: 7, replicated_txid: 7 }]; });
    const r = await backupNow({ ...s, socketPath: sock, actor: 'admin@example.com' });
    srv.close();
    expect(asked).toEqual({ path: s.dbFile, wait: true, timeout: 30 });
    expect(r).toMatchObject({ ok: true, litestream: { ok: true, status: 'synced' }, snapshot: { ok: true, key: 'cams-admin/test/snapshots/manual-20261006T081500Z.sqlite.gz' } });
    expect(r.snapshot.bytes).toBeGreaterThan(100);
    expect(s.audit.list({ action: 'backup-now' }).items[0]).toMatchObject({ actor: 'admin@example.com', outcome: 'ok' });
    expect(s.db.prepare(`SELECT last_outcome FROM jobs WHERE name='backup-now'`).get()).toEqual({ last_outcome: 'ok' });
  });

  it('a sidecar that is down and an unreachable S3 give clear, audited errors', async () => {
    const s = setup(dir);
    const r = await backupNow({ ...s, socketPath: join(dir, 'missing.sock'), store: { ...s.store, put: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:29012'); } }, actor: 'admin@example.com' });
    expect(r.ok).toBe(false);
    expect(r.litestream.error).toMatch(/Litestream control socket unreachable/);
    expect(r.snapshot.error).toMatch(/ECONNREFUSED/);
    expect(s.audit.list({ action: 'backup-now' }).items[0]).toMatchObject({ outcome: 'failed', detail: { litestream: expect.stringMatching(/unreachable/), snapshot: expect.stringMatching(/ECONNREFUSED/) } });
  });

  it('without a socket configured, the Litestream step says so and the snapshot still runs', async () => {
    const s = setup(dir);
    const r = await backupNow({ ...s, socketPath: null, actor: 'admin@example.com' });
    expect(r.litestream).toMatchObject({ ok: false, error: 'Litestream is not configured (LITESTREAM_SOCKET)' });
    expect(r.snapshot.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('a Litestream error answer is reported', async () => {
    const s = setup(dir);
    const sock = join(dir, 'ls2.sock');
    const srv = await fakeSocket(sock, () => [404, { error: 'database not found: /x' }]);
    const r = await backupNow({ ...s, socketPath: sock, actor: 'a@example.com' });
    srv.close();
    expect(r.litestream).toMatchObject({ ok: false, error: 'Litestream: database not found: /x' });
  });
});
