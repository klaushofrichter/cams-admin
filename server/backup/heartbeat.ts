import type { Clock } from '../clock';
import { readEpoch, tx, type Db } from '../db/open';
import { log } from '../log';

// Litestream uploads only when the database changed (0.5.17 waits for new
// data), so an idle database would leave S3 quiet and lastReplicationAt
// stale although replication is fine. When nothing was written for one
// LITESTREAM_SYNC_INTERVAL_S, one tiny write (the `backup-heartbeat` row of
// `jobs`) makes Litestream upload one object: at most one write and one PUT
// per interval (≈720 a month at 1 h), none while the app writes anyway (a
// connected fleet's 10-minute status snapshot). The check (a read of
// meta.write_epoch) runs 12 times per interval, so the gap between two
// uploads stays under 1/12 interval over the interval (65 min at 1 h).
export class BackupHeartbeat {
  private lastEpoch: number;
  private lastWriteAt: number;
  private timer: NodeJS.Timeout | null = null;
  writes = 0;
  constructor(private db: Db, private clock: Clock, private intervalMs: number) {
    this.lastEpoch = readEpoch(db);
    this.lastWriteAt = clock.now();
  }

  // One check; true when it wrote.
  tick(): boolean {
    const now = this.clock.now();
    const epoch = readEpoch(this.db);
    if (epoch !== this.lastEpoch) {
      this.lastEpoch = epoch;
      this.lastWriteAt = now;
      return false;
    }
    if (now - this.lastWriteAt < this.intervalMs) return false;
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO jobs (name, last_run_at, last_ok_at, last_outcome) VALUES ('backup-heartbeat', ?, ?, 'ok')
        ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, last_outcome = 'ok'`).run(now, now);
    });
    this.writes++;
    this.lastEpoch = readEpoch(this.db);
    this.lastWriteAt = now;
    return true;
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        log.warn({ err: e }, 'backup_heartbeat_failed'); // the next check tries again
      }
    }, Math.max(250, Math.floor(this.intervalMs / 12)));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
