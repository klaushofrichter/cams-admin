import type { Clock } from '../clock';
import type { Audit, AuditAction } from '../audit';
import { tx, type Db } from '../db/open';
import { newId } from '../ids';
import { ApiError } from '../registry';
import { newViewerToken, openToken, sealToken, viewerBase, viewerFingerprint, viewerLink, type ViewerKey } from './crypto';

// Viewer tokens (design 2026-11-05-viewer-tokens-design.md): sign people in
// to the cams viewers as viewers of one or more accounts. Kept readable
// (encrypted) so "Copy" works any time; the viewers get the fingerprint in
// their snapshot. Each write is one transaction with one audit record, and
// the triggers of migration 20 bump the accounts' config revision.

export const VIEWER_DAYS = [1, 7, 30, 90, 365] as const;
export const DEFAULT_DAYS = 7;
export const MAX_PER_ACCOUNT = 50;
export const MAX_ACCOUNTS = 64;
const DAY = 86400_000;
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const ACC_RE = /^acc_[0-9A-HJKMNP-TV-Z]{20}$/;
export const COPY_WHAT = ['token', 'link', 'qr'] as const;
export type CopyWhat = (typeof COPY_WHAT)[number];
// A token's role in each of its accounts (spec 2026-11-08 A4): a viewer, or an admin of the account in cams.
export const VIEWER_TOKEN_ROLES = ['viewer', 'admin'] as const;
export type ViewerTokenRole = (typeof VIEWER_TOKEN_ROLES)[number];
function roleOf(v: unknown, dflt?: ViewerTokenRole): ViewerTokenRole {
  const r = v === undefined ? dflt : v;
  if (typeof r !== 'string' || !(VIEWER_TOKEN_ROLES as readonly string[]).includes(r)) throw new ApiError(400, 'invalid', 'role');
  return r as ViewerTokenRole;
}

export interface ViewerTokenView {
  id: string; name: string; accounts: { id: string; name: string; displayName: string }[]; days: number;
  createdAt: number; createdBy: string; expiresAt: number; revokedAt: number | null; revokedBy: string | null;
  lastUsedAt: number | null; state: 'valid' | 'expired' | 'revoked'; fingerprintPrefix: string; version: number; role: ViewerTokenRole;
}
// The revocation journal's entries (outside the database and its backups).
export type ViewerTokenJournal =
  | { kind: 'viewer-token'; tokenId: string; change: 'revoked' | 'deleted' }
  | { kind: 'viewer-token'; tokenId: string; change: 'expires'; expiresAt: number };
// A sign-in link per viewer that can sign the token in (finding 19): the main one first.
export interface ViewerLink { instanceId: string | null; name: string; base: string; link: string }
export const MAIN_VIEWER_NAME = 'Main viewer';
export interface ViewerTokenDeps { db: Db; clock: Clock; audit: Audit; key: ViewerKey | null; linkBase: string; journal?: (e: ViewerTokenJournal) => void }

type Row = Record<string, unknown>;
const invalid = (field: string) => new ApiError(400, 'invalid', field);
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});

function daysOf(v: unknown, dflt?: number): number {
  const d = v === undefined ? dflt : v;
  if (typeof d !== 'number' || !(VIEWER_DAYS as readonly number[]).includes(d)) throw invalid('days');
  return d;
}

function accountIdsOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ACCOUNTS || new Set(v).size !== v.length || !v.every((x) => typeof x === 'string' && ACC_RE.test(x))) throw invalid('accountIds');
  return [...(v as string[])].sort();
}

// Who may give a token these accounts. cams-admin signs in system admins
// only today (ALLOWED_EMAILS), and they may manage every account; an account
// admin sign-in (Open for Klaus 1) would check its own accounts here.
export const canManage = (_actor: string, _accountIds: string[]): boolean => true;

