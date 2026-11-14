import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from './live';

class FakeSource {
  static made: FakeSource[] = [];
  closed = false;
  private l = new Map<string, ((e: unknown) => void)[]>();
  constructor(public url: string) { FakeSource.made.push(this); }
  addEventListener(type: string, fn: (e: unknown) => void) { this.l.set(type, [...(this.l.get(type) ?? []), fn]); }
  emit(type: string, data?: unknown) { for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

beforeEach(() => { FakeSource.made = []; vi.stubGlobal('EventSource', FakeSource); });
afterEach(() => vi.unstubAllGlobals());

describe('live: one shared stream per tab', () => {
  it('two subscribers share one EventSource; both get every event; the last unsubscribe closes it', () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = live({ registry: (r) => a.push(r.id), open: () => a.push('open') });
    const stopB = live({ registry: (r) => b.push(r.id), status: (s) => b.push(s.proxyId) });
    expect(FakeSource.made).toHaveLength(1);
    expect(FakeSource.made[0].url).toBe('/api/v1/live');
    const es = FakeSource.made[0];
    es.emit('open');
    es.emit('registry', { type: 'proxy', id: 'px1' });
    es.emit('status', { proxyId: 'px2' });
    expect(a).toEqual(['open', 'px1']);
    expect(b).toEqual(['px1', 'px2']);
    stopA();
    stopA(); // twice is harmless
    expect(es.closed).toBe(false);
    es.emit('registry', { type: 'proxy', id: 'px3' });
    expect(a).toEqual(['open', 'px1']);
    stopB();
    expect(es.closed).toBe(true);
    const stopC = live({});
    expect(FakeSource.made).toHaveLength(2); // a new subscriber opens a new stream
    stopC();
  });
  it('the same handler object subscribed twice counts twice', () => {
    const h = { registry: vi.fn() };
    const s1 = live(h);
    const s2 = live(h);
    FakeSource.made[0].emit('registry', { type: 'x', id: 'y' });
    expect(h.registry).toHaveBeenCalledTimes(2);
    s1();
    expect(FakeSource.made[0].closed).toBe(false);
    s2();
    expect(FakeSource.made[0].closed).toBe(true);
  });
});
