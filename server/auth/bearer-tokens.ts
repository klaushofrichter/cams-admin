import { createHash, randomBytes } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError } from '../registry';
import { FieldError } from '../validate';
import { newId, type IdPrefix } from '../ids';

// The store behind the diagnostics tokens (issue #45) and the operations
// tokens. A sysadmin issues one, sees it once; only its SHA-256 hash is
// stored. Verifying never writes the database: the last use lives in memory
// (the write budget). A subclass adds columns through parseExtra/viewExtra.

export interface BearerConfig {
  table: string; prefix: string; idPrefix: IdPrefix; auditPrefix: 'diag-token' | 'ops-token';
  defaultDays: number; maxDays: number; maxLive: number;
}
export interface BearerView {
  id: string; name: string; hashPrefix: string; createdAt: number; createdBy: string; expiresAt: number;
  revokedAt: number | null; revokedBy: string | null; lastUsedAt: number | null; state: 'active' | 'expired' | 'revoked';
}
export type Row = Record<string, unknown>;
export interface BearerDeps { db: Db; clock: Clock; audit: Audit; journal?: (tokenId: string) => void }

const DAY = 86400_000;

export const hashOf = (token: string) => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;

// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

export class BearerTokens<V extends BearerView = BearerView> {
  private lastUsed = new Map<string, number>();
  constructor(protected d: BearerDeps, protected cfg: BearerConfig) {}

  // Extra columns of a subclass: parsed from the input (a FieldError on bad
  // input), written with the row, and shown in the view. Column names come
  // from code, never from input.
  protected parseExtra(_o: Record<string, unknown>): { cols: Record<string, string | number>; detail: Record<string, unknown> } {
    return { cols: {}, detail: {} };
  }
  protected viewExtra(_r: Row): Record<string, unknown> { return {}; }

  protected view(r: Row): V {
    const now = this.d.clock.now();
    const id = r.id as string;
    const revokedAt = r.revoked_at as number | null;
    const expiresAt = r.expires_at as number;
    return {
      id, name: r.name as string, hashPrefix: (r.hash as string).slice(7, 15), createdAt: r.created_at as number, createdBy: r.created_by as string,
      expiresAt, revokedAt, revokedBy: r.revoked_by as string | null, lastUsedAt: this.lastUsed.get(id) ?? null,
      state: revokedAt !== null ? 'revoked' : expiresAt <= now ? 'expired' : 'active',
      ...this.viewExtra(r),
    } as V;
  }

  list(): { items: V[] } {
    return { items: (this.d.db.prepare(`SELECT * FROM ${this.cfg.table} ORDER BY created_at DESC`).all() as Row[]).map((r) => this.view(r)) };
  }

  issue(actor: string, input: unknown): { token: string; item: V } {
    const { table, prefix, auditPrefix } = this.cfg;
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!NAME_RE.test(name)) throw new FieldError('name');
    const days = o.days === undefined ? this.cfg.defaultDays : o.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > this.cfg.maxDays) throw new FieldError('days');
    const extra = this.parseExtra(o);
    const now = this.d.clock.now();
    const token = prefix + randomBytes(32).toString('base64url');
    const hash = hashOf(token);
    const id = newId(this.cfg.idPrefix);
    const cols = ['id', 'name', 'hash', 'created_at', 'created_by', 'expires_at', ...Object.keys(extra.cols)];
    tx(this.d.db, () => {
      const live = (this.d.db.prepare(`SELECT count(*) n FROM ${table} WHERE revoked_at IS NULL AND expires_at > ?`).get(now) as { n: number }).n;
      if (live >= this.cfg.maxLive) throw new ApiError(409, 'too_many_tokens');
      this.d.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(id, name, hash, now, actor, now + days * DAY, ...Object.values(extra.cols));
      this.d.audit.write({ actorType: 'sysadmin', actor, action: `${auditPrefix}-issue`, targetType: auditPrefix, targetId: id, targetLabel: name, outcome: 'ok', detail: { hashPrefix: hash.slice(7, 15), days, ...extra.detail } });
    });
    return { token, item: this.view(this.d.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row) };
  }

  revoke(actor: string, id: string): V {
    const { table, auditPrefix } = this.cfg;
    const now = this.d.clock.now();
    const r = this.d.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    if (r.revoked_at !== null) return this.view(r);
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE ${table} SET revoked_at = ?, revoked_by = ? WHERE id = ?`).run(now, actor, id);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: `${auditPrefix}-revoke`, targetType: auditPrefix, targetId: id, targetLabel: r.name as string, outcome: 'ok', detail: { hashPrefix: (r.hash as string).slice(7, 15) } });
    });
    this.d.journal?.(id);
    return this.view(this.d.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row);
  }

  // A journal replay at start: a restore never brings a revoked token back.
  replay(id: string): void {
    const { table, auditPrefix } = this.cfg;
    const r = this.d.db.prepare(`SELECT revoked_at, name FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    if (!r || r.revoked_at !== null) return;
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE ${table} SET revoked_at = ?, revoked_by = 'system' WHERE id = ?`).run(this.d.clock.now(), id);
      this.d.audit.write({ actorType: 'system', actor: 'system', action: `${auditPrefix}-revoke`, targetType: auditPrefix, targetId: id, targetLabel: r.name as string, outcome: 'ok', detail: { replayed: true } });
    });
  }

  // The live row of a token, or null. Looked up by hash only.
  protected find(token: string): Row | null {
    if (!token.startsWith(this.cfg.prefix) || token.length > 128) return null;
    const r = this.d.db.prepare(`SELECT * FROM ${this.cfg.table} WHERE hash = ?`).get(hashOf(token)) as Row | undefined;
    const now = this.d.clock.now();
    if (!r || r.revoked_at !== null || (r.expires_at as number) <= now) return null;
    this.lastUsed.set(r.id as string, now);
    return r;
  }

  // The token's id when it is live; null otherwise.
  verify(token: string): string | null {
    return (this.find(token)?.id as string | undefined) ?? null;
  }
}
