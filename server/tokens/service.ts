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
import { validateCams } from '../contract';

// Managed cams↔proxy tokens (migration spec §10.1–§10.2; plan Task 6). A
// token exists in plain text only in the answer to its issue (shown once);
// cams-admin stores its SHA-256 hash and sends the proxy the full managed set
// (`tokens.apply`, declarative, with a strictly increasing revision). The
// holder in P2 is `manual` (a person puts the token into cams): rotation is
// Issue, switch cams, then Retire or Revoke (R2-10).

export const MAX_TOKENS = 64;
const HASH_PREFIX = 15; // "sha256:" + 8 hex digits
const RESYNC_MS = 5 * 60_000;
interface SetEntry { id: string; kind: string; hash: string; label: string; retireAt: number | null }
const LIVE = `('pending','active','retiring')`;

export type TokenState = 'pending' | 'active' | 'retiring' | 'revoked' | 'external';
export interface ProxyTokenView {
  id: string; proxyId: string; kind: 'client' | 'admin'; holder: string; label: string; hashPrefix: string; state: TokenState;
  retireAt: number | null; revokedAt: number | null; revokedRevision: number | null; onProxy: boolean; createdAt: number; createdBy: string; issuedRevision: number;
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
// ajv's "/hash must match …" → "hash" (the first path segment), else "body".
export const fieldOf = (detail: string): string => detail.split(' ')[0].replace(/^\//, '').split('/')[0] || 'body';

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
  // A proxy whose token revision is ahead of ours (cams-admin restored from
  // an older backup): token changes wait for an admin's confirmation.
  private ahead = new Map<string, number>();
  // The earliest time a heartbeat may re-send the current set (per proxy).
  private resyncAfter = new Map<string, number>();

  constructor(private d: TokensDeps) {
    d.commands.onFinal((r) => {
      if (r.command === 'tokens.apply' && r.proxyId) this.onApplied(r);
    });
  }

  private state(proxyId: string): { revision: number; appliedRevision: number } {
    const r = this.q('SELECT revision, applied_revision FROM proxy_token_state WHERE proxy_id = ?').get(proxyId) as { revision: number; applied_revision: number } | undefined;
    return { revision: r?.revision ?? 0, appliedRevision: r?.applied_revision ?? 0 };
  }

  // The next revision (in the caller's transaction).
  private bump(proxyId: string, atLeast = 0): number {
    const revision = Math.max(this.state(proxyId).revision + 1, atLeast);
    this.q(`INSERT INTO proxy_token_state (proxy_id, revision) VALUES (?, ?) ON CONFLICT(proxy_id) DO UPDATE SET revision = excluded.revision`).run(proxyId, revision);
    return revision;
  }

  private currentSet(proxyId: string): SetEntry[] {
    const rows = this.q(`SELECT id, kind, hash, label, retire_at FROM proxy_tokens WHERE proxy_id = ? AND state IN ${LIVE} ORDER BY created_at, rowid`).all(proxyId) as { id: string; kind: string; hash: string; label: string; retire_at: number | null }[];
    return rows.map((t) => ({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retire_at }));
  }

  // The set the proxy confirmed last (the args of our tokens.apply at appliedRevision).
  private appliedSet(proxyId: string): SetEntry[] {
    const applied = this.state(proxyId).appliedRevision;
    if (applied === 0) return [];
    const r = this.q(`SELECT args FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' AND state = 'done' AND json_extract(args, '$.revision') = ? ORDER BY rowid DESC LIMIT 1`).get(proxyId, applied) as { args: string } | undefined;
    return r ? ((JSON.parse(r.args) as { tokens: SetEntry[] }).tokens ?? []) : [];
  }

  // The current set at our current revision, queued as one tokens.apply.
  // A set that only removes tokens from the one the proxy confirmed goes as
  // revocationOnly (the proxy takes it while paused / not allowed).
  private queue(actor: string, accountId: string, proxyId: string, reason?: string, claim = true): string {
    const tokens = this.currentSet(proxyId);
    const base = claim ? this.appliedSet(proxyId) : [];
    const revocationOnly = claim && tokens.every((t) => base.some((b) => b.id === t.id && b.kind === t.kind && b.hash === t.hash && b.label === t.label && b.retireAt === t.retireAt));
    const args = { v: 1, revision: this.state(proxyId).revision, tokens };
    return this.d.commands.create(actor, accountId, proxyId, 'tokens.apply', args, { ...(reason ? { reason } : {}), ...(revocationOnly ? { revocationOnly: true } : {}) }).id;
  }

  // The full managed set with the next revision. In the caller's
  // transaction: a refused create (409 pre-checks) rolls the change back too.
  private nextApply(actor: string, accountId: string, proxyId: string, reason?: string, atLeast = 0, claim = true): string {
    this.bump(proxyId, atLeast);
    return this.queue(actor, accountId, proxyId, reason, claim);
  }

  // Queues the current set, never throwing: a revocation stands in the
  // database whatever the proxy says now; the heartbeat re-sends it later.
  private tryQueue(actor: string, accountId: string, proxyId: string, reason?: string): void {
    try {
      tx(this.d.db, () => this.queue(actor, accountId, proxyId, reason));
    } catch (e) {
      this.d.log.info({ proxyId, err: (e as Error).message }, 'tokens_apply_not_queued');
    }
  }

  private notAhead(proxyId: string): void {
    if (this.ahead.has(proxyId)) throw new ApiError(409, 'proxy_ahead');
  }

  issue(actor: string, accountId: string, proxyId: string, input: unknown): { token: string; tokenId: string; commandId: string } {
    const { kind, label } = parseIssue(input);
    const px = this.d.registry.getProxy(accountId, proxyId);
    this.notAhead(proxyId);
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
  retire(actor: string, accountId: string, proxyId: string, tokenId: string, hours: unknown, actorType: 'sysadmin' | 'cams' = 'sysadmin'): ProxyTokenView {
    const h = parseHours(hours);
    const t = this.tokenRow(accountId, proxyId, tokenId);
    if (t.state !== 'active') throw new ApiError(409, 'not_active');
    this.notAhead(proxyId);
    const retireAt = this.d.clock.now() + h * 3600_000;
    tx(this.d.db, () => {
      this.q(`UPDATE proxy_tokens SET state = 'retiring', retire_at = ? WHERE id = ?`).run(retireAt, tokenId);
      this.d.audit.write({ actorType, actor, action: 'token-retire', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId, label: t.label, hours: h, retireAt } });
      this.nextApply(actor, accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return this.view(accountId, proxyId, tokenId);
  }

  // Committed whatever the proxy can take now (a leaked admin token could
  // pause the proxy or narrow its allow-list): the token is revoked here at
  // once, the set goes out as a revocation when the proxy takes it, and the
  // view says "not on the proxy" until a set at or above its revision is applied.
  revoke(actor: string, accountId: string, proxyId: string, tokenId: string): ProxyTokenView {
    const t = this.tokenRow(accountId, proxyId, tokenId);
    if (t.state === 'revoked') throw new ApiError(409, 'already_revoked');
    tx(this.d.db, () => {
      const revision = this.bump(proxyId);
      this.q(`UPDATE proxy_tokens SET state = 'revoked', revoked_at = ?, revoked_revision = ? WHERE id = ?`).run(this.d.clock.now(), revision, tokenId);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-revoke', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId, label: t.label, reason: 'revoked', revision } });
    });
    this.tryQueue(actor, accountId, proxyId);
    this.d.live.publishRegistry('proxy', proxyId);
    return this.view(accountId, proxyId, tokenId);
  }

  // --- P4: tokens held by a cams instance (migration spec §10.1, contract cams-v1) ---

  // POST /cams/v1/tokens: cams generated the token and sends only its hash.
  // Idempotent by hash; the proxy must be in an account the instance serves
  // and not hidden for it (else 404, never 403). Label "cams <instance>".
  registerForInstance(inst: { id: string; name: string }, served: string[], input: unknown): { status: 200 | 201; body: { tokenId: string; state: 'pending' | 'active' | 'retiring'; label: string } } {
    const v = validateCams('tokens-request', input);
    if (!v.ok) throw new ApiError(400, 'invalid', fieldOf(v.detail));
    const { proxyId, kind, hash } = input as { proxyId: string; kind: 'client' | 'admin'; hash: string };
    const px = this.d.registry.proxyById(proxyId);
    const hidden = px && this.q('SELECT 1 FROM cams_instance_routes WHERE instance_id = ? AND proxy_id = ? AND hidden = 1').get(inst.id, proxyId);
    if (!px || !served.includes(px.accountId) || hidden) throw new ApiError(404, 'not_found');
    const same = this.q('SELECT id, holder, proxy_id, kind, state, label FROM proxy_tokens WHERE hash = ?').get(hash) as Row | undefined;
    if (same) {
      if (same.holder === inst.id && same.proxy_id === proxyId && same.kind === kind && ['pending', 'active', 'retiring'].includes(same.state as string)) {
        return { status: 200, body: { tokenId: same.id as string, state: same.state as 'pending', label: same.label as string } };
      }
      throw new ApiError(409, 'hash_in_use');
    }
    const pending = this.q(`SELECT id FROM proxy_tokens WHERE holder = ? AND proxy_id = ? AND kind = ? AND state = 'pending'`).get(inst.id, proxyId, kind) as { id: string } | undefined;
    if (pending) throw Object.assign(new ApiError(409, 'pending_exists'), { extra: { tokenId: pending.id } });
    const live = (this.q(`SELECT count(*) n FROM proxy_tokens WHERE proxy_id = ? AND state IN ${LIVE}`).get(proxyId) as { n: number }).n;
    if (live >= MAX_TOKENS) throw new ApiError(409, 'too_many_tokens');
    this.notAhead(proxyId);
    const tokenId = newId('tok');
    const label = `cams ${inst.name}${kind === 'admin' ? ' admin' : ''}`;
    tx(this.d.db, () => {
      const rev = this.state(proxyId).revision + 1;
      this.q(`INSERT INTO proxy_tokens (id, account_id, proxy_id, kind, holder, label, hash, state, issued_revision, created_at, created_by) VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?)`)
        .run(tokenId, px.accountId, proxyId, kind, inst.id, label, hash, rev, this.d.clock.now(), inst.id);
      this.d.audit.write({ actorType: 'cams', actor: inst.id, action: 'token-issue', accountId: px.accountId, targetType: 'proxy', targetId: proxyId, targetLabel: px.name, outcome: 'ok', detail: { tokenId, kind, label, hashPrefix: hash.slice(0, HASH_PREFIX) } });
      this.nextApply(inst.id, px.accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return { status: 201, body: { tokenId, state: 'pending', label } };
  }

  // POST /cams/v1/tokens/:tokenId/retire: only a token this instance holds, in a served account.
  retireForInstance(inst: { id: string }, served: string[], tokenId: string, hours: unknown): { tokenId: string; state: 'retiring'; retireAt: number } {
    const t = this.q('SELECT account_id, proxy_id FROM proxy_tokens WHERE id = ? AND holder = ?').get(tokenId, inst.id) as Row | undefined;
    if (!t || !served.includes(t.account_id as string)) throw new ApiError(404, 'not_found');
    const v = this.retire(inst.id, t.account_id as string, t.proxy_id as string, tokenId, hours, 'cams');
    return { tokenId, state: 'retiring', retireAt: v.retireAt! };
  }

  // R4-19: a blocked or deleted instance's tokens are revoked (one revision
  // and one tokens.apply per proxy); returns the count.
  revokeHeldBy(actor: string, holder: string): number {
    const rows = this.q(`SELECT id, account_id, proxy_id, label FROM proxy_tokens WHERE holder = ? AND state IN ${LIVE} ORDER BY proxy_id`).all(holder) as Row[];
    const byProxy = new Map<string, Row[]>();
    for (const r of rows) byProxy.set(r.proxy_id as string, [...(byProxy.get(r.proxy_id as string) ?? []), r]);
    for (const [proxyId, list] of byProxy) {
      const accountId = list[0].account_id as string;
      tx(this.d.db, () => {
        const revision = this.bump(proxyId);
        for (const t of list) {
          this.q(`UPDATE proxy_tokens SET state = 'revoked', revoked_at = ?, revoked_revision = ? WHERE id = ?`).run(this.d.clock.now(), revision, t.id as string);
          this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-revoke', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId: t.id, label: t.label, reason: 'holder-removed', holder, revision } });
        }
      });
      this.tryQueue(actor, accountId, proxyId);
      this.d.live.publishRegistry('proxy', proxyId);
    }
    return rows.length;
  }

  // After a restore: the proxy is ahead. An admin confirms (having checked
  // the token list); the current set then goes out above the proxy's revision.
  confirmRestore(actor: string, accountId: string, proxyId: string): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    const ahead = this.ahead.get(proxyId);
    if (ahead === undefined) throw new ApiError(409, 'not_ahead');
    let commandId = '';
    tx(this.d.db, () => { commandId = this.nextApply(actor, accountId, proxyId, 'restore-confirmed', ahead + 1, false); });
    this.ahead.delete(proxyId);
    this.d.live.publishRegistry('proxy', proxyId);
    return { commandId };
  }

  // The current set again (after a refused or lost tokens.apply).
  reapply(actor: string, accountId: string, proxyId: string): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    this.notAhead(proxyId);
    let commandId = '';
    tx(this.d.db, () => { commandId = this.nextApply(actor, accountId, proxyId, 'reapply'); });
    return { commandId };
  }

  list(accountId: string, proxyId: string): { revision: number; appliedRevision: number; ahead: number | null; items: ProxyTokenView[] } {
    this.d.registry.getProxy(accountId, proxyId);
    const last = this.lastCommand(proxyId);
    const st = this.state(proxyId);
    const rows = this.q('SELECT * FROM proxy_tokens WHERE account_id = ? AND proxy_id = ? ORDER BY created_at DESC, rowid DESC').all(accountId, proxyId) as Row[];
    return { ...st, ahead: this.ahead.get(proxyId) ?? null, items: rows.map((r) => this.toView(r, last, st.appliedRevision)) };
  }

  private view(accountId: string, proxyId: string, tokenId: string): ProxyTokenView {
    return this.toView(this.tokenRow(accountId, proxyId, tokenId), this.lastCommand(proxyId), this.state(proxyId).appliedRevision);
  }

  private lastCommand(proxyId: string): ProxyTokenView['lastCommand'] {
    const c = this.q(`SELECT id, state, outcome_code FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' ORDER BY rowid DESC LIMIT 1`).get(proxyId) as { id: string; state: string; outcome_code: string | null } | undefined;
    return c ? { id: c.id, state: c.state, outcomeCode: c.outcome_code } : null;
  }

  private toView(r: Row, last: ProxyTokenView['lastCommand'], appliedRevision: number): ProxyTokenView {
    const state = r.state as TokenState;
    const revokedRevision = r.revoked_revision as number | null;
    return {
      revokedRevision,
      // Is the proxy's set as this row says? A revoked token: once a set at or
      // above its revocation was applied; a pending one: not yet.
      onProxy: state === 'revoked' ? revokedRevision === null || appliedRevision >= revokedRevision : state !== 'pending',
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
      // The proxy has this revision or a newer one, which we didn't send it:
      // cams-admin was restored from an older backup. Token changes wait for
      // an admin's confirmation (confirmRestore); a stale answer below our
      // revision is a set that a newer one already replaced.
      if (revision >= this.state(proxyId).revision) {
        this.ahead.set(proxyId, revision);
        this.d.live.publishRegistry('proxy', proxyId);
      }
      return;
    }
    if (res.applied === true) this.confirm(proxyId, revision);
  }

  // Everything issued up to `revision` is on the proxy. Writes only when it
  // confirms something new; never touches a revoked row.
  private confirm(proxyId: string, revision: number): void {
    this.ahead.delete(proxyId);
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
    if (t.revision > st.revision) {
      if (this.ahead.get(proxyId) !== t.revision) {
        this.ahead.set(proxyId, t.revision);
        this.d.live.publishRegistry('proxy', proxyId);
      }
      return;
    }
    if (t.revision < st.revision) return this.resync(proxyId, t.revision);
    if (t.revision <= st.appliedRevision) return;
    const sent = this.q(`SELECT 1 FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' AND attempts > 0 AND json_extract(args, '$.revision') = ? AND state NOT IN ('refused','failed')`).get(proxyId, t.revision);
    if (sent) this.confirm(proxyId, t.revision);
  }

  // A live proxy below our revision with no tokens.apply on its way (it
  // expired while the proxy was away, or the proxy refused it): send the
  // current set again. At most every RESYNC_MS per proxy, and never before a
  // refusal's retryAfterS has passed.
  private resync(proxyId: string, proxyRevision: number): void {
    if (this.ahead.has(proxyId)) return;
    const now = this.d.clock.now();
    if (now < (this.resyncAfter.get(proxyId) ?? 0)) return;
    const open = this.q(`SELECT 1 FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' AND state IN ('queued','sent','received') LIMIT 1`).get(proxyId);
    if (open) return;
    const last = this.q(`SELECT state, outcome_code, finished_at, result, revocation_only FROM commands WHERE proxy_id = ? AND command = 'tokens.apply' ORDER BY rowid DESC LIMIT 1`).get(proxyId) as { state: string; outcome_code: string | null; finished_at: number | null; result: string | null; revocation_only: number } | undefined;
    if (last?.state === 'refused' && last.outcome_code === 'rate_limited') {
      const after = (JSON.parse(last.result ?? '{}') as { body?: { retryAfterS?: unknown } }).body?.retryAfterS;
      const until = (last.finished_at ?? now) + (Number.isSafeInteger(after) ? (after as number) : 60) * 1000;
      if (now < until) return void this.resyncAfter.set(proxyId, until);
    }
    const px = this.d.registry.proxyById(proxyId);
    if (!px) return;
    // A refused claim (the proxy's set differs) goes without it next time.
    const claim = !(last?.state === 'refused' && last.outcome_code === 'invalid_args' && last.revocation_only === 1);
    try {
      tx(this.d.db, () => this.queue('system', px.accountId, proxyId, 'resync', claim));
      // Queued: the next one no sooner than RESYNC_MS. A pre-check refusal
      // (the proxy is off or can't take it now) costs no write and is tried
      // again on the next heartbeat.
      this.resyncAfter.set(proxyId, now + RESYNC_MS);
      this.d.log.info({ proxyId, proxyRevision, revision: this.state(proxyId).revision }, 'tokens_resync');
    } catch (e) {
      this.d.log.debug({ proxyId, err: (e as Error).message }, 'tokens_resync_not_queued');
    }
  }

  // Retiring tokens past retireAt become revoked, with one cleanup set per proxy.
  tick(): void {
    const now = this.d.clock.now();
    const due = this.q(`SELECT * FROM proxy_tokens WHERE state = 'retiring' AND retire_at <= ?`).all(now) as Row[];
    if (!due.length) return;
    const proxies = new Map<string, string>();
    tx(this.d.db, () => {
      const revisions = new Map<string, number>();
      for (const t of due) {
        const proxyId = t.proxy_id as string;
        if (!revisions.has(proxyId)) revisions.set(proxyId, this.bump(proxyId));
        this.q(`UPDATE proxy_tokens SET state = 'revoked', revoked_at = ?, revoked_revision = ? WHERE id = ?`).run(now, revisions.get(proxyId)!, t.id as string);
        this.d.audit.write({ actorType: 'system', actor: 'system', action: 'token-revoke', accountId: t.account_id as string, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId: t.id, label: t.label, reason: 'retired' } });
        proxies.set(proxyId, t.account_id as string);
      }
    });
    // The proxy itself already stopped accepting the token at retireAt.
    for (const [proxyId, accountId] of proxies) {
      this.tryQueue('system', accountId, proxyId, 'retired');
      this.d.live.publishRegistry('proxy', proxyId);
    }
  }
}
