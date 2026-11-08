// Viewer tokens, the store (design 2026-11-05): create, copy any time, validity
// (longer, shorter, again after revoke or expiry, same token), revoke,
// accounts, delete, limits, revision bumps, the journal replay, and no
// secret in the audit log.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { fakeClock } from './helpers/clock';
import { ViewerTokens, VIEWER_DAYS, MAX_PER_ACCOUNT, type ViewerTokenJournal } from '../server/viewerTokens/service';
import { loadViewerKey, viewerFingerprint, DEFAULT_VIEWER_LINK_URL } from '../server/viewerTokens/crypto';
import { ApiError } from '../server/registry';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());
const keyFile = join(dir, 'vk');
writeFileSync(keyFile, randomBytes(32).toString('base64'));
chmodSync(keyFile, 0o600);
const key = loadViewerKey(keyFile)!;
const clock = fakeClock();
const journal: ViewerTokenJournal[] = [];
const vt = new ViewerTokens({ db: a.db, clock, audit: a.audit, key, linkBase: DEFAULT_VIEWER_LINK_URL, journal: (e) => void journal.push(e) });
const ACTOR = 'admin@example.com';
const DAY = 86400_000;
const home = a.registry.createAccount(ACTOR, { name: 'home', displayName: 'Home' }).id;
const away = a.registry.createAccount(ACTOR, { name: 'away', displayName: 'Away' }).id;
const rev = (acc: string) => (a.db.prepare('SELECT revision FROM config_revision WHERE account_id = ?').get(acc) as { revision: number }).revision;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}${e.field ? ' ' + e.field : ''}` : String(e); } return 'ok'; };

beforeEach(() => {
  a.db.prepare('DELETE FROM viewer_tokens').run();
  journal.length = 0;
});

describe('create', () => {
  it('makes a cav_ token valid for a week by default, for the accounts given; the answer has the token and the link', () => {
    const before = rev(home);
    const r = vt.create(ACTOR, { name: 'Grandma', accountIds: [home] });
    expect(r.token).toMatch(/^cav_[0-9A-Za-z]{22}$/);
    expect(r.link).toBe(`https://cams.skylar.technology/token#t=${r.token}`);
    expect(r.item).toMatchObject({ name: 'Grandma', days: 7, state: 'valid', expiresAt: clock.now() + 7 * DAY, createdBy: ACTOR, revokedAt: null, lastUsedAt: null, version: 1 });
    expect(r.item.accounts).toEqual([{ id: home, name: 'home', displayName: 'Home' }]);
    expect(r.item.fingerprintPrefix).toBe(viewerFingerprint(r.token).slice(7, 15));
    expect(r.item.id).toMatch(/^vtk_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(JSON.stringify(r.item)).not.toContain(r.token);
    expect(rev(home)).toBeGreaterThan(before);
    // Stored encrypted, never in clear.
    const row = a.db.prepare('SELECT * FROM viewer_tokens').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(r.token.slice(4));
    expect(row.fingerprint).toBe(viewerFingerprint(r.token));
  });

  it('accepts only 1, 7, 30, 90 and 365 days, a name of 1-64 characters, and 1-64 existing accounts', () => {
    expect(VIEWER_DAYS).toEqual([1, 7, 30, 90, 365]);
    for (const days of VIEWER_DAYS) expect(vt.create(ACTOR, { name: `d${days}`, accountIds: [home], days }).item.expiresAt).toBe(clock.now() + days * DAY);
    for (const days of [0, 2, 180, 366, -1, '7', null, 7.5]) expect(code(() => vt.create(ACTOR, { name: 'x', accountIds: [home], days })), String(days)).toBe('400 invalid days');
    for (const name of ['', ' ', 'a'.repeat(65), 'x\ny', 7]) expect(code(() => vt.create(ACTOR, { name, accountIds: [home] }))).toBe('400 invalid name');
    for (const accountIds of [[], [home, home], 'acc', undefined, ['acc_00000000000000000000']]) expect(code(() => vt.create(ACTOR, { name: 'x', accountIds }))).toMatch(/^400 invalid accountIds|^404 not_found/);
    expect(code(() => vt.create(ACTOR, { name: 'x', accountIds: ['acc_00000000000000000000'] }))).toBe('404 not_found');
  });

  it(`at most ${MAX_PER_ACCOUNT} valid tokens per account`, () => {
    for (let i = 0; i < MAX_PER_ACCOUNT; i++) vt.create(ACTOR, { name: `t${i}`, accountIds: [home] });
    expect(code(() => vt.create(ACTOR, { name: 'one more', accountIds: [home] }))).toBe('409 too_many_tokens');
    expect(code(() => vt.create(ACTOR, { name: 'elsewhere', accountIds: [away] }))).toBe('ok');
  });

  it('without the key file: create and copy answer 503, the rest works', () => {
    const r = vt.create(ACTOR, { name: 'before', accountIds: [home] });
    const off = new ViewerTokens({ db: a.db, clock, audit: a.audit, key: null, linkBase: DEFAULT_VIEWER_LINK_URL });
    expect(off.configured()).toBe(false);
    expect(code(() => off.create(ACTOR, { name: 'x', accountIds: [home] }))).toBe('503 viewer_tokens_unconfigured');
    expect(code(() => off.reveal(ACTOR, r.item.id, 'token'))).toBe('503 viewer_tokens_unconfigured');
    expect(off.list(home).items.map((t) => t.name)).toEqual(['before']);
    expect(off.revoke(ACTOR, r.item.id).state).toBe('revoked');
  });
});

