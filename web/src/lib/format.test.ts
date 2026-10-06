import { describe, expect, it } from 'vitest';
import { ago, stateClass, stateLabel, when } from './format';

describe('format', () => {
  it('ages', () => {
    expect(ago(null, 0)).toBe('never');
    expect(ago(1000, 1000)).toBe('0 s ago');
    expect(ago(0, 59_000)).toBe('59 s ago');
    expect(ago(0, 61_000)).toBe('1 min ago');
    expect(ago(0, 3 * 3600_000)).toBe('3 h ago');
    expect(ago(0, 49 * 3600_000)).toBe('2 d ago');
    expect(ago(5000, 1000)).toBe('0 s ago'); // a clock that went back
  });
  it('state chips', () => {
    expect(stateClass('online')).toBe('ok');
    expect(stateClass('offline')).toBe('bad');
    expect(stateClass('rejected')).toBe('bad');
    expect(stateClass('stopped')).toBe('warn');
    expect(stateClass('pending')).toBe('');
    expect(stateLabel('never-connected')).toBe('never connected');
    expect(stateLabel('rejected')).toBe('rejected (no key)');
  });
  it('when: a local date and time, or a dash', () => {
    expect(when(null)).toBe('—');
    expect(when(Date.UTC(2026, 9, 6, 12, 0))).toMatch(/2026/);
  });
});
