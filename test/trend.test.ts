import { describe, expect, it } from 'vitest';
import { heapTrend, theilSen } from '../test-client/trend';

const MiB = 1024 * 1024;
const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: i * 60_000, heap: f(i) }));
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (seed / 2 ** 31 - 0.5) * 2; };

describe('heap trend (the load test\'s leak check)', () => {
  it('Theil–Sen: the median pairwise slope, robust to a few outliers', () => {
    expect(theilSen([0, 1, 2, 3, 4, 5, 6].map((x) => ({ x, y: x === 4 ? 100 : x })))).toBeCloseTo(1, 5);
    expect(theilSen([{ x: 0, y: 5 }])).toBe(0);
  });
  it('a flat heap with ±3 % noise and a GC-timing spike passes', () => {
    const s = series(60, (i) => 40 * MiB * (1 + 0.03 * noise()) + (i === 40 ? 15 * MiB : 0));
    expect(heapTrend(s, 3600_000)).toMatchObject({ ok: true });
  });
  it('a slow leak of 10 % an hour fails, even under the noise', () => {
    const s = series(60, (i) => 40 * MiB * (1 + 0.1 * (i / 60) + 0.03 * noise()));
    const r = heapTrend(s, 3600_000);
    expect(r.ok).toBe(false);
    expect(r.growthPct).toBeGreaterThan(5);
  });
  it('the warm-up quarter is ignored; missing heap samples (no --expose-gc) give no verdict', () => {
    const s = series(60, (i) => (i < 15 ? 20 * MiB + i * MiB : 40 * MiB));
    expect(heapTrend(s, 3600_000).ok).toBe(true);
    expect(heapTrend(series(10, () => null as unknown as number), 3600_000)).toMatchObject({ ok: false, detail: expect.stringMatching(/no heap samples/) });
  });
});
