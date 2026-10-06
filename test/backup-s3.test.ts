// Replication freshness measured at the S3 end (kube-setup 2026-10-06:
// litestream_sync_count is Litestream's local WAL sync, ~1/s, and advanced
// while nothing reached S3). Against a local S3 (SeaweedFS in Docker) and
// the pinned Litestream; never the real bucket.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { writeFileSync } from 'fs';
import request from 'supertest';
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { ReplicaWatch } from '../server/backup/replica';
import { fakeClock } from './helpers/clock';
import { tmpDir } from './helpers/tmp';
import { tcpProxy } from './helpers/tcpProxy';
import { testApp } from './helpers/app';
import { hasDocker, localS3, S3_KEY, S3_SECRET } from './helpers/s3';

const BUCKET = 'replica-test';
// CI always has Docker: there the test must run, never skip.
const run = hasDocker() || !!process.env.CI;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(200);
  }
}

describe.skipIf(!run)('lastReplicationAt from S3', () => {
  const dir = tmpDir();
  let s3: Awaited<ReturnType<typeof localS3>>;
  beforeAll(async () => { s3 = await localS3(BUCKET); }, 90_000);
  afterAll(() => s3?.stop());

  const put = async (key: string) => {
    await s3.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: 'x' }));
    return (await s3.s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).LastModified!.getTime();
  };
  const appEnv = (prefix: string, extra: Record<string, string> = {}) => ({
    BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_PREFIX: prefix, S3_ENDPOINT: s3.endpoint, AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: S3_KEY, AWS_SECRET_ACCESS_KEY: S3_SECRET, LITESTREAM_METRICS_URL: 'http://127.0.0.1:9/metrics', ...extra,
  });

  it('an object appears → lastReplicationAt is its LastModified (only under litestream/)', async () => {
    const clock = fakeClock();
    const w = new ReplicaWatch({ client: s3.s3, bucket: BUCKET, root: 'a/litestream/', clock });
    await w.poll();
    expect(w.lastReplicationAt).toBeNull();
    expect(w.lastError).toBeNull();
    const first = await put('a/litestream/0000/0000000000000001-0000000000000001.ltx');
    await w.poll();
    expect(w.lastReplicationAt).toBe(first);
    await wait(1100); // S3 times have one-second resolution
    await put('a/snapshots/2026/10/06/cams-admin-20261006T081500Z.sqlite.gz');
    await w.poll();
    expect(w.lastReplicationAt).toBe(first);
    const second = await put('a/litestream/0000/0000000000000002-0000000000000002.ltx');
    await w.poll();
    expect(second).toBeGreaterThan(first);
    expect(w.lastReplicationAt).toBe(second);
    // A newer object in a new level (Litestream's compaction) counts too,
    // from the next full listing (hourly) on.
    await wait(1100);
    const third = await put('a/litestream/0001/0000000000000001-0000000000000002.ltx');
    clock.advance(3600_000);
    await w.poll();
    expect(w.lastReplicationAt).toBe(third);
    // Between full listings: one request per level directory (StartAfter the last key).
    const before = w.requests;
    clock.advance(300_000);
    await w.poll();
    expect(w.requests - before).toBe(2);
    expect(w.lastReplicationAt).toBe(third);
    expect(w.errors).toBe(0);
  });

  it('S3 unreachable → the value stops advancing and the error shows', async () => {
    const proxy = await tcpProxy(s3.port);
    const w = new ReplicaWatch({ client: s3.client(S3_KEY, `http://127.0.0.1:${proxy.port}`), bucket: BUCKET, root: 'b/litestream/', clock: fakeClock() });
    const t1 = await put('b/litestream/0000/0000000000000001-0000000000000001.ltx');
    await w.poll();
    expect(w.lastReplicationAt).toBe(t1);
    await proxy.close();
    await wait(1100);
    await put('b/litestream/0000/0000000000000002-0000000000000002.ltx');
    await w.poll();
    expect(w.lastReplicationAt).toBe(t1);
    expect(w.lastError).toMatch(/ECONNREFUSED|connect/i);
    expect(w.errors).toBe(1);
  });

  it('wrong credentials → no value, the error shows on /health and the Backup page', async () => {
    const t1 = await put('c/litestream/0000/0000000000000001-0000000000000001.ltx');
    const good = testApp(dir, appEnv('c/'));
    const bad = testApp(dir, appEnv('c/', { AWS_ACCESS_KEY_ID: 'wrongkey' }));
    try {
      good.backup.start?.();
      bad.backup.start?.();
      await until(async () => (await request(good.app).get('/health')).body.backup.lastReplicationAt, 15_000, 'the good app');
      const h = await until(async () => { const r = (await request(bad.app).get('/health')).body.backup; return r.replicationCheckErrors > 0 && r; }, 15_000, 'the bad app');
      expect((await request(good.app).get('/health')).body.backup).toMatchObject({ lastReplicationAt: t1, replicationCheckError: null, replicationCheckErrors: 0 });
      expect(h).toMatchObject({ lastReplicationAt: null, replicationCheckError: 'InvalidAccessKeyId' });
      const page = (await bad.api('get', '/backup')).body;
      expect(page.lastReplicationError).toMatch(/InvalidAccessKeyId/);
      expect(page.alerts).toContain('replication-check-failed');
    } finally {
      await good.close();
      await bad.close();
    }
  });

  it('restart → the value is restored from S3 at startup, not from memory', async () => {
    const t1 = await put('d/litestream/0001/0000000000000001-0000000000000005.ltx');
    const a = testApp(dir, appEnv('d/'));
    try {
      expect((await request(a.app).get('/health')).body.backup.lastReplicationAt).toBeNull();
      a.backup.start?.(); // what listen() does at startup
      await until(async () => (await request(a.app).get('/health')).body.backup.lastReplicationAt, 15_000, 'the startup check');
      expect((await request(a.app).get('/health')).body.backup.lastReplicationAt).toBe(t1);
    } finally {
      await a.close();
    }
  });

  it('an idle database still uploads once per sync interval (the heartbeat write)', async () => {
    const litestream = execFileSync(join(__dirname, '../scripts/backup/litestream.sh'), { encoding: 'utf8' }).trim();
    const prefix = 'e/';
    const a = testApp(dir, appEnv(prefix, { LITESTREAM_SYNC_INTERVAL_S: '4', REPLICATION_CHECK_S: '1' }));
    const conf = join(dir, 'litestream-e.yml');
    // No compaction or snapshot during the test: only syncs upload.
    writeFileSync(conf, `addr: "127.0.0.1:0"\nlevels:\n  - interval: 1h\nsnapshot:\n  interval: 24h\ndbs:\n  - path: ${a.cfg.dbFile}\n    replica:\n      type: s3\n      bucket: ${BUCKET}\n      path: ${prefix}litestream\n      region: us-east-1\n      endpoint: ${s3.endpoint}\n      force-path-style: true\n      access-key-id: ${S3_KEY}\n      secret-access-key: ${S3_SECRET}\n      sync-interval: 1s\n`);
    let ls: ChildProcess | null = null;
    const l0 = async () => ((await s3.s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}litestream/0000/` }))).Contents ?? []).length;
    try {
      ls = spawn(litestream, ['replicate', '-config', conf], { stdio: 'ignore' });
      // The first upload (the migrated database and Litestream's first
      // snapshot), settled; then nothing else writes.
      await until(l0, 20_000, 'the first upload');
      await wait(3000);
      const files0 = await l0();
      a.backup.start?.();
      const t0 = await until(() => a.backup.state().lastReplicationAt, 5_000, 'the startup check');
      // Within one interval (4 s) plus the check period, a new sync object.
      const t1 = await until(() => { const t = a.backup.state().lastReplicationAt; return t !== null && t > t0 && t; }, 9_000, 'an upload from the heartbeat');
      expect(t1).toBeGreaterThan(t0);
      expect(await l0()).toBeGreaterThan(files0);
      expect(a.backup.state().alerts).not.toContain('replication-lag');
    } finally {
      ls?.kill('SIGKILL');
      await a.close();
    }
  }, 60_000);
});
