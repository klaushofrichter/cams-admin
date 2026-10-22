import { createHash, randomBytes } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError } from '../registry';
import { FieldError } from '../validate';
import { newId } from '../ids';

// Read-only diagnostics tokens (issue #45). A sysadmin issues one, sees it
// once; only its SHA-256 hash is stored. It opens the GET routes under
// /api/v1/diag and nothing else. Reads never write the database: the last
// use lives in memory (the write budget).

export const DIAG_PREFIX = 'cad_';
export const MAX_LIVE = 5;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;
const DAY = 86400_000;

export interface DiagTokenView {
  id: string; name: string; hashPrefix: string; createdAt: number; createdBy: string; expiresAt: number;
  revokedAt: number | null; revokedBy: string | null; lastUsedAt: number | null; state: 'active' | 'expired' | 'revoked';
}
type Row = Record<string, unknown>;

export const hashOf = (token: string) => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;

// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

export class DiagTokens {
  private lastUsed = new Map<string, number>();
  constructor(private d: { db: Db; clock: Clock; audit: Audit; journal?: (tokenId: string) => void }) {}

  private view(r: Row): DiagTokenView {
    const now = this.d.clock.now();
    const id = r.id as string;
    const revokedAt = r.revoked_at as number | null;
    const expiresAt = r.expires_at as number;
    return {
      id, name: r.name as string, hashPrefix: (r.hash as string).slice(7, 15), createdAt: r.created_at as number, createdBy: r.created_by as string,
      expiresAt, revokedAt, revokedBy: r.revoked_by as string | null, lastUsedAt: this.lastUsed.get(id) ?? null,
      state: revokedAt !== null ? 'revoked' : expiresAt <= now ? 'expired' : 'active',
    };
  }

  list(): { items: DiagTokenView[] } {
    return { items: (this.d.db.prepare('SELECT * FROM diag_tokens ORDER BY created_at DESC').all() as Row[]).map((r) => this.view(r)) };
  }

  issue(actor: string, input: unknown): { token: string; item: DiagTokenView } {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!NAME_RE.test(name)) throw new FieldError('name');
    const days = o.days === undefined ? DEFAULT_DAYS : o.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new FieldError('days');
    const now = this.d.clock.now();
    const token = DIAG_PREFIX + randomBytes(32).toString('base64url');
    const hash = hashOf(token);
    const id = newId('dgt');
    tx(this.d.db, () => {
      const live = (this.d.db.prepare('SELECT count(*) n FROM diag_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(now) as { n: number }).n;
      if (live >= MAX_LIVE) throw new ApiError(409, 'too_many_tokens');
      this.d.db.prepare('INSERT INTO diag_tokens (id, name, hash, created_at, created_by, expires_at) VALUES (?,?,?,?,?,?)').run(id, name, hash, now, actor, now + days * DAY);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'diag-token-issue', targetType: 'diag-token', targetId: id, targetLabel: name, outcome: 'ok', detail: { hashPrefix: hash.slice(7, 15), days } });
    });
    return { token, item: this.view(this.d.db.prepare('SELECT * FROM diag_tokens WHERE id = ?').get(id) as Row) };
  }

  revoke(actor: string, id: string): DiagTokenView {
    const now = this.d.clock.now();
    const r = this.d.db.prepare('SELECT * FROM diag_tokens WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    if (r.revoked_at !== null) return this.view(r);
    tx(this.d.db, () => {
      this.d.db.prepare('UPDATE diag_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(now, actor, id);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'diag-token-revoke', targetType: 'diag-token', targetId: id, targetLabel: r.name as string, outcome: 'ok', detail: { hashPrefix: (r.hash as string).slice(7, 15) } });
    });
    this.d.journal?.(id);
    return this.view(this.d.db.prepare('SELECT * FROM diag_tokens WHERE id = ?').get(id) as Row);
  }

  // A journal replay at start: a restore never brings a revoked token back.
  replay(id: string): void {
    const r = this.d.db.prepare('SELECT revoked_at, name FROM diag_tokens WHERE id = ?').get(id) as Row | undefined;
    if (!r || r.revoked_at !== null) return;
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE diag_tokens SET revoked_at = ?, revoked_by = 'system' WHERE id = ?`).run(this.d.clock.now(), id);
      this.d.audit.write({ actorType: 'system', actor: 'system', action: 'diag-token-revoke', targetType: 'diag-token', targetId: id, targetLabel: r.name as string, outcome: 'ok', detail: { replayed: true } });
    });
  }

  // The token's id when it is live; null otherwise. Looked up by hash only.
  verify(token: string): string | null {
    if (!token.startsWith(DIAG_PREFIX) || token.length > 128) return null;
    const r = this.d.db.prepare('SELECT id, expires_at, revoked_at FROM diag_tokens WHERE hash = ?').get(hashOf(token)) as Row | undefined;
    const now = this.d.clock.now();
    if (!r || r.revoked_at !== null || (r.expires_at as number) <= now) return null;
    this.lastUsed.set(r.id as string, now);
    return r.id as string;
  }
}
