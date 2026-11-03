// Diagnostics and operations tokens: a live token (not revoked, not expired)
// whose expiry is more than 90 days away, or that never expires (expiresAt
// null), is long-lived. The token lists show it in the warning colour and the
// dashboard counts it in its "long token" badge: both use longLived.
import { when } from './format';

const DAY = 86400_000;
export const LONG_LIVED_DAYS = 90;

export interface TokenTimes { expiresAt: number | null; revokedAt?: number | null }

export function longLived(t: TokenTimes, now: number): boolean {
  if (t.revokedAt !== null && t.revokedAt !== undefined) return false;
  if (t.expiresAt === null || t.expiresAt === undefined) return true;
  return t.expiresAt - now > LONG_LIVED_DAYS * DAY;
}

export interface Expiry { text: string; long: boolean; title: string }

export function tokenExpiry(t: TokenTimes, now: number): Expiry {
  const never = t.expiresAt === null || t.expiresAt === undefined;
  const long = longLived(t, now);
  return { text: never ? 'never' : when(t.expiresAt), long, title: !long ? '' : never ? 'Never expires' : `Long-lived token (expires in over ${LONG_LIVED_DAYS} days)` };
}

// The dashboard badge: the long-lived tokens' names, diagnostics then operations.
export function longTokens(diag: ({ name: string } & TokenTimes)[], ops: ({ name: string } & TokenTimes)[], now: number): string[] {
  return [...diag, ...ops].filter((t) => longLived(t, now)).map((t) => t.name);
}

export const longTokenText = (n: number): string => (n === 1 ? 'long token' : `${n} long tokens`);

// The issue form's days: a whole number from 1 to max, or 0 for never.
export const longLivedDays = (days: number): boolean => days === 0 || days > LONG_LIVED_DAYS;
