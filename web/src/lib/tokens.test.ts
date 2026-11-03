import { describe, expect, it } from 'vitest';
import { longLived, longLivedDays, longTokens, longTokenText, tokenExpiry } from './tokens';
import { when } from './format';

const DAY = 86400_000;
const NOW = 1_700_000_000_000;

describe('long-lived tokens', () => {
  it('the rule at its boundary: more than 90 days remaining, or never; revoked or expired never', () => {
    expect(longLived({ expiresAt: NOW + 90 * DAY, revokedAt: null }, NOW)).toBe(false);
    expect(longLived({ expiresAt: NOW + 90 * DAY + 1, revokedAt: null }, NOW)).toBe(true);
    expect(longLived({ expiresAt: null, revokedAt: null }, NOW)).toBe(true);
    expect(longLived({ expiresAt: null }, NOW)).toBe(true);
    expect(longLived({ expiresAt: NOW - 1, revokedAt: null }, NOW)).toBe(false);
    expect(longLived({ expiresAt: NOW, revokedAt: null }, NOW)).toBe(false);
    expect(longLived({ expiresAt: null, revokedAt: NOW - 1 }, NOW)).toBe(false);
    expect(longLived({ expiresAt: NOW + 180 * DAY, revokedAt: NOW - 1 }, NOW)).toBe(false);
  });
  it('a 180 day token stops being long-lived 90 days later', () => {
    const t = { expiresAt: NOW + 180 * DAY, revokedAt: null };
    expect(longLived(t, NOW + 89 * DAY)).toBe(true);
    expect(longLived(t, NOW + 90 * DAY)).toBe(false);
    expect(longLived(t, NOW + 91 * DAY)).toBe(false);
  });
  it('the list cell: "never" or the date, orange and a tooltip when long-lived', () => {
    expect(tokenExpiry({ expiresAt: null }, NOW)).toEqual({ text: 'never', long: true, title: 'Never expires' });
    expect(tokenExpiry({ expiresAt: NOW + 91 * DAY }, NOW)).toEqual({ text: when(NOW + 91 * DAY), long: true, title: 'Long-lived token (expires in over 90 days)' });
    expect(tokenExpiry({ expiresAt: NOW + 30 * DAY }, NOW)).toEqual({ text: when(NOW + 30 * DAY), long: false, title: '' });
    expect(tokenExpiry({ expiresAt: null, revokedAt: NOW }, NOW)).toEqual({ text: 'never', long: false, title: '' });
  });
  it('the dashboard badge: the names of the long-lived diagnostics and operations tokens', () => {
    const diag = [{ name: 'mac', expiresAt: null, revokedAt: null }, { name: 'short', expiresAt: NOW + DAY, revokedAt: null }];
    const ops = [{ name: 'script', expiresAt: NOW + 120 * DAY, revokedAt: null }, { name: 'gone', expiresAt: null, revokedAt: 1 }];
    expect(longTokens(diag, ops, NOW)).toEqual(['mac', 'script']);
    expect(longTokens([], [], NOW)).toEqual([]);
    expect(longTokenText(1)).toBe('long token');
    expect(longTokenText(2)).toBe('2 long tokens');
  });
  it('the issue form flags 0 and over 90 days', () => {
    expect(longLivedDays(0)).toBe(true);
    expect(longLivedDays(91)).toBe(true);
    expect(longLivedDays(90)).toBe(false);
    expect(longLivedDays(1)).toBe(false);
  });
});
