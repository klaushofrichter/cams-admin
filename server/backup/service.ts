import { join } from 'path';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import type { BackupService, BackupState, ManualBackup } from '../api/router';
import { fileStore, s3Store, type ObjectStore } from './store';
import { backupNow, runSnapshot } from './snapshot';
import { LitestreamWatch } from './litestream';
import { ReplicaWatch } from './replica';
import { BackupHeartbeat } from './heartbeat';
import { S3Client } from '@aws-sdk/client-s3';
import { nextRunAt } from './scheduler';
import { log } from '../log';

const H = 3600_000;

// Replication lag: lastReplicationAt is the newest replica object in S3.
// Litestream uploads at most one sync interval (LITESTREAM_SYNC_INTERVAL_S,
// 1 h) after a write and the heartbeat writes at least once an interval, so
// it is late after two intervals plus 5 min (kube-setup's Grafana dead-man
// alert uses the same 7500 s on /health).
export function backupAlerts(o: { now: number; configured: boolean; lastOkAt: number | null; lastOutcome: string | null; litestream: boolean; lastReplicationAt: number | null; startedAt: number; syncIntervalMs?: number; replicationCheckError?: string | null; litestreamSyncErrors?: number | null; litestreamReplicaErrors?: number | null }): string[] {
  const a: string[] = [];
  if (!o.configured) a.push('backup-not-configured');
  if (o.lastOutcome === 'failed') a.push('snapshot-failed');
  // None in 26 h (counted from start when there was never one).
  if (o.configured && o.now - (o.lastOkAt ?? o.startedAt) > 26 * H) a.push('snapshot-stale');
  if (o.litestream && o.now - (o.lastReplicationAt ?? o.startedAt) > 2 * (o.syncIntervalMs ?? 3600_000) + 5 * 60_000) a.push('replication-lag');
  if (o.replicationCheckError) a.push('replication-check-failed');
  if ((o.litestreamSyncErrors ?? 0) > 0) a.push('litestream-sync-errors');
  if ((o.litestreamReplicaErrors ?? 0) > 0) a.push('litestream-replica-errors');
  return a;
}

// The S3 client of the replica check: the app's credentials (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY, ListBucket on the prefix) from its environment.
function replicaClient(b: NonNullable<Config['backup']>, env: Record<string, string | undefined>): S3Client {
  const credentials = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : undefined;
  return new S3Client({ region: b.region, ...(b.endpoint ? { endpoint: b.endpoint, forcePathStyle: true } : {}), ...(credentials ? { credentials } : {}), requestHandler: { connectionTimeout: 5000, requestTimeout: 15_000 } });
}

export function createBackup(d: { db: Db; clock: Clock; cfg: Config; audit: Audit; env: Record<string, string | undefined> }): BackupService & { start(): void; stop(): void; store: ObjectStore } {
  const store = d.cfg.backup ? s3Store(d.cfg.backup) : fileStore(join(d.cfg.dataDir, 'backups'));
  const prefix = d.cfg.backup?.prefix ?? 'cams-admin/dev/';
  const watch = d.cfg.litestreamMetricsUrl ? new LitestreamWatch(d.cfg.litestreamMetricsUrl, d.clock) : null;
  // With Litestream: freshness read from the replica in S3, and the idle heartbeat.
  const replica = watch && d.cfg.backup ? new ReplicaWatch({ client: replicaClient(d.cfg.backup, d.env), bucket: d.cfg.backup.bucket, root: `${prefix}litestream/`, clock: d.clock }) : null;
  const heartbeat = watch ? new BackupHeartbeat(d.db, d.clock, d.cfg.litestreamSyncIntervalS * 1000) : null;
  const startedAt = d.clock.now();
  let timer: NodeJS.Timeout | null = null;
  const tz = d.env.TZ || 'America/Chicago';
  const deps = { db: d.db, dbFile: d.cfg.dbFile, clock: d.clock, audit: d.audit, store, prefix, retentionDays: d.cfg.snapshotRetentionDays };

  const schedule = () => {
    const at = nextRunAt(d.clock.now(), d.cfg.snapshotAt, tz);
    timer = setTimeout(() => {
      runSnapshot(deps).then((r) => log.info({ ok: r.ok, key: r.key, error: r.error }, 'snapshot')).finally(schedule);
    }, Math.max(1000, at - d.clock.now()));
    timer.unref();
  };

  return {
    store,
    state(): BackupState {
      // One read for both jobs (state() backs /health and the dashboard).
      const jobs = new Map((d.db.prepare(`SELECT * FROM jobs WHERE name IN ('snapshot', 'backup-now')`).all() as Record<string, string | number | null>[]).map((r) => [r.name, r]));
      const j = jobs.get('snapshot');
      const m = jobs.get('backup-now');
      const lastOkAt = (j?.last_ok_at as number | null) ?? null;
      const detail = j?.last_detail ? JSON.parse(j.last_detail as string) : null;
      return {
        configured: !!d.cfg.backup,
        litestream: !!watch,
        store: store.describe().replace(/^file:\/\/.*/, 'local folder (no S3 configured)'),
        lastManual: m ? (JSON.parse(m.last_detail as string) as ManualBackup) : null,
        lastSnapshotAt: lastOkAt,
        lastSnapshotOk: j ? j.last_outcome === 'ok' : null,
        lastSnapshotError: j?.last_outcome === 'failed' ? (detail?.error ?? 'failed') : null,
        lastReplicationAt: replica?.lastReplicationAt ?? null,
        lastReplicationCheckAt: replica?.lastCheckAt ?? null,
        lastReplicationError: replica?.lastErrorDetail ?? null,
        replicationCheckErrors: replica?.errors ?? 0,
        litestreamSyncErrors: watch?.syncErrors ?? null,
        litestreamReplicaErrors: watch?.replicaErrors ?? null,
        litestreamMetricsError: watch?.lastError ?? null,
        alerts: backupAlerts({
          now: d.clock.now(), configured: !!d.cfg.backup, lastOkAt, lastOutcome: (j?.last_outcome as string) ?? null, litestream: !!watch, lastReplicationAt: replica?.lastReplicationAt ?? null, startedAt, syncIntervalMs: d.cfg.litestreamSyncIntervalS * 1000,
          replicationCheckError: replica?.lastError ?? null, litestreamSyncErrors: watch?.syncErrors ?? null, litestreamReplicaErrors: watch?.replicaErrors ?? null,
        }),
      };
    },
    async backupNow(actor: string) {
      return backupNow({ ...deps, actor, socketPath: d.cfg.litestreamSocket });
    },
    start() {
      watch?.start();
      // At startup too: a restart gets the value from S3, not from memory.
      replica?.start(d.cfg.replicationCheckS * 1000);
      heartbeat?.start();
      schedule();
    },
    stop() {
      watch?.stop();
      replica?.stop();
      heartbeat?.stop();
      if (timer) clearTimeout(timer);
    },
  };
}
