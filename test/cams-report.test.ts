import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch, type CamsKeyT } from './helpers/cams';
import { readEpoch } from '../server/db/open';

const REPORT = { v: 1, mode: 'cams-admin', version: '2026.10.07.1', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] };

describe('cams status reports (POST /cams/v1/report)', () => {
  const dir = tmpDir();
  let s: Running;
  let inst: any, key: CamsKeyT, acc: any;
  const post = async (body: unknown) => {
    const r = await signedFetch(s, key, 'POST', '/cams/v1/report', body);
    return { status: r.status, json: await r.json() };
  };
  beforeAll(async () => {
    s = await startServer(dir);
    acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    inst = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [acc.id] });
    key = await enrollCamsKey(s, inst.id);
    await signedFetch(s, key, 'GET', '/cams/v1/config'); // confirms the key
  });
  afterAll(() => s.stop());

  it('a valid report is kept in memory (no write) and answers changed when the applied revision differs', async () => {
    const e = readEpoch(s.built.db);
    const a = await post({ ...REPORT, appliedRevision: 'r:0000000000000000' });
    expect(a).toEqual({ status: 200, json: { changed: true, revision: expect.stringMatching(/^r:[0-9a-f]{16}$/) } });
    expect(readEpoch(s.built.db)).toBe(e);
    expect(s.built.camsInstances.live(inst.id)).toMatchObject({ report: { mode: 'cams-admin' }, reportAt: expect.any(Number) });
    const b = await post({ ...REPORT, appliedRevision: a.json.revision });
    expect(b.json).toEqual({ changed: false, revision: a.json.revision });
  });

  it('shadow: zeroSince is set at the first report with 0 differences and cleared by one with differences', async () => {
    const shadow = (n: number) => ({ ...REPORT, mode: 'shadow', shadow: { accountId: acc.id, differences: n, items: n ? ['cam1: host'] : [] } });
    await post(shadow(0));
    const since = s.built.camsInstances.live(inst.id).shadowZeroSince;
    expect(since).toEqual(expect.any(Number));
    await post(shadow(0));
    expect(s.built.camsInstances.live(inst.id).shadowZeroSince).toBe(since);
    await post(shadow(2));
    expect(s.built.camsInstances.live(inst.id).shadowZeroSince).toBeNull();
  });

  it('an invalid report → 400 invalid with the field; a report with a value-shaped item over 200 chars is refused', async () => {
    expect(await post({ ...REPORT, mode: 7 })).toEqual({ status: 400, json: { error: 'invalid', field: 'mode' } });
    const long = await post({ ...REPORT, mode: 'shadow', shadow: { accountId: acc.id, differences: 1, items: ['cam1: host was ' + 'x'.repeat(200)] } });
    expect(long).toEqual({ status: 400, json: { error: 'invalid', field: 'shadow' } });
    expect(await post({ v: 2, mode: 'file' })).toEqual({ status: 400, json: { error: 'invalid', field: 'v' } });
  });

  it('the dashboard lists each instance with its pull, mode, revision, held/kept-old counts, shadow and problems', async () => {
    await post({ ...REPORT, mode: 'shadow', appliedRevision: null, held: [{ accountId: acc.id, camsId: 'cam1', fields: ['host'] }], shadow: { accountId: acc.id, differences: 2, items: ['cam1: host', 'cam2: protocol'] }, problems: [{ code: 'snapshot_invalid', detail: 'x' }] });
    const d = await s.api('GET', '/dashboard');
    expect(d.cams).toEqual([expect.objectContaining({
      id: inst.id, name: 'cluster', state: 'enrolled', lastSeenAt: expect.any(Number), lastPullAt: expect.any(Number), mode: 'shadow', appliedRevision: null, current: false,
      held: 1, keptOld: 0, diverged: false, shadowDifferences: 2, shadowZeroSince: null, problems: 1,
    })]);
  });
});
