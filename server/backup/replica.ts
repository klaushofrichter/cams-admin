import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { Clock } from '../clock';

// lastReplicationAt measured at the S3 end (spec §13.3): the LastModified of
// the newest object under `${BACKUP_S3_PREFIX}litestream/`. Litestream's
// metrics cannot say this: litestream_sync_count is its local WAL sync
// (~1/s, measured by kube-setup 2026-10-06) and 0.5.17 counts no failed PUT.
//
// Litestream 0.5.17's S3 layout is `<path>/<level as %04x>/<minTXID>-<maxTXID>.ltx`
// (16 hex digits each): level 0000 gets every sync, 0001/0002 the
// compactions, 0009 the daily snapshot. Within a level the key order is
// the TXID order, so a new object sorts after every key seen before.
//
// Cost: a full listing of the prefix at startup and once an hour (it finds
// new level directories; one request per 1000 objects, about 800 objects
// at 30 days' retention), otherwise one ListObjectsV2 per level directory
// with StartAfter = the last key seen there (an empty answer when nothing
// is new). Four levels every 5 min: 4 × 12 × 24 × 30 = 34,560, plus ≈720
// full listings: ≈ 35,000 LIST requests a month (≈ $0.18 at $0.005 per
// 1000).

const LEVEL = /^([0-9a-f]{4})\//;

export class ReplicaWatch {
  lastReplicationAt: number | null = null;
  lastError: string | null = null; // the error's name or code (no message: /health is public)
  lastErrorDetail: string | null = null; // with its message, for the Backup page
  lastCheckAt: number | null = null;
  errors = 0;
  requests = 0;
  private lastKey = new Map<string, string>(); // level directory → the greatest key seen
  private lastFullAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private o: { client: S3Client; bucket: string; root: string; clock: Clock; fullEveryMs?: number }) {}

  poll(): Promise<void> {
    this.running ??= this.check().finally(() => (this.running = null));
    return this.running;
  }

  private async check(): Promise<void> {
    const now = this.o.clock.now();
    try {
      const full = !this.lastFullAt || now - this.lastFullAt >= (this.o.fullEveryMs ?? 3600_000) || this.lastKey.size === 0;
      let newest = this.lastReplicationAt ?? 0;
      const keys = new Map(full ? [] : this.lastKey);
      const seen = (key: string, at: number) => {
        newest = Math.max(newest, at);
        const m = LEVEL.exec(key.slice(this.o.root.length));
        if (m) {
          const d = `${this.o.root}${m[1]}/`;
          if ((keys.get(d) ?? '') < key) keys.set(d, key);
        }
      };
      if (full) {
        await this.list(this.o.root, undefined, seen);
      } else {
        // The level 0 directory always: a sync lands there first.
        for (const d of new Set([`${this.o.root}0000/`, ...this.lastKey.keys()])) await this.list(d, this.lastKey.get(d), seen);
      }
      // Applied only when every request succeeded.
      this.lastKey = keys;
      if (full) this.lastFullAt = now;
      if (newest) this.lastReplicationAt = newest;
      this.lastError = null;
      this.lastErrorDetail = null;
    } catch (e) {
      const err = e as Error & { Code?: string; code?: string };
      this.errors++;
      this.lastError = (err.Code ?? err.code ?? err.name ?? 'Error').slice(0, 60);
      this.lastErrorDetail = `${this.lastError}: ${err.message}`.slice(0, 200);
    } finally {
      this.lastCheckAt = now;
    }
  }

  private async list(prefix: string, startAfter: string | undefined, seen: (key: string, at: number) => void): Promise<void> {
    let token: string | undefined;
    do {
      this.requests++;
      const r = await this.o.client.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : startAfter ? { StartAfter: startAfter } : {}) }));
      for (const c of r.Contents ?? []) if (c.Key && c.LastModified) seen(c.Key, c.LastModified.getTime());
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  start(everyMs = 300_000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
