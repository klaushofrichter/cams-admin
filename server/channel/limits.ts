// Fixed-window counters keyed by an identity the server has validated (a
// code hash, a proxy id, a connection, a session) or by "global". Never by
// the client address: LAN proxies hairpin in as the router's address, and
// X-Forwarded-For can be forged (spec §7, kube-setup 2026-10-06).

export type Take = { ok: true } | { ok: false; retryAfterS: number };

export class Buckets {
  private m = new Map<string, { start: number; n: number }>();
  private lastSweep = 0;
  constructor(private o: { capacity: number; windowMs: number }) {}

  take(key: string, now: number): Take {
    this.sweep(now);
    let w = this.m.get(key);
    if (!w || now - w.start >= this.o.windowMs) {
      w = { start: now, n: 0 };
      this.m.set(key, w);
    }
    if (w.n >= this.o.capacity) return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + this.o.windowMs - now) / 1000)) };
    w.n++;
    return { ok: true };
  }

  // Counts without taking (e.g. "is this key over its budget now?").
  full(key: string, now: number): boolean {
    const w = this.m.get(key);
    return !!w && now - w.start < this.o.windowMs && w.n >= this.o.capacity;
  }

  size(): number {
    return this.m.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.o.windowMs) return;
    this.lastSweep = now;
    for (const [k, w] of this.m) if (now - w.start >= this.o.windowMs) this.m.delete(k);
  }
}
