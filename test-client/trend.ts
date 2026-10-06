// The load test's leak check: the live heap after a forced full GC
// (/dev/metrics?gc=1, the server runs with --expose-gc), its trend fitted
// over the run after the warm-up quarter with Theil–Sen (the median of the
// pairwise slopes: a GC-timing spike or two can't move it). RSS endpoints
// are no leak signal: RSS follows the allocator and swings ±10 % without one.

export const HEAP_GROWTH_LIMIT_PCT = 5;

export function theilSen(pts: { x: number; y: number }[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j].x !== pts[i].x) slopes.push((pts[j].y - pts[i].y) / (pts[j].x - pts[i].x));
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  const m = slopes.length >> 1;
  return slopes.length % 2 ? slopes[m] : (slopes[m - 1] + slopes[m]) / 2;
}

// Growth over the measured span (after the warm-up quarter), in % of the median heap.
export function heapTrend(samples: { t: number; heap: number | null }[], durationMs: number): { ok: boolean; growthPct: number; slopeMiBPerHour: number; detail: string } {
  const pts = samples.filter((s) => s.heap !== null && Number.isFinite(s.heap) && s.t >= durationMs / 4).map((s) => ({ x: s.t, y: s.heap as number }));
  if (pts.length < 3) return { ok: false, growthPct: 0, slopeMiBPerHour: 0, detail: 'no heap samples (the server needs --expose-gc)' };
  const slope = theilSen(pts);
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const median = ys[ys.length >> 1];
  const span = pts[pts.length - 1].x - pts[0].x;
  const growthPct = ((slope * span) / median) * 100;
  const slopeMiBPerHour = (slope * 3600_000) / (1024 * 1024);
  return { ok: growthPct < HEAP_GROWTH_LIMIT_PCT, growthPct, slopeMiBPerHour, detail: `${growthPct.toFixed(1)} % over ${Math.round(span / 60_000)} min (${slopeMiBPerHour.toFixed(2)} MiB/h, median ${(median / 1048576).toFixed(1)} MiB)` };
}
