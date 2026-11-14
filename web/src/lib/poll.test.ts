import { describe, expect, it } from 'vitest';
import { poll } from './poll';

describe('poll', () => {
  it('asks until done, then returns the value', async () => {
    let n = 0;
    const waits: number[] = [];
    const v = await poll(async () => ++n, (x) => x >= 3, { sleep: async (ms) => { waits.push(ms); } });
    expect(v).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });
  it('gives up after 60 s with null', async () => {
    let slept = 0;
    const v = await poll(async () => 1, () => false, { sleep: async (ms) => { slept += ms; } });
    expect(v).toBeNull();
    expect(slept).toBe(60_000);
  });
});