describe('copy, validity, revoke, accounts, delete', () => {
  it('copy gives the same token any time, also after a revoke; audited without the token', () => {
    const r = vt.create(ACTOR, { name: 'phone', accountIds: [home] });
    expect(vt.reveal(ACTOR, r.item.id, 'token')).toEqual({ token: r.token, link: r.link });
    vt.revoke(ACTOR, r.item.id);
    expect(vt.reveal(ACTOR, r.item.id, 'qr').token).toBe(r.token);
    expect(code(() => vt.reveal(ACTOR, r.item.id, 'nope' as 'token'))).toBe('400 invalid what');
    const copies = a.audit.list({ action: 'viewer-token-copy' }).items.filter((x) => x.targetId === r.item.id);
    expect(copies.map((x) => x.detail.what)).toEqual(['qr', 'token']);
  });

  it('validity: a new length from today, longer or shorter; after revoke or expiry valid again with the same token', () => {
    const r = vt.create(ACTOR, { name: 'tablet', accountIds: [home], days: 30 });
    clock.advance(DAY);
    expect(vt.setValidity(ACTOR, r.item.id, { days: 1 })).toMatchObject({ days: 1, expiresAt: clock.now() + DAY, state: 'valid' });
    expect(journal.at(-1)).toMatchObject({ tokenId: r.item.id, change: 'expires', expiresAt: clock.now() + DAY });
    clock.advance(2 * DAY);
    expect(vt.get(r.item.id).state).toBe('expired');
    expect(vt.setValidity(ACTOR, r.item.id, { days: 90 })).toMatchObject({ state: 'valid', expiresAt: clock.now() + 90 * DAY });
    vt.revoke(ACTOR, r.item.id);
    expect(vt.get(r.item.id)).toMatchObject({ state: 'revoked', revokedBy: ACTOR });
    expect(journal.at(-1)).toMatchObject({ tokenId: r.item.id, change: 'revoked' });
    const again = vt.setValidity(ACTOR, r.item.id, { days: 7 });
    expect(again).toMatchObject({ state: 'valid', revokedAt: null, revokedBy: null });
    expect(vt.reveal(ACTOR, r.item.id, 'token').token).toBe(r.token);
    expect(code(() => vt.setValidity(ACTOR, r.item.id, { days: 2 }))).toBe('400 invalid days');
  });

  it('revoke is idempotent and bumps the revision; every change of a valid token reaches its accounts', () => {
    const r = vt.create(ACTOR, { name: 'tv', accountIds: [home, away] });
    const [h, w] = [rev(home), rev(away)];
    vt.revoke(ACTOR, r.item.id);
    expect(rev(home)).toBeGreaterThan(h);
    expect(rev(away)).toBeGreaterThan(w);
    const h2 = rev(home);
    const n = a.audit.list({ action: 'viewer-token-revoke' }).items.length;
    vt.revoke(ACTOR, r.item.id);
    expect(rev(home)).toBe(h2);
    expect(a.audit.list({ action: 'viewer-token-revoke' }).items.length).toBe(n);
  });

  it('accounts: set with the version; at least one; the old and the new accounts both get a new revision', () => {
    const r = vt.create(ACTOR, { name: 'shared', accountIds: [home] });
    const [h, w] = [rev(home), rev(away)];
    const u = vt.setAccounts(ACTOR, r.item.id, { accountIds: [away], version: 1 });
    expect(u.accounts.map((x) => x.name)).toEqual(['away']);
    expect(u.version).toBe(2);
    expect(rev(home)).toBeGreaterThan(h);
    expect(rev(away)).toBeGreaterThan(w);
    expect(code(() => vt.setAccounts(ACTOR, r.item.id, { accountIds: [home], version: 1 }))).toBe('409 conflict');
    expect(code(() => vt.setAccounts(ACTOR, r.item.id, { accountIds: [], version: 2 }))).toBe('400 invalid accountIds');
    expect(code(() => vt.setAccounts(ACTOR, r.item.id, { accountIds: [home] }))).toBe('400 invalid version');
    const audit = a.audit.list({ action: 'viewer-token-accounts' }).items[0];
    expect(audit.detail).toMatchObject({ added: [away], removed: [home] });
    expect(vt.list(home).items).toEqual([]);
    expect(vt.list(away).items.map((x) => x.id)).toEqual([r.item.id]);
  });

  it('delete revokes and removes; the journal keeps it gone', () => {
    const r = vt.create(ACTOR, { name: 'gone', accountIds: [home] });
    const h = rev(home);
    vt.remove(ACTOR, r.item.id);
    expect(rev(home)).toBeGreaterThan(h);
    expect(vt.list().items).toEqual([]);
    expect(journal.at(-1)).toMatchObject({ tokenId: r.item.id, change: 'deleted' });
    expect(code(() => vt.get(r.item.id))).toBe('404 not_found');
    expect(code(() => vt.remove(ACTOR, r.item.id))).toBe('404 not_found');
  });

  it('an account deleted: its links go; the token stays with its other accounts', () => {
    const tmp = a.registry.createAccount(ACTOR, { name: 'tmp', displayName: 'Tmp' }).id;
    const r = vt.create(ACTOR, { name: 'both', accountIds: [home, tmp] });
    a.registry.deleteAccount(ACTOR, tmp, 'tmp');
    expect(vt.get(r.item.id).accounts.map((x) => x.name)).toEqual(['home']);
  });
});

