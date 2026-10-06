import type { Clock } from '../clock';

// Reads Litestream's Prometheus metrics over localhost (spec §13.3) for its
// error counters only. Freshness comes from S3 itself (replica.ts):
// litestream_sync_count counts Litestream's local WAL syncs (~1/s), not
// uploads. Names checked against the 0.5.17 source (db.go,
// internal/internal.go) and its /metrics output on 2026-10-06:
//   litestream_sync_error_count{db}                               local sync errors
//   litestream_replica_operation_errors_total{replica_type,operation,code}
//     replica errors; in 0.5.17 the S3 client counts only failed DELETEs
//     there. A failed PUT is only logged (and retried with backoff), so no
//     metric shows it: the S3 check is the one that does.

export interface LitestreamMetrics { sync: number; syncErrors: number; replicaErrors: number }

export function parseMetrics(text: string): LitestreamMetrics | null {
  const sum = (name: string) => {
    let found = false, total = 0;
    for (const line of text.split('\n')) {
      const m = new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`).exec(line.trim());
      if (m) { found = true; total += Number(m[2]); }
    }
    return found ? total : null;
  };
  const sync = sum('litestream_sync_count');
  // A labelled counter appears only after its first increment: absent = 0.
  return sync === null ? null : { sync, syncErrors: sum('litestream_sync_error_count') ?? 0, replicaErrors: sum('litestream_replica_operation_errors_total') ?? 0 };
}

export class LitestreamWatch {
  syncErrors: number | null = null;
  replicaErrors: number | null = null;
  lastError: string | null = null;
  lastOkAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private url: string, private clock: Clock) {}

  async poll(): Promise<void> {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(5000) });
      const m = parseMetrics(await r.text());
      if (!m) throw new Error('no litestream metrics');
      this.syncErrors = m.syncErrors;
      this.replicaErrors = m.replicaErrors;
      this.lastOkAt = this.clock.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message.slice(0, 200);
    }
  }

  start(everyMs = 30_000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
