import { describe, expect, it, vi } from 'vitest';
import { BUILD_CHECK_MS, readServedBuild, watchBuild } from './buildCheck';

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe('the new-version check', () => {
  it('reads the served build id without the cache; anything unreadable is null', async () => {
    const f = answer({ id: 'b2' });
    expect(await readServedBuild(f)).toBe('b2');
    expect(f).toHaveBeenCalledWith('/build.json', { cache: 'no-store' });
    expect(await readServedBuild(answer({ id: 'b2' }, false))).toBeNull();
    expect(await readServedBuild(answer({ id: 7 }))).toBeNull();
    expect(await readServedBuild(answer(null))).toBeNull();
    expect(await readServedBuild(vi.fn(async () => { throw new Error('offline'); }))).toBeNull();
  });

  it('checks every 5 minutes and on focus; reports a different id once; never reloads', async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    let served = 'b1';
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ id: served }) }) as Response);
    const onNew = vi.fn();
    const stop = watchBuild('b1', onNew, { fetch: f, target });
    expect(BUILD_CHECK_MS).toBe(5 * 60_000);
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_MS);
    expect(f).toHaveBeenCalledTimes(1);
    expect(onNew).not.toHaveBeenCalled();
    served = 'b2';
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).toHaveBeenCalledWith('b2');
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_MS);
    expect(onNew).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_MS * 2);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a dev build (no own id) and an unreadable answer never report', async () => {
    vi.useFakeTimers();
    const onNew = vi.fn();
    const stop = watchBuild('', onNew, { fetch: answer({ id: 'b2' }), target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_MS);
    stop();
    const stop2 = watchBuild('b1', onNew, { fetch: answer({}, false), target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_MS);
    stop2();
    expect(onNew).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
