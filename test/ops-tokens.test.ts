// Operations tokens (the store): scoped bearer tokens, issued once and stored
// as a hash, bounded in number and lifetime, revocable and replayed at start.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { fakeClock } from './helpers/clock';
import { writeSigningKey } from './helpers/signingKey';
import { buildServer } from '../server/server';
import { hashOf } from '../server/auth/bearer-tokens';
import { OpsTokens, OPS_MAX_LIVE } from '../server/ops/tokens';
import { DiagTokens } from '../server/diag/tokens';
import { ApiError } from '../server/registry';
import { FieldError } from '../server/validate';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

const clock = fakeClock();
const journal: string[] = [];
const ops = new OpsTokens({ db: a.db, clock, audit: a.audit, journal: (id) => void journal.push(id) });
const DAY = 86400_000;
const issue = (name = 'script', extra: Record<string, unknown> = {}) => ops.issue('admin@example.com', { name, scopes: ['routes'], ...extra });

beforeEach(() => {
  a.db.prepare(`UPDATE ops_tokens SET revoked_at = 1, revoked_by = 'test' WHERE revoked_at IS NULL`).run();
  journal.length = 0;
});

describe('OpsTokens', () => {
  it('issues cao_ + 43 chars, with scopes, an 8-hex prefix and a 30 day default expiry', () => {
    const { token, item } = issue('mac');
    expect(token).toMatch(/^cao_[A-Za-z0-9_-]{43}$/);
    expect(item.scopes).toEqual(['routes']);
    expect(item.hashPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(item.state).toBe('active');
    expect(item.expiresAt).toBe(item.createdAt + 30 * DAY);
  });

  it('rejects bad days and bad scopes with a field error', () => {
    expect(() => issue('x', { days: 91 })).toThrow(FieldError);
    expect(() => issue('x', { days: 0 })).toThrow(FieldError);
    for (const scopes of [[], ['nope'], ['tokens', 'tokens'], 'tokens', undefined]) {
      expect(() => ops.issue('admin@example.com', { name: 'x', scopes })).toThrow(FieldError);
    }
    try { ops.issue('admin@example.com', { name: 'x', scopes: [] }); } catch (e) { expect((e as FieldError).field).toBe('scopes'); }
  });

  it('the 6th live token gets 409 too_many_tokens', () => {
    for (let i = 0; i < OPS_MAX_LIVE; i++) issue(`t${i}`);
    try { issue('one-too-many'); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
      expect((e as ApiError).code).toBe('too_many_tokens');
    }
  });

  it('verifyScoped gives the scopes of a live token and null for anything else', () => {
    const { token, item } = ops.issue('admin@example.com', { name: 'x', scopes: ['tokens', 'moves'] });
    expect(ops.verifyScoped(token)).toEqual({ id: item.id, hashPrefix: item.hashPrefix, scopes: ['tokens', 'moves'] });
    expect(ops.verify(token)).toBe(item.id);
    expect(ops.verifyScoped('cao_' + 'A'.repeat(43))).toBeNull();
    expect(ops.verifyScoped('cad_' + 'A'.repeat(43))).toBeNull();
    // A live row whose hash matches an over-long string: only the length cap refuses it.
    const long = 'cao_' + 'A'.repeat(130);
    a.db.prepare('INSERT INTO ops_tokens (id, name, hash, created_at, created_by, expires_at, scopes) VALUES (?,?,?,?,?,?,?)')
      .run('opt_long', 'long', hashOf(long), clock.now(), 'test', clock.now() + DAY, '["routes"]');
    expect(ops.verifyScoped(long)).toBeNull();
    expect(ops.verifyScoped('cao_' + 'A'.repeat(130))).toBeNull();
    const dg = new DiagTokens({ db: a.db, clock, audit: a.audit }).issue('admin@example.com', { name: 'd' });
    expect(ops.verifyScoped(dg.token)).toBeNull();
    clock.advance(31 * DAY);
    expect(ops.verifyScoped(token)).toBeNull();
    clock.advance(-31 * DAY);
    ops.revoke('admin@example.com', item.id);
    expect(ops.verifyScoped(token)).toBeNull();
  });

  it('revoke calls the journal; replay revokes an unrevoked row as system', () => {
    const { item } = issue('r');
    ops.revoke('admin@example.com', item.id);
    expect(journal).toEqual([item.id]);
    const b = issue('replayed').item;
    ops.replay(b.id);
    const row = a.db.prepare('SELECT revoked_at, revoked_by FROM ops_tokens WHERE id = ?').get(b.id) as { revoked_at: number | null; revoked_by: string };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe('system');
    expect(journal).toEqual([item.id]);
    expect(a.db.prepare(`SELECT actor_type, actor, detail FROM audit_log WHERE action = 'ops-token-revoke' AND target_id = ?`).get(b.id))
      .toMatchObject({ actor_type: 'system', actor: 'system', detail: expect.stringContaining('"replayed":true') });
    // Replaying an already revoked row changes nothing.
    const audits = () => (a.db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'ops-token-revoke'`).get() as { n: number }).n;
    const n = audits();
    ops.replay(item.id);
    expect(audits()).toBe(n);
    expect(a.db.prepare('SELECT revoked_by FROM ops_tokens WHERE id = ?').get(item.id)).toEqual({ revoked_by: 'admin@example.com' });
  });

  it('a corrupt scopes column fails closed', () => {
    const { token, item } = issue('corrupt');
    a.db.prepare('UPDATE ops_tokens SET scopes = ? WHERE id = ?').run('not json', item.id);
    expect(ops.verifyScoped(token)).toBeNull();
    expect(ops.list().items.find((i) => i.id === item.id)?.scopes).toEqual([]);
  });

  it('no row or audit detail contains the token string', () => {
    const issued = () => (a.db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'ops-token-issue'`).get() as { n: number }).n;
    const before = issued();
    const { token } = issue('secret-check');
    expect(issued()).toBe(before + 1);
    const dump = JSON.stringify([a.db.prepare('SELECT * FROM ops_tokens').all(), a.db.prepare('SELECT * FROM audit_log').all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4));
  });
});

describe('revocation journal', () => {
  it('a restore from an older backup does not bring a revoked ops token back', async () => {
    const d2 = tmpDir();
    process.env.ALLOWED_EMAILS = 'admin@example.com';
    const env = { PUBLIC_URL: 'https://cams-admin.example.net', DB_FILE: join(d2, 'app.db'), SERVER_SIGNING_KEY_FILE: writeSigningKey(join(d2, 'sk.pem')), NODE_ENV: 'test' };
    const b1 = buildServer(env);
    const { token, item } = b1.ops.issue('admin@example.com', { name: 'restored', scopes: ['routes'] });
    b1.ops.revoke('admin@example.com', item.id);
    // What an older backup would hold: the token not revoked.
    b1.db.prepare('UPDATE ops_tokens SET revoked_at = NULL, revoked_by = NULL WHERE id = ?').run(item.id);
    await b1.close();
    const b2 = buildServer(env);
    try {
      expect(b2.ops.verifyScoped(token)).toBeNull();
      expect(b2.ops.list().items[0]).toMatchObject({ id: item.id, state: 'revoked', revokedBy: 'system' });
    } finally {
      await b2.close();
    }
  });
});
