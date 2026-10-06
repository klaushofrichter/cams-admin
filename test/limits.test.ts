import { describe, expect, it } from 'vitest';
import { Buckets } from '../server/channel/limits';

describe('buckets', () => {
  it('allows capacity per window per key, then answers retryAfterS', () => {
    const b = new Buckets({ capacity: 3, windowMs: 60_000 });
    expect([1, 2, 3].map(() => b.take('k', 0).ok)).toEqual([true, true, true]);
    expect(b.take('k', 10_000)).toEqual({ ok: false, retryAfterS: 50 });
    expect(b.take('other', 10_000).ok).toBe(true);
    expect(b.take('k', 60_000).ok).toBe(true);
  });
  it('forgets idle keys (bounded memory)', () => {
    const b = new Buckets({ capacity: 1, windowMs: 1000 });
    for (let i = 0; i < 10_000; i++) b.take(`k${i}`, 0);
    b.take('x', 5000);
    expect(b.size()).toBe(1);
  });
});