export class ViewerTokens {
  // tokenId → the newest use a viewer reported. In memory; written only with the
  // status store's 10-minute snapshot (flushLastUsed), read back at start.
  private lastUsed = new Map<string, number>();
  private usedDirty = new Set<string>();
  constructor(private d: ViewerTokenDeps) {
    for (const r of d.db.prepare('SELECT id, last_used_at FROM viewer_tokens WHERE last_used_at IS NOT NULL').all() as Row[]) this.lastUsed.set(r.id as string, r.last_used_at as number);
  }

  // The status snapshot's part: is there a new use to save, and save it (inside the snapshot's transaction).
  lastUsedPending(): boolean { return this.usedDirty.size > 0; }
  flushLastUsed(): void {
    const up = this.d.db.prepare('UPDATE viewer_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)');
    for (const id of this.usedDirty) {
      const at = this.lastUsed.get(id);
      if (at !== undefined) up.run(at, id, at);
    }
    this.usedDirty.clear();
  }

  configured(): boolean { return this.d.key !== null; }

  private key(): ViewerKey {
    if (!this.d.key) throw new ApiError(503, 'viewer_tokens_unconfigured');
    return this.d.key;
  }

  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM viewer_tokens WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    return r;
  }

  private accountsOf(id: string): ViewerTokenView['accounts'] {
    return (this.d.db.prepare(`SELECT a.id, a.name, a.display_name FROM viewer_token_accounts v JOIN accounts a ON a.id = v.account_id
      WHERE v.token_id = ? ORDER BY a.name`).all(id) as Row[]).map((a) => ({ id: a.id as string, name: a.name as string, displayName: a.display_name as string }));
  }

  private view(r: Row): ViewerTokenView {
    const id = r.id as string;
    const expiresAt = r.expires_at as number;
    return {
      id, name: r.name as string, accounts: this.accountsOf(id), days: r.days as number, createdAt: r.created_at as number, createdBy: r.created_by as string,
      expiresAt, revokedAt: r.revoked_at as number | null, revokedBy: r.revoked_by as string | null, lastUsedAt: this.lastUsed.get(id) ?? null,
      state: r.revoked_at !== null ? 'revoked' : expiresAt <= this.d.clock.now() ? 'expired' : 'valid',
      fingerprintPrefix: (r.fingerprint as string).slice(7, 15), version: r.version as number, role: (r.role as ViewerTokenRole | undefined) ?? 'viewer',
    };
  }

  get(id: string): ViewerTokenView { return this.view(this.row(id)); }

  // The tokens that include this account (all without one), newest first.
  list(accountId?: string): { items: ViewerTokenView[] } {
    const rows = accountId === undefined
      ? this.d.db.prepare('SELECT * FROM viewer_tokens ORDER BY created_at DESC, id').all() as Row[]
      : this.d.db.prepare(`SELECT t.* FROM viewer_tokens t JOIN viewer_token_accounts v ON v.token_id = t.id WHERE v.account_id = ? ORDER BY t.created_at DESC, t.id`).all(accountId) as Row[];
    return { items: rows.map((r) => this.view(r)) };
  }

  private log(actor: string, action: AuditAction, r: Row, accountIds: string[], detail: Record<string, unknown>): void {
    this.d.audit.write({
      actorType: actor.startsWith('ops-token:') ? 'system' : 'sysadmin', actor, action, accountId: accountIds.length === 1 ? accountIds[0] : null,
      targetType: 'viewer-token', targetId: r.id as string, targetLabel: r.name as string, outcome: 'ok',
      detail: { fingerprintPrefix: (r.fingerprint as string).slice(7, 15), ...(accountIds.length !== 1 ? { accountIds } : {}), ...detail },
    });
  }

  private accountIdsOfToken(id: string): string[] {
    return (this.d.db.prepare('SELECT account_id FROM viewer_token_accounts WHERE token_id = ? ORDER BY account_id').all(id) as Row[]).map((x) => x.account_id as string);
  }

  // Every account must exist, may be managed by the actor, and have room for one more valid token (other than this one).
  private checkAccounts(actor: string, accountIds: string[], self: string | null): void {
    const now = this.d.clock.now();
    for (const acc of accountIds) {
      if (!this.d.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(acc)) throw new ApiError(404, 'not_found');
      const n = (this.d.db.prepare(`SELECT count(*) n FROM viewer_tokens t JOIN viewer_token_accounts v ON v.token_id = t.id
        WHERE v.account_id = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND t.id IS NOT ?`).get(acc, now, self) as { n: number }).n;
      if (n >= MAX_PER_ACCOUNT) throw new ApiError(409, 'too_many_tokens');
    }
    if (!canManage(actor, accountIds)) throw new ApiError(403, 'forbidden');
  }

  // The viewers that can sign this token in (finding 19), built here from the registry, never from a request:
  // the main viewer (linkBase) first, named by its record if one has that base; then every enrolled cams
  // instance with an http(s) base URL that serves at least one of the token's accounts, by name, one per base.
  private viewers(id: string): Omit<ViewerLink, 'link'>[] {
    const rows = this.d.db.prepare(`SELECT i.id, i.name, i.display_name, i.base_url,
        EXISTS (SELECT 1 FROM cams_instance_accounts s JOIN viewer_token_accounts v ON v.account_id = s.account_id WHERE s.instance_id = i.id AND v.token_id = ?) AS serves
      FROM cams_instances i WHERE i.state = 'enrolled' AND i.base_url IS NOT NULL ORDER BY i.name`).all(id) as Row[];
    const named = (r: Row) => ((r.display_name as string) || (r.name as string));
    const main = rows.find((r) => viewerBase(r.base_url as string) === this.d.linkBase);
    const out: Omit<ViewerLink, 'link'>[] = [{ instanceId: main ? (main.id as string) : null, name: main ? named(main) : MAIN_VIEWER_NAME, base: this.d.linkBase }];
    for (const r of rows) {
      const base = viewerBase(r.base_url as string);
      if (base && r.serves && !out.some((x) => x.base === base)) out.push({ instanceId: r.id as string, name: named(r), base });
    }
    return out;
  }

  private links(id: string, token: string): ViewerLink[] {
    return this.viewers(id).map((v) => ({ ...v, link: viewerLink(v.base, token) }));
  }

  create(actor: string, input: unknown): { item: ViewerTokenView; token: string; link: string; links: ViewerLink[] } {
    const o = obj(input);
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!NAME_RE.test(name)) throw invalid('name');
    const days = daysOf(o.days, DEFAULT_DAYS);
    const accountIds = accountIdsOf(o.accountIds);
    const role = roleOf(o.role, 'viewer');
    const key = this.key();
    const now = this.d.clock.now();
    const id = newId('vtk');
    const token = newViewerToken();
    tx(this.d.db, () => {
      this.checkAccounts(actor, accountIds, null);
      this.d.db.prepare(`INSERT INTO viewer_tokens (id, name, fingerprint, secret, days, created_at, created_by, updated_at, expires_at, role) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, name, viewerFingerprint(token), sealToken(key, id, token), days, now, actor, now, now + days * DAY, role);
      for (const acc of accountIds) this.d.db.prepare('INSERT INTO viewer_token_accounts (token_id, account_id) VALUES (?, ?)').run(id, acc);
      this.log(actor, 'viewer-token-create', this.row(id), accountIds, { days, expiresAt: now + days * DAY, role });
    });
    const links = this.links(id, token);
    return { item: this.get(id), token, link: links[0].link, links };
  }

  // The token itself, for Copy, Copy link and the QR window: audited (with the viewers offered), never logged.
  reveal(actor: string, id: string, what: CopyWhat): { token: string; link: string; links: ViewerLink[] } {
    if (!(COPY_WHAT as readonly unknown[]).includes(what)) throw invalid('what');
    const key = this.key();
    const r = this.row(id);
    const token = openToken(key, id, r.secret as string);
    if (token === null) throw new ApiError(409, 'token_unreadable');
    const links = this.links(id, token);
    this.log(actor, 'viewer-token-copy', r, this.accountIdsOfToken(id), { what, viewers: links.map((l) => l.instanceId) });
    return { token, link: links[0].link, links };
  }

  // Valid for `days` from now: longer or shorter, and again after a revoke or an expiry (the same token).
  setValidity(actor: string, id: string, input: unknown): ViewerTokenView {
    const days = daysOf(obj(input).days);
    const now = this.d.clock.now();
    const expiresAt = now + days * DAY;
    tx(this.d.db, () => {
      const r = this.row(id);
      const accountIds = this.accountIdsOfToken(id);
      // Making it valid again needs room in each account.
      if (r.revoked_at !== null || (r.expires_at as number) <= now) this.checkAccounts(actor, accountIds, id);
      this.d.db.prepare('UPDATE viewer_tokens SET days = ?, expires_at = ?, revoked_at = NULL, revoked_by = NULL, updated_at = ?, version = version + 1 WHERE id = ?').run(days, expiresAt, now, id);
      this.log(actor, 'viewer-token-validity', r, accountIds, { days, expiresAt, ...(r.revoked_at !== null ? { wasRevoked: true } : {}) });
    });
    this.d.journal?.({ kind: 'viewer-token', tokenId: id, change: 'expires', expiresAt });
    return this.get(id);
  }

  // Viewer or admin in each of its accounts (A4): the snapshot carries it, so the accounts' revision moves (trigger).
  setRole(actor: string, id: string, input: unknown): ViewerTokenView {
    const role = roleOf(obj(input).role);
    tx(this.d.db, () => {
      const r = this.row(id);
      const from = (r.role as ViewerTokenRole | undefined) ?? 'viewer';
      if (from === role) return;
      const accountIds = this.accountIdsOfToken(id);
      if (!canManage(actor, accountIds)) throw new ApiError(403, 'forbidden');
      this.d.db.prepare('UPDATE viewer_tokens SET role = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(role, this.d.clock.now(), id);
      this.log(actor, 'viewer-token-role', r, accountIds, { role, from });
    });
    return this.get(id);
  }

  revoke(actor: string, id: string): ViewerTokenView {
    const now = this.d.clock.now();
    const r = this.row(id);
    if (r.revoked_at !== null) return this.view(r);
    tx(this.d.db, () => {
      this.d.db.prepare('UPDATE viewer_tokens SET revoked_at = ?, revoked_by = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, actor, now, id);
      this.log(actor, 'viewer-token-revoke', r, this.accountIdsOfToken(id), {});
    });
    this.d.journal?.({ kind: 'viewer-token', tokenId: id, change: 'revoked' });
    return this.get(id);
  }

  setAccounts(actor: string, id: string, input: unknown): ViewerTokenView {
    const o = obj(input);
    const accountIds = accountIdsOf(o.accountIds);
    if (!Number.isInteger(o.version)) throw invalid('version');
    const now = this.d.clock.now();
    tx(this.d.db, () => {
      const r = this.row(id);
      if (r.version !== o.version) throw new ApiError(409, 'conflict');
      const old = this.accountIdsOfToken(id);
      const added = accountIds.filter((x) => !old.includes(x));
      const removed = old.filter((x) => !accountIds.includes(x));
      const valid = r.revoked_at === null && (r.expires_at as number) > now;
      // Every account the token ends up in must be one the actor manages; room is needed only where it is new.
      if (!canManage(actor, [...old, ...accountIds])) throw new ApiError(403, 'forbidden');
      if (valid) this.checkAccounts(actor, added, id);
      else for (const acc of added) if (!this.d.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(acc)) throw new ApiError(404, 'not_found');
      for (const acc of removed) this.d.db.prepare('DELETE FROM viewer_token_accounts WHERE token_id = ? AND account_id = ?').run(id, acc);
      for (const acc of added) this.d.db.prepare('INSERT INTO viewer_token_accounts (token_id, account_id) VALUES (?, ?)').run(id, acc);
      this.d.db.prepare('UPDATE viewer_tokens SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, id);
      this.log(actor, 'viewer-token-accounts', r, accountIds, { added, removed });
    });
    return this.get(id);
  }

  // Delete: revoked and gone from the list (and from every snapshot).
  remove(actor: string, id: string): void {
    tx(this.d.db, () => {
      const r = this.row(id);
      const accountIds = this.accountIdsOfToken(id);
      // The links first: their trigger bumps each account's revision.
      this.d.db.prepare('DELETE FROM viewer_token_accounts WHERE token_id = ?').run(id);
      this.d.db.prepare('DELETE FROM viewer_tokens WHERE id = ?').run(id);
      this.log(actor, 'viewer-token-delete', r, accountIds, {});
    });
    this.lastUsed.delete(id);
    this.usedDirty.delete(id);
    this.d.journal?.({ kind: 'viewer-token', tokenId: id, change: 'deleted' });
  }

  // A viewer's report: the newest use per token, for tokens of an account that viewer serves; never in the future.
  noteUse(servedAccountIds: string[], entries: { id: string; lastUsedAt: number }[]): void {
    if (!servedAccountIds.length || !entries.length) return;
    const now = this.d.clock.now();
    const marks = servedAccountIds.map(() => '?').join(',');
    for (const e of entries) {
      if (typeof e?.id !== 'string' || !Number.isSafeInteger(e.lastUsedAt)) continue;
      if (!this.d.db.prepare(`SELECT 1 FROM viewer_token_accounts WHERE token_id = ? AND account_id IN (${marks})`).get(e.id, ...servedAccountIds)) continue;
      const at = Math.min(e.lastUsedAt, now);
      if (at > (this.lastUsed.get(e.id) ?? 0)) { this.lastUsed.set(e.id, at); this.usedDirty.add(e.id); }
    }
  }

  // At start: the newest journal entry per token, applied to a row last changed before it (a restore never brings one back).
  replay(entries: ({ at: number } & ViewerTokenJournal)[]): void {
    const newest = new Map<string, { at: number } & ViewerTokenJournal>();
    for (const e of entries) if (e.at >= (newest.get(e.tokenId)?.at ?? -Infinity)) newest.set(e.tokenId, e);
    for (const e of newest.values()) {
      const r = this.d.db.prepare('SELECT id, updated_at FROM viewer_tokens WHERE id = ?').get(e.tokenId) as Row | undefined;
      if (!r || (r.updated_at as number) >= e.at) continue;
      tx(this.d.db, () => {
        if (e.change === 'deleted') {
          this.d.db.prepare('DELETE FROM viewer_token_accounts WHERE token_id = ?').run(e.tokenId);
          this.d.db.prepare('DELETE FROM viewer_tokens WHERE id = ?').run(e.tokenId);
        } else if (e.change === 'revoked') {
          this.d.db.prepare(`UPDATE viewer_tokens SET revoked_at = ?, revoked_by = 'system', updated_at = ?, version = version + 1 WHERE id = ?`).run(e.at, e.at, e.tokenId);
        } else if (e.change === 'expires') {
          this.d.db.prepare('UPDATE viewer_tokens SET expires_at = ?, revoked_at = NULL, revoked_by = NULL, updated_at = ?, version = version + 1 WHERE id = ?').run(e.expiresAt, e.at, e.tokenId);
        }
        this.d.audit.write({ actorType: 'system', actor: 'system', action: e.change === 'deleted' ? 'viewer-token-delete' : e.change === 'revoked' ? 'viewer-token-revoke' : 'viewer-token-validity', targetType: 'viewer-token', targetId: e.tokenId, outcome: 'ok', detail: { replayed: true } });
      });
    }
  }
}
