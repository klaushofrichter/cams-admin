// Issue #58: the last report of each cams instance survives a restart (it is
// written only when its content changes), so /diag/cams-instances and the
// dashboard are not empty until cams happens to report again.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { tmpDir } from './helpers/tmp';
import { buildServer, type Built } from '../server/server';
import { writeSigningKey } from './helpers/signingKey';
import { readEpoch, openDb, LATEST_VERSION } from '../server/db/open';
import { MIGRATIONS } from '../server/db/migrations';
import { ApiError } from '../server/registry';

const ADMIN = 'admin@example.com';
const open: Built[] = [];
const mk = (dir: string): Built => {
  process.env.ALLOWED_EMAILS = ADMIN;
  const b = buildServer({ PUBLIC_URL: 'https://cams-admin.example.net', DB_FILE: join(dir, 'app.db'), SERVER_SIGNING_KEY_FILE: writeSigningKey(join(dir, 'sk.pem')), NODE_ENV: 'test' });
  open.push(b);
  return b;
};
afterEach(async () => { while (open.length) await open.pop()!.close(); });

const REPORT = { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], heldProxies: [], keptOld: [], shadow: null, tokens: { managed: 1, pending: 0, legacy: 0 }, problems: [] } as const;
const row = (b: Built, id: string) => b.db.prepare('SELECT last_report, last_report_at FROM cams_instances WHERE id = ?').get(id) as { last_report: string | null; last_report_at: number | null };
const setup = (dir: string) => {
  const b = mk(dir);
  const acc = b.registry.createAccount(ADMIN, { name: 'home', displayName: 'Home' }).id;
  const inst = b.camsInstances.create(ADMIN, { name: 'cluster', displayName: 'Cluster', accounts: [acc] });
  return { b, acc, inst };
};

describe('the last cams report is persisted (#58)', () => {
  it('survives a rebuild on the same data dir, in /diag/cams-instances and in live()', async () => {
    const dir = tmpDir();
    const { b, acc, inst } = setup(dir);
    const token = b.diag.issue(ADMIN, { name: 'check' }).token;
    const rep = { ...REPORT, held: [{ accountId: acc, camsId: 'porch', fields: ['host'] }], problems: [{ code: 'token_retire_failed', accountId: acc }] };
    b.camsInstances.report(inst.id, rep, 1_000);
    await b.close();
    open.length = 0;
    const b2 = mk(dir);
    expect(b2.camsInstances.live(inst.id)).toMatchObject({ report: rep, reportAt: 1_000, shadowZeroSince: null });
    const r = await request(b2.app).get('/api/v1/diag/cams-instances').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const item = r.body.items.find((x: { id: string }) => x.id === inst.id);
    expect(item.reportAt).toBe(1_000);
    expect(item.report.problems).toEqual([{ code: 'token_retire_failed', accountId: acc, detail: null }]);
    expect(item.report.held).toEqual(rep.held);
  });

  it('falls back to the stored report when live holds only pull data; a newer in-memory report wins', () => {
    const { b, inst } = setup(tmpDir());
    b.camsInstances.report(inst.id, REPORT, 1_000);
    (b.camsInstances as any).liveState.delete(inst.id);
    b.camsInstances.touch(inst.id, { lastPullAt: 5, lastPullStatus: 304 });
    expect(b.camsInstances.live(inst.id)).toMatchObject({ lastPullAt: 5, report: { mode: 'cams-admin' }, reportAt: 1_000 });
    b.camsInstances.report(inst.id, { ...REPORT, version: 'u' }, 2_000);
    expect(b.camsInstances.live(inst.id)).toMatchObject({ report: { version: 'u' }, reportAt: 2_000 });
  });

  it('an identical report writes nothing, even with new lastPullAt / cacheVerifiedAt', () => {
    const { b, inst } = setup(tmpDir());
    b.camsInstances.report(inst.id, REPORT, 1_000);
    const e = readEpoch(b.db);
    const stored = row(b, inst.id);
    expect(stored.last_report_at).toBe(1_000);
    b.camsInstances.report(inst.id, REPORT, 61_000);
    b.camsInstances.report(inst.id, { ...REPORT, lastPullAt: 70_000, cacheVerifiedAt: 71_000 }, 121_000);
    expect(readEpoch(b.db)).toBe(e);
    expect(row(b, inst.id)).toEqual(stored);
    // memory still has the newest report and time
    expect(b.camsInstances.live(inst.id)).toMatchObject({ report: { lastPullAt: 70_000 }, reportAt: 121_000 });
  });

  it('a changed report updates the row', () => {
    const { b, inst } = setup(tmpDir());
    b.camsInstances.report(inst.id, REPORT, 1_000);
    const e = readEpoch(b.db);
    b.camsInstances.report(inst.id, { ...REPORT, tokens: { managed: 2, pending: 0, legacy: 0 } }, 61_000);
    expect(readEpoch(b.db)).toBe(e + 1);
    const r = row(b, inst.id);
    expect(r.last_report_at).toBe(61_000);
    expect(JSON.parse(r.last_report!).tokens.managed).toBe(2);
  });

  it('an invalid report stores nothing and is refused with 400', () => {
    const { b, inst } = setup(tmpDir());
    let err: unknown;
    try { b.camsInstances.report(inst.id, { v: 1, mode: 7 }, 1_000); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(row(b, inst.id)).toEqual({ last_report: null, last_report_at: null });
  });

  it('deleting the instance removes its report with the row', () => {
    const { b, inst } = setup(tmpDir());
    b.camsInstances.report(inst.id, REPORT, 1_000);
    b.camsInstances.remove(ADMIN, inst.id, 'cluster');
    expect(b.db.prepare('SELECT count(*) n FROM cams_instances').get()).toEqual({ n: 0 });
    expect(b.camsInstances.live(inst.id).report).toBeNull();
  });

  it('migration 12: a version-11 database gains the two columns, rows intact and NULL', () => {
    const f = join(tmpDir(), 'm12.db');
    const raw = new DatabaseSync(f);
    for (let i = 0; i < 11; i++) MIGRATIONS[i](raw);
    raw.exec('PRAGMA user_version = 11');
    raw.exec(`INSERT INTO cams_instances (id,name,display_name,state,created_at,updated_at) VALUES ('cms_1','pi','Pi','pending',1,1)`);
    raw.close();
    const db = openDb(f);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT name, last_report, last_report_at FROM cams_instances').all()).toEqual([{ name: 'pi', last_report: null, last_report_at: null }]);
    db.close();
  });

  it('the stored report holds no secret: only ids, field names and problem codes', () => {
    const { b, acc, inst } = setup(tmpDir());
    const rep = { ...REPORT, held: [{ accountId: acc, camsId: 'porch', fields: ['host', 'cameraUser'] }], problems: [{ code: 'x', accountId: acc, detail: 'proxy prx_1' }] };
    b.camsInstances.report(inst.id, rep, 1_000);
    const stored = row(b, inst.id).last_report!;
    expect(JSON.parse(stored)).toEqual(rep);
    expect(stored).not.toMatch(/password|secret|token_hash|sha256:|BEGIN|@example\.com/i);
  });
});
