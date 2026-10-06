import type { Clock } from '../../server/clock';
export interface FakeClock extends Clock { set(t: number): void; advance(ms: number): void }
export function fakeClock(start = 1_791_273_600_000): FakeClock {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}
