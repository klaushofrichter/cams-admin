import type { Clock } from '../clock';

// Reads Litestream's Prometheus metrics over localhost (spec §13.3).
// lastReplicationAt is the last poll at which litestream_sync_count advanced
// while litestream_sync_error_count did not (metric names of Litestream
// 0.5.17, measured 2026-10-06).

export function parseMetrics(text: string): { sync: number; errors: number } | null {
  const sum = (name: string) => {
    let found = false, total = 0;
    for (const line of text.split('\n')) {
      const m = new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`).exec(line.trim());
      if (m) { found = true; total += Number(m[2]); }
    }
    return found ? total : null;
  };
  const sync = sum('litestream_sync_count');
  const errors = sum('litestream_sync_error_count');
  return sync === null ? null : { sync, errors: errors ?? 0 };
}

export class LitestreamWatch {
  lastReplicationAt: number | null = null;
  lastError: string | null = null;
  private prev: { sync: number; errors: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private url: string, private clock: Clock) {}

  async poll(): Promise<void> {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(5000) });
      const m = parseMetrics(await r.text());
      if (!m) throw new Error('no litestream metrics');
      if (this.prev && m.sync > this.prev.sync && m.errors <= this.prev.errors) this.lastReplicationAt = this.clock.now();
      this.prev = m;
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