describe('replay after a restore', () => {
  it('the newest journal entry per token wins over an older row: revoked, deleted, a shorter validity', () => {
    const r1 = vt.create(ACTOR, { name: 'r1', accountIds: [home], days: 30 });
    const r2 = vt.create(ACTOR, { name: 'r2', accountIds: [home], days: 30 });
    const r3 = vt.create(ACTOR, { name: 'r3', accountIds: [home], days: 30 });
    const later = clock.now() + 1000;
    vt.replay([
      { at: later - 10, kind: 'viewer-token', tokenId: r1.item.id, change: 'expires', expiresAt: later + DAY },
      { at: later, kind: 'viewer-token', tokenId: r1.item.id, change: 'revoked' },
      { at: later, kind: 'viewer-token', tokenId: r2.item.id, change: 'deleted' },
      { at: later, kind: 'viewer-token', tokenId: r3.item.id, change: 'expires', expiresAt: later + DAY },
      { at: later, kind: 'viewer-token', tokenId: 'vtk_00000000000000000000', change: 'revoked' },
    ]);
    expect(vt.get(r1.item.id).state).toBe('revoked');
    expect(code(() => vt.get(r2.item.id))).toBe('404 not_found');
    expect(vt.get(r3.item.id).expiresAt).toBe(later + DAY);
  });

  it('a row changed after the entry is left alone', () => {
    const r = vt.create(ACTOR, { name: 'newer', accountIds: [home] });
    vt.replay([{ at: clock.now() - 1, kind: 'viewer-token', tokenId: r.item.id, change: 'revoked' }]);
    expect(vt.get(r.item.id).state).toBe('valid');
  });
});

