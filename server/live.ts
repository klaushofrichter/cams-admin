import type { Response } from 'express';
import type { Clock } from './clock';

// Server-sent events to the browsers (GET /api/v1/live, spec §11.1):
// `status` on every proxy change, `registry` when a row changes, a comment
// every 25 s. At most 5 streams per session.

export interface LiveStatus { proxyId: string; accountId: string; state: string; ok: boolean | null; problemCount: number | null; lastHeartbeatAt: number | null; cameras: { ref: string; online: boolean | null }[] }

export class LiveHub {
  private streams = new Map<string, Set<Response>>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private o: { clock: Clock; maxPerSession: number; keepaliveMs: number }) {}

  subscribe(session: string, res: Response): boolean {
    const set = this.streams.get(session) ?? new Set<Response>();
    if (set.size >= this.o.maxPerSession) return false;
    set.add(res);
    this.streams.set(session, set);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.streams.delete(session);
    });
    if (!this.timer && this.o.keepaliveMs > 0) {
      this.timer = setInterval(() => this.keepalive(), this.o.keepaliveMs);
      this.timer.unref();
    }
    return true;
  }

  count(): number {
    let n = 0;
    for (const s of this.streams.values()) n += s.size;
    return n;
  }

  private send(chunk: string): void {
    for (const set of this.streams.values()) for (const r of set) r.write(chunk);
  }

  keepalive(): void {
    this.send(': keep-alive\n\n');
  }

  publishStatus(s: LiveStatus): void {
    this.send(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
  }

  publishRegistry(type: string, id: string): void {
    this.send(`event: registry\ndata: ${JSON.stringify({ type, id })}\n\n`);
  }

  // Sessions that ended (logout, expiry) lose their streams.
  endSession(session: string): void {
    for (const r of this.streams.get(session) ?? []) r.end();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const set of this.streams.values()) for (const r of set) r.end();
    this.streams.clear();
  }
}
