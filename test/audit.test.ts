import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { openDb } from '../server/db/open';
import { Audit, AUDIT_ACTIONS } from '../server/audit';
import { tmpDir } from './helpers/tmp';
import { fakeClock } from './helpers/clock';

describe('audit log', () => {
  const dir = tmpDir();
  let n = 0;
  const setup = () => {
    const db = openDb(join(dir, `a${n++}.db`));
    const clock = fakeClock();
    return { db, clock, audit: new Audit(db, clock) };
  };
  const base = { actorType: 'sysadmin' as const, actor: 'a@example.com', outcome: 'ok' as const };

  it('has the closed list of spec §11.4', () => {
    expect(AUDIT_ACTIONS).toContain('proxy-enrolled');
    expect(AUDIT_ACTIONS).toContain('audit-throttled');
    expect(AUDIT_ACTIONS).toHaveLength(30);
  });

  it('refuses an unknown action', () => {
    const { audit } = setup();
    expect(() => audit.write({ ...base, action: 'nope' as never })).toThrow(/unknown audit action/);
  });

  it('writes a record and lists newest first with filters and paging', () => {
    const { audit, clock } = setup();
    for (let i = 0; i < 5; i++) {
      audit.write({ ...base, action: i % 2 ? 'account-create' : 'user-create', accountId: i < 3 ? 'acc_a' : 'acc_b', detail: { i } });
      clock.advance(1000);
    }
    const all = audit.list({});
    expect(all.items.map((r) => r.detail.i)).toEqual([4, 3, 2, 1, 0]);
    expect(audit.list({ account: 'acc_a' }).items).toHaveLength(3);
    expect(audit.list({ action: 'account-create' }).items).toHaveLength(2);
    const p1 = audit.list({ limit: 2 });
    expect(p1.items.map((r) => r.detail.i)).toEqual([4, 3]);
    const p2 = audit.list({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.detail.i)).toEqual([2, 1]);
    expect(audit.list({ from: all.items[2].at, to: all.items[1].at }).items).toHaveLength(2);
  });

  it('truncates a detail over 4 KiB', () => {
    const { audit } = setup();
    audit.write({ ...base, action: 'account-update', detail: { big: 'x'.repeat(5000) } });
    expect(audit.list({}).items[0].detail).toEqual({ truncated: true });
  });

  it('throttles one record per key per 10 minutes and counts the rest', () => {
    const { audit, clock } = setup();
    const e = { actorType: 'proxy' as const, actor: 'prx_a', action: 'proxy-auth-refused' as const, outcome: 'refused' as const };
    for (let i = 0; i < 5; i++) { audit.throttled('prx_a', e); clock.advance(60_000); }
    expect(audit.list({}).items).toHaveLength(1);
    clock.advance(10 * 60_000);
    audit.flushThrottled();
    const items = audit.list({}).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ action: 'audit-throttled', detail: { key: 'prx_a', throttledAction: 'proxy-auth-refused', count: 4 } });
  });

  it('prunes records older than 400 days', () => {
    const { audit, clock } = setup();
    audit.write({ ...base, action: 'signin' });
    clock.advance(401 * 86400_000);
    audit.write({ ...base, action: 'signout' });
    audit.prune();
    expect(audit.list({}).items.map((r) => r.action)).toEqual(['signout']);
  });
});
