import { createHash, randomBytes } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import { normaliseEmail } from '../validate';

// System administrator sessions (spec §7): server-side rows keyed by the
// SHA-256 of the cookie value; 12 hours absolute, no silent renewal.
export const SESSION_COOKIE = '__Host-cams_admin';
export const SESSION_MS = 12 * 3600_000;

export interface Session { idHash: string; email: string; createdAt: number; expiresAt: number }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

// SYSADMIN_EMAILS, re-read on every call: removing an email ends access at
// that person's next request.
export function sysadminEmails(): Set<string> {
  const out = new Set<string>();
  for (const e of (process.env.SYSADMIN_EMAILS ?? '').split(',')) {
    try {
      if (e.trim()) out.add(normaliseEmail(e));
    } catch {
      /* a malformed entry allows nobody */
    }
  }
  return out;
}
export const sysadminAllowed = (email: string): boolean => sysadminEmails().has(email);

export class Sessions {
  constructor(private db: Db, private clock: Clock) {}

  create(email: string): { value: string; session: Session } {
    const value = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const s = { idHash: hash(value), email, createdAt: now, expiresAt: now + SESSION_MS };
    tx(this.db, () => this.db.prepare('INSERT INTO sessions (id_hash, email, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)').run(s.idHash, email, now, s.expiresAt, now));
    return { value, session: s };
  }

  // The session for a cookie value, or null (expired rows are deleted; the
  // allowlist is checked again).
  get(value: unknown): Session | null {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const r = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hash(value)) as Record<string, string | number> | undefined;
    if (!r) return null;
    const now = this.clock.now();
    if ((r.expires_at as number) <= now || !sysadminAllowed(r.email as string)) {
      tx(this.db, () => this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(r.id_hash));
      return null;
    }
    return { idHash: r.id_hash as string, email: r.email as string, createdAt: r.created_at as number, expiresAt: r.expires_at as number };
  }

  destroy(value: unknown): void {
    if (typeof value === 'string') tx(this.db, () => this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(value)));
  }

  // sessions-ended: every session, e.g. after a restore.
  endAll(): number {
    return tx(this.db, () => Number(this.db.prepare('DELETE FROM sessions').run().changes));
  }

  prune(): void {
    tx(this.db, () => this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.clock.now()));
  }
}
