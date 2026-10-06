import { join } from 'path';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import type { BackupService, BackupState, ManualBackup } from '../api/router';
import { fileStore, s3Store, type ObjectStore } from './store';
import { backupNow, runSnapshot } from './snapshot';
import { LitestreamWatch } from './litestream';
import { nextRunAt } from './scheduler';
import { log } from '../log';

const H = 3600_000;

export function backupAlerts(o: { now: number; configured: boolean; lastOkAt: number | null; lastOutcome: string | null; litestream: boolean; lastReplicationAt: number | null; startedAt: number }): string[] {
  const a: string[] = [];
  if (!o.configured) a.push('backup-not-configured');
  if (o.lastOutcome === 'failed') a.push('snapshot-failed');
  // None in 26 h (counted from start when there was never one).
  if (o.configured && o.now - (o.lastOkAt ?? o.startedAt) > 26 * H) a.push('snapshot-stale');
  if (o.litestream && o.now - (o.lastReplicationAt ?? o.startedAt) > 5 * 60_000) a.push('replication-lag');
  return a;
}

export function createBackup(d: { db: Db; clock: Clock; cfg: Config; audit: Audit; env: Record<string, string | undefined> }): BackupService & { start(): void; stop(): void; store: ObjectStore } {
  const store = d.cfg.backup ? s3Store(d.cfg.backup) : fileStore(join(d.cfg.dataDir, 'backups'));
  const prefix = d.cfg.backup?.prefix ?? 'cams-admin/dev/';
  const watch = d.cfg.litestreamMetricsUrl ? new LitestreamWatch(d.cfg.litestreamMetricsUrl, d.clock) : null;
  const startedAt = d.clock.now();
  let timer: NodeJS.Timeout | null = null;
  const tz = d.env.TZ || 'America/Chicago';
  const snap = (actor?: string) => runSnapshot({ db: d.db, dbFile: d.cfg.dbFile, clock: d.clock, audit: d.audit, store, prefix, retentionDays: d.cfg.snapshotRetentionDays, actor });

  const schedule = () => {
    const at = nextRunAt(d.clock.now(), d.cfg.snapshotAt, tz);
    timer = setTimeout(() => {
      snap().then((r) => log.info({ ok: r.ok, key: r.key, error: r.error }, 'snapshot')).finally(schedule);
    }, Math.max(1000, at - d.clock.now()));
    timer.unref();
  };

  return {
    store,
    state(): BackupState {
      const j = d.db.prepare(`SELECT * FROM jobs WHERE name = 'snapshot'`).get() as Record<string, string | number | null> | undefined;
      const lastOkAt = (j?.last_ok_at as number | null) ?? null;
      const detail = j?.last_detail ? JSON.parse(j.last_detail as string) : null;
      const m = d.db.prepare(`SELECT last_detail FROM jobs WHERE name = 'backup-now'`).get() as { last_detail: string } | undefined;
      return {
        configured: !!d.cfg.backup,
        litestream: !!watch,
        store: store.describe().replace(/^file:\/\/.*/, 'local folder (no S3 configured)'),
        lastManual: m ? (JSON.parse(m.last_detail) as ManualBackup) : null,
        lastSnapshotAt: lastOkAt,
        lastSnapshotOk: j ? j.last_outcome === 'ok' : null,
        lastSnapshotError: j?.last_outcome === 'failed' ? (detail?.error ?? 'failed') : null,
        lastReplicationAt: watch?.lastReplicationAt ?? null,
        alerts: backupAlerts({ now: d.clock.now(), configured: !!d.cfg.backup, lastOkAt, lastOutcome: (j?.last_outcome as string) ?? null, litestream: !!watch, lastReplicationAt: watch?.lastReplicationAt ?? null, startedAt }),
      };
    },
    async backupNow(actor: string) {
      return backupNow({ db: d.db, dbFile: d.cfg.dbFile, clock: d.clock, audit: d.audit, store, prefix, retentionDays: d.cfg.snapshotRetentionDays, actor, socketPath: d.cfg.litestreamSocket });
    },
    start() {
      watch?.start();
      schedule();
    },
    stop() {
      watch?.stop();
      if (timer) clearTimeout(timer);
    },
  };
}
