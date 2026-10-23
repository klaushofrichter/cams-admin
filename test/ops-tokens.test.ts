// Operations tokens (the store): scoped bearer tokens, issued once and stored
// as a hash, bounded in number and lifetime, revocable and replayed at start.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { fakeClock } from './helpers/clock';
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
  });

  it('no row or audit detail contains the token string', () => {
    const { token } = issue('secret-check');
    const dump = JSON.stringify([a.db.prepare('SELECT * FROM ops_tokens').all(), a.db.prepare('SELECT * FROM audit_log').all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4));
    expect(a.db.prepare(`SELECT count(*) n FROM audit_log WHERE action = 'ops-token-issue'`).get()).toMatchObject({ n: expect.any(Number) });
  });
});
