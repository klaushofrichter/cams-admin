// Diagnostics and operations tokens in the lists: a token valid for more than
// 90 days, or one that never expires (expiresAt null), is long-lived and shown
// in the warning colour.
import { when } from './format';

const DAY = 86400_000;
export const LONG_LIVED_DAYS = 90;

export interface Expiry { text: string; long: boolean; title: string }

export function tokenExpiry(t: { createdAt: number; expiresAt: number | null }): Expiry {
  if (t.expiresAt === null || t.expiresAt === undefined) return { text: 'never', long: true, title: 'Never expires' };
  const long = t.expiresAt - t.createdAt > LONG_LIVED_DAYS * DAY;
  return { text: when(t.expiresAt), long, title: long ? `Long-lived token (over ${LONG_LIVED_DAYS} days)` : '' };
}

// The issue form's days: a whole number from 1 to max, or 0 for never.
export const longLivedDays = (days: number): boolean => days === 0 || days > LONG_LIVED_DAYS;