describe('last used (reported by the viewers, in memory)', () => {
  it('keeps the newest time per token, only for tokens of an account the instance serves', () => {
    const r = vt.create(ACTOR, { name: 'seen', accountIds: [home] });
    const t0 = clock.now();
    vt.noteUse([home], [{ id: r.item.id, lastUsedAt: t0 - 5000 }, { id: 'vtk_00000000000000000000', lastUsedAt: t0 }]);
    vt.noteUse([home], [{ id: r.item.id, lastUsedAt: t0 - 9000 }]);
    expect(vt.get(r.item.id).lastUsedAt).toBe(t0 - 5000);
    vt.noteUse([away], [{ id: r.item.id, lastUsedAt: t0 }]);
    expect(vt.get(r.item.id).lastUsedAt).toBe(t0 - 5000);
    // Never in the future.
    vt.noteUse([home], [{ id: r.item.id, lastUsedAt: t0 + 3600_000 }]);
    expect(vt.get(r.item.id).lastUsedAt).toBe(t0);
  });
});

describe('the audit log', () => {
  it('has every action and never the token, its full fingerprint or its ciphertext', () => {
    const r = vt.create(ACTOR, { name: 'audited', accountIds: [home] });
    vt.reveal(ACTOR, r.item.id, 'link');
    vt.setValidity(ACTOR, r.item.id, { days: 30 });
    vt.setAccounts(ACTOR, r.item.id, { accountIds: [home, away], version: vt.get(r.item.id).version });
    vt.revoke(ACTOR, r.item.id);
    vt.remove(ACTOR, r.item.id);
    const items = a.audit.list({ limit: 200 }).items.filter((x) => x.targetId === r.item.id);
    expect(items.map((x) => x.action).reverse()).toEqual(['viewer-token-create', 'viewer-token-copy', 'viewer-token-validity', 'viewer-token-accounts', 'viewer-token-revoke', 'viewer-token-delete']);
    const all = JSON.stringify(a.db.prepare('SELECT * FROM audit_log').all());
    expect(all).not.toContain(r.token.slice(4));
    expect(all).not.toContain(viewerFingerprint(r.token).slice(7, 40));
    expect(items[items.length - 1]).toMatchObject({ accountId: home, targetLabel: 'audited' });
  });
});

describe('role (spec 2026-11-08 A4/B6)', () => {
  const lastAudit = (action: string) => a.audit.list({ action }).items[0];
  it('viewer by default; admin on create; refused otherwise; audited', () => {
    const v = vt.create(ACTOR, { name: 'tablet', accountIds: [home] });
    expect(v.item.role).toBe('viewer');
    expect(lastAudit('viewer-token-create').detail).toMatchObject({ role: 'viewer' });
    const ad = vt.create(ACTOR, { name: 'kit admin', accountIds: [home], role: 'admin' });
    expect(ad.item.role).toBe('admin');
    expect(lastAudit('viewer-token-create').detail).toMatchObject({ role: 'admin' });
    expect(code(() => vt.create(ACTOR, { name: 'x', accountIds: [home], role: 'owner' }))).toBe('400 invalid role');
  });
  it('a role change bumps every account of the token and is audited with from and to; the same role changes nothing', () => {
    const v = vt.create(ACTOR, { name: 'both', accountIds: [home, away] });
    const before = [rev(home), rev(away)];
    const t = vt.setRole(ACTOR, v.item.id, { role: 'admin' });
    expect([t.role, t.version]).toEqual(['admin', v.item.version + 1]);
    expect([rev(home), rev(away)]).toEqual([before[0] + 1, before[1] + 1]);
    expect(lastAudit('viewer-token-role').detail).toMatchObject({ role: 'admin', from: 'viewer', accountIds: [home, away].sort() });
    const n = a.audit.list({ action: 'viewer-token-role' }).items.length;
    expect(vt.setRole(ACTOR, v.item.id, { role: 'admin' }).version).toBe(t.version);
    expect(a.audit.list({ action: 'viewer-token-role' }).items.length).toBe(n);
    expect(code(() => vt.setRole(ACTOR, v.item.id, { role: 'root' }))).toBe('400 invalid role');
    expect(code(() => vt.setRole(ACTOR, 'vtk_00000000000000000000', { role: 'viewer' }))).toBe('404 not_found');
  });
});
