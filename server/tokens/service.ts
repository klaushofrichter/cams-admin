import type { StatementSync } from 'node:sqlite';
import { createHash, randomBytes } from 'crypto';
import type { Clock } from '../clock';
import { tx, type Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import { FieldError } from '../validate';
import { newId } from '../ids';
import type { CommandRow, Commands } from '../commands/service';

// Managed cams↔proxy tokens (migration spec §10.1–§10.2; plan Task 6). A
// token exists in plain text only in the answer to its issue (shown once);
// cams-admin stores its SHA-256 hash and sends the proxy the full managed set
// (`tokens.apply`, declarative, with a strictly increasing revision). The
// holder in P2 is `manual` (a person puts the token into cams): rotation is
// Issue, switch cams, then Retire or Revoke (R2-10).

export const MAX_TOKENS = 64;
const HASH_PREFIX = 15; // "sha256:" + 8 hex digits
const BUMP_EVERY_MS = 600_000;
const LIVE = `('pending','active','retiring')`;

export type TokenState = 'pending' | 'active' | 'retiring' | 'revoked' | 'external';
export interface ProxyTokenView {
  id: string; proxyId: string; kind: 'client' | 'admin'; holder: string; label: string; hashPrefix: string; state: TokenState;
  retireAt: number | null; revokedAt: number | null; createdAt: number; createdBy: string; issuedRevision: number;
  lastCommand: { id: string; state: string; outcomeCode: string | null } | null;
}
export interface TokensDeps { db: Db; clock: Clock; audit: Audit; registry: Registry; commands: Commands; live: LiveHub; log: Logger }

// 32 random bytes, base64url without padding (43 characters).
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}` };
}

// eslint-disable-next-line no-control-regex
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
function parseIssue(input: unknown): { kind: 'client' | 'admin'; label: string } {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (o.kind !== 'client' && o.kind !== 'admin') throw new FieldError('kind');
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!LABEL_RE.test(label)) throw new FieldError('label');
  return { kind: o.kind, label };
}
function parseHours(h: unknown): number {
  if (h === undefined || h === null) return 24;
  if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 168) throw new FieldError('hours');
  return h;
}

type Row = Record<string, unknown>;

export class Tokens {
  // Prepared once: the tick and heartbeat paths run every second (each
  // prepare holds native memory until a GC).
  private stmts = new Map<string, StatementSync>();
  private q(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.d.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }
  private bumpedAt = new Map<string, number>();

  constructor(private d: TokensDeps) {
    d.commands.onFinal((r) => {
      if (r.command === 'tokens.apply' && r.proxyId) this.onApplied(r);
    });
  }

  private state(proxyId: string): { revision: number; appliedRevision: number } {
    const r = this.q('SELECT revision, applied_revision FROM proxy_token_state WHERE proxy_id = ?').get(proxyId) as { revision: number; applied_revision: number } | undefined;
    return { revision: r?.revision ?? 0, appliedRevision: r?.applied_revision ?? 0 };
  }

  // The full managed set as the proxy should have it, with the next revision,
  // queued as one tokens.apply. In the caller's transaction: a refused
  // create (409 pre-checks) rolls the caller's change back too.
  private nextApply(actor: string, accountId: string, proxyId: string, reason?: string, atLeast = 0): string {
    const revision = Math.max(this.state(proxyId).revision + 1, atLeast);
    this.q(`INSERT INTO proxy_token_state (proxy_id, revision) VALUES (?, ?) ON CONFLICT(proxy_id) DO UPDATE SET revision = excluded.revision`).run(proxyId, revision);
    const rows = this.q(`SELECT id, kind, hash, label, retire_at FROM proxy_tokens WHERE proxy_id = ? AND state IN ${LIVE} ORDER BY created_at, rowid`).all(proxyId) as { id: string; kind: string; hash: string; label: string; retire_at: number | null }[];
    const args = { v: 1, revision, tokens: rows.map((t) => ({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retire_at })) };
    return this.d.commands.create(actor, accountId, proxyId, 'tokens.apply', args, reason ? { reason } : undefined).id;
  }

  issue(actor: string, accountId: string, proxyId: string, input: unknown): { token: string; tokenId: string; commandId: string } {
    const { kind, label } = parseIssue(input);
    const px = this.d.registry.getProxy(accountId, proxyId);
    const live = (this.q(`SELECT count(*) n FROM proxy_tokens WHERE proxy_id = ? AND state IN ${LIVE}`).get(proxyId) as { n: number }).n;
    if (live >= MAX_TOKENS) throw new ApiError(409, 'too_many_tokens');
    const { token, hash } = generateToken();
    const tokenId = newId('tok');
    let commandId = '';
    tx(this.d.db, () => {
      const rev = this.state(proxyId).revision + 1;
      this.q(`INSERT INTO proxy_tokens (id, account_id, proxy_id, kind, holder, label, hash, state, issued_revision, created_at, created_by) VALUES (?,?,?,?, 'manual', ?,?, 'pending', ?,?,?)`)
        .run(tokenId, accountId, proxyId, kind, label, hash, rev, this.d.clock.now(), actor);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-issue', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: px.name, outcome: 'ok', detail: { tokenId, kind, label, hashPrefix: hash.slice(0, HASH_PREFIX) } });
      commandId = this.nextApply(actor, accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return { token, tokenId, commandId };
  }

  private tokenRow(accountId: string, proxyId: string, tokenId: string): Row {
    this.d.registry.getProxy(accountId, proxyId);
    const r = this.q('SELECT * FROM proxy_tokens WHERE id = ? AND account_id = ? AND proxy_id = ?').get(tokenId, accountId, proxyId) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    return r;
  }

  // Retiring: the proxy itself stops accepting it at retireAt (even with
  // cams-admin down); cams-admin marks it revoked then and cleans the set up.
  retire(actor: string, accountId: string, proxyId: string, tokenId: string, hours: unknown): ProxyTokenView {
    const h = parseHours(hours);
    const t = this.tokenRow(accountId, proxyId, tokenId);
    if (t.state !== 'active') throw new ApiError(409, 'not_active');
    const retireAt = this.d.clock.now() + h * 3600_000;
    tx(this.d.db, () => {
      this.q(`UPDATE proxy_tokens SET state = 'retiring', retire_at = ? WHERE id = ?`).run(retireAt, tokenId);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-retire', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId, label: t.label, hours: h, retireAt } });
      this.nextApply(actor, accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return this.view(accountId, proxyId, tokenId);
  }

  revoke(actor: string, accountId: string, proxyId: string, tokenId: string): ProxyTokenView {
    const t = this.tokenRow(accountId, proxyId, tokenId);
    if (t.state === 'revoked') throw new ApiError(409, 'already_revoked');
    tx(this.d.db, () => {
      this.q(`UPDATE proxy_tokens SET state = 'revoked', revoked_at = ? WHERE id = ?`).run(this.d.clock.now(), tokenId);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-revoke', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId, label: t.label, reason: 'revoked' } });
      this.nextApply(actor, accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return this.view(accountId, proxyId, tokenId);
  }

  // The current set again (after a refused or lost tokens.apply).
  reapply(actor: string, accountId: string, proxyId: string): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    let commandId = '';
    tx(this.d.db, () => { commandId = this.nextApply(actor, accountId, proxyId, 'reapply'); });
    return { commandId };
  }

  list(accountId: string, proxyId: string): { revision: number; appliedRevision: number; items: ProxyTokenView[] } {
    this.d.registry.getProxy(accountId, proxyId);
    const last = this.lastCommand(proxyId);
    const rows = this.q('SELECT * FROM proxy_tokens WHERE account_id = ? AND proxy_id = ? ORDER BY created_at DESC, rowid DESC').all(accountId, proxyId) as Row[];
    return { ...this.state(proxyId), items: rows.map((r) => this.toView(r, last)) };
  }

  private view(accountId: string, proxyId: string, tokenId: string): ProxyTokenView {
    return this.toView(this.tokenRow(accountId, proxyId, tokenId), this.lastCommand(proxyId));
  }

  private lastCommand(proxyId: string): ProxyTokenView['lastCommand'] {
    const c = this.q(`SELECT id, state, outcome_code FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' ORDER BY rowid DESC LIMIT 1`).get(proxyId) as { id: string; state: string; outcome_code: string | null } | undefined;
    return c ? { id: c.id, state: c.state, outcomeCode: c.outcome_code } : null;
  }

  private toView(r: Row, last: ProxyTokenView['lastCommand']): ProxyTokenView {
    return {
      id: r.id as string, proxyId: r.proxy_id as string, kind: r.kind as 'client' | 'admin', holder: r.holder as string, label: r.label as string,
      hashPrefix: (r.hash as string).slice(0, HASH_PREFIX), state: r.state as TokenState, retireAt: r.retire_at as number | null, revokedAt: r.revoked_at as number | null,
      createdAt: r.created_at as number, createdBy: r.created_by as string, issuedRevision: r.issued_revision as number, lastCommand: last,
    };
  }

  private onApplied(r: CommandRow): void {
    const res = r.result as { revision?: unknown; applied?: unknown; stale?: unknown } | null;
    // refused/failed/expired/unknown: the tokens stay pending; the UI shows r's outcome.
    if (r.state !== 'done' || !res || !Number.isSafeInteger(res.revision)) return;
    const proxyId = r.proxyId!;
    const revision = res.revision as number;
    if (res.stale === true) {
      // R2-11: the proxy is ahead (cams-admin was restored from an older
      // backup): jump above it and send the set again, at most once per 10 min.
      // A stale answer below our revision: a newer set is on its way.
      if (revision < this.state(proxyId).revision) return;
      const last = this.bumpedAt.get(proxyId) ?? -Infinity;
      if (this.d.clock.now() - last < BUMP_EVERY_MS) return;
      this.bumpedAt.set(proxyId, this.d.clock.now());
      try {
        tx(this.d.db, () => this.nextApply('system', r.accountId, proxyId, 'stale-revision', revision + 1));
      } catch (e) {
        this.d.log.warn({ proxyId, err: (e as Error).message }, 'tokens_stale_reapply_refused');
      }
      return;
    }
    if (res.applied === true) this.confirm(proxyId, revision);
  }

  // Everything issued up to `revision` is on the proxy. Writes only when it
  // confirms something new; never touches a revoked row.
  private confirm(proxyId: string, revision: number): void {
    const st = this.state(proxyId);
    if (revision > st.revision || revision <= st.appliedRevision) return;
    tx(this.d.db, () => {
      this.q(`UPDATE proxy_tokens SET state = 'active', applied_revision = ? WHERE proxy_id = ? AND state = 'pending' AND issued_revision <= ?`).run(revision, proxyId, revision);
      this.q(`UPDATE proxy_token_state SET applied_revision = ? WHERE proxy_id = ?`).run(revision, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
  }

  // A heartbeat's tokens.revision confirms a set whose done was lost — only a
  // revision a tokens.apply of ours actually carried to the proxy (after a
  // restore the proxy's revision n may be another set than our n).
  onHeartbeat(proxyId: string, t: { revision: number } | null | undefined): void {
    if (!t || !Number.isSafeInteger(t.revision)) return;
    const st = this.state(proxyId);
    if (t.revision > st.revision || t.revision <= st.appliedRevision) return;
    const sent = this.q(`SELECT 1 FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' AND attempts > 0 AND json_extract(args, '$.revision') = ? AND state NOT IN ('refused','failed')`).get(proxyId, t.revision);
    if (sent) this.confirm(proxyId, t.revision);
  }

  // Retiring tokens past retireAt become revoked, with one cleanup set per proxy.
  tick(): void {
    const now = this.d.clock.now();
    const due = this.q(`SELECT * FROM proxy_tokens WHERE state = 'retiring' AND retire_at <= ?`).all(now) as Row[];
    if (!due.length) return;
    const proxies = new Map<string, string>();
    tx(this.d.db, () => {
      for (const t of due) {
        this.q(`UPDATE proxy_tokens SET state = 'revoked', revoked_at = ? WHERE id = ?`).run(now, t.id as string);
        this.d.audit.write({ actorType: 'system', actor: 'system', action: 'token-revoke', accountId: t.account_id as string, targetType: 'proxy', targetId: t.proxy_id as string, outcome: 'ok', detail: { tokenId: t.id, label: t.label, reason: 'retired' } });
        proxies.set(t.proxy_id as string, t.account_id as string);
      }
    });
    for (const [proxyId, accountId] of proxies) {
      try {
        tx(this.d.db, () => this.nextApply('system', accountId, proxyId, 'retired'));
      } catch (e) {
        // The proxy already stopped accepting the token at retireAt.
        this.d.log.info({ proxyId, err: (e as Error).message }, 'tokens_cleanup_not_sent');
      }
      this.d.live.publishRegistry('proxy', proxyId);
    }
  }
}
