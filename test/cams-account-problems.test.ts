// Finding 12b: a cams instance's snapshot_invalid for an account was only in its report; now the account's Overview
// (GET /accounts/:id/cams-problems) and the Dashboard name it, with the camera's cams id where cams gave an index.
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { problemText } from '../server/cams/problems';

const built: { close(): Promise<void> }[] = [];
afterEach(async () => { while (built.length) await built.pop()!.close(); });
const base = { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 } };

describe("a cams instance's problems on the account", () => {
  const dir = tmpDir();
  it('snapshot_invalid with a camera index: named by cams id, in words, on the account and the dashboard; other accounts see nothing', async () => {
    const a = testApp(dir);
    built.push(a);
    const home = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    const other = (await a.api('post', '/accounts', { name: 'other', displayName: 'Other' })).body;
    const px = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://192.0.2.20:8443' })).body;
    const hidden = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'hid', displayName: 'Hidden', runsOn: 'local-host' })).body;
    const cms = (await a.api('post', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home.id, other.id] })).body;
    await a.api('put', `/cams-instances/${cms.id}/routes/${px.id}`, { hidden: false });
    // Snapshot order: by cams id; a camera on an unrouted proxy is not in the instance's part.
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'b-cam', name: 'B', kind: 'camera', proxyId: px.id, proxyCameraId: 'b' });
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'a-cam', name: 'A', kind: 'camera', proxyId: hidden.id, proxyCameraId: 'a' });
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'c-cam', name: 'C', kind: 'camera' });
    a.camsInstances.report(cms.id, { ...base, problems: [
      { code: 'snapshot_invalid', accountId: home.id, detail: 'camera 1: protocol' },
      { code: 'snapshot_invalid', accountId: other.id, detail: 'camera 0: host' },
      { code: 'snapshot_refused', detail: 'bad signature' },
    ] }, Date.now());
    const items = (await a.api('get', `/accounts/${home.id}/cams-problems`)).body.items;
    expect(items).toEqual([{ instanceId: cms.id, instance: 'Cluster', code: 'snapshot_invalid', detail: 'camera 1: protocol', camsId: 'c-cam',
      text: "Cluster can't use this account's configuration (camera c-cam: protocol): it keeps the last one it accepted. Check the camera's host, protocol and TLS name (Cameras → Edit)." }]);
    const dash = (await a.api('get', '/dashboard')).body;
    expect(dash.accounts.find((x: { id: string }) => x.id === home.id).camsProblems).toEqual(items);
    expect(dash.accounts.find((x: { id: string }) => x.id === other.id).camsProblems.map((p: { camsId: string | null; detail: string }) => [p.camsId, p.detail])).toEqual([[null, 'camera 0: host']]);
    expect((await a.api('get', `/accounts/${home.id}/cams-problems`)).status).toBe(200);
    expect((await a.api('get', '/accounts/acc_00000000000000000000/cams-problems')).status).toBe(404);
  });
  it('words for the other codes; an unknown code is named as is', () => {
    expect(problemText('Pi', 'proxy_token_missing', 'proxy prx_1', null)).toContain('has no token for a proxy of this account (proxy prx_1)');
    expect(problemText('Pi', 'something_new', '', null)).toBe('Pi reports something_new.');
  });
});
