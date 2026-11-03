import { describe, expect, it } from 'vitest';
import { longLivedDays, tokenExpiry } from './tokens';
import { when } from './format';

const DAY = 86400_000;

describe('token expiry', () => {
  it('never expires: "never", long-lived', () => {
    expect(tokenExpiry({ createdAt: 1, expiresAt: null })).toEqual({ text: 'never', long: true, title: 'Never expires' });
  });
  it('more than 90 days is long-lived; 90 days or less is not', () => {
    const t0 = 1_700_000_000_000;
    expect(tokenExpiry({ createdAt: t0, expiresAt: t0 + 91 * DAY })).toEqual({ text: when(t0 + 91 * DAY), long: true, title: 'Long-lived token (over 90 days)' });
    expect(tokenExpiry({ createdAt: t0, expiresAt: t0 + 90 * DAY })).toEqual({ text: when(t0 + 90 * DAY), long: false, title: '' });
    expect(tokenExpiry({ createdAt: t0, expiresAt: t0 + 30 * DAY }).long).toBe(false);
  });
  it('the issue form flags 0 and over 90 days', () => {
    expect(longLivedDays(0)).toBe(true);
    expect(longLivedDays(91)).toBe(true);
    expect(longLivedDays(180)).toBe(true);
    expect(longLivedDays(90)).toBe(false);
    expect(longLivedDays(1)).toBe(false);
  });
});
