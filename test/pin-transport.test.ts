// #106: cams takes CA pins only with an https URL or a loopback http one (cams server/tls/loopback.ts); with a
// plain-http, non-loopback route URL it refuses the whole account part. The snapshot leaves the pins out there.
import { afterAll, describe, expect, it } from 'vitest';
import { pinTransportOk } from '../server/cams/pinTransport';
import { diagProxies } from '../server/diag/views';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

describe('pinTransportOk (the cams rule)', () => {
  it('https and loopback http carry pins; other http does not', () => {
    expect(pinTransportOk('https://proxy.example.net:8443')).toBe(true);
    for (const u of ['http://127.0.0.1:8480', 'http://localhost:8480', 'http://[::1]:8480', 'http://127.1.2.3']) expect(pinTransportOk(u), u).toBe(true);
    for (const u of ['http://cam-proxy.cam-proxy.svc.cluster.local:8480', 'http://192.0.2.5:8480', 'http://proxy.example.net']) expect(pinTransportOk(u), u).toBe(false);
  });
  it('no URL or an unparsable one is not judged here (cams refuses those on its own)', () => {
    expect(pinTransportOk(null)).toBe(true);
    expect(pinTransportOk('not a url')).toBe(true);
  });
});

describe('#106: the proxy page and /diag/proxies name the instances that get no pins', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());

  it('a plain-http, non-loopback route is listed; https and loopback routes are not; diag lists them only while pinned', async () => {
    const acc = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body.id;
    const px = (await a.api('post', `/accounts/${acc}/proxies`, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster', url: 'https://proxy.example.net' })).body;
    const inst = async (name: string, url: string | null) => {
      const i = (await a.api('post', '/cams-instances', { name, displayName: name.toUpperCase(), accounts: [acc] })).body;
      expect((await a.api('put', `/cams-instances/${i.id}/routes/${px.id}`, { url, hidden: false })).status).toBe(200);
      return i;
    };
    const incluster = await inst('incluster', 'http://cam-proxy.cam-proxy.svc.cluster.local:8480');
    await inst('direct', null);
    await inst('local', 'http://127.0.0.1:8480');
    const detail = async () => (await a.api('get', `/accounts/${acc}/proxies/${px.id}/status`)).body;
    const diag = () => diagProxies({ ...a, serverKeyFingerprints: [a.signing.fingerprint] } as never).items.find((x) => x.id === px.id)!;
    expect((await detail()).plainHttpRoutes).toEqual([{ instanceId: incluster.id, name: 'incluster', displayName: 'INCLUSTER', url: 'http://cam-proxy.cam-proxy.svc.cluster.local:8480' }]);
    expect(diag().pinsNotSentTo).toEqual([]);
    const cur = (await detail()).proxy;
    expect((await a.api('patch', `/accounts/${acc}/proxies/${px.id}`, { caFingerprints: [`SHA256:${'AB'.repeat(32)}`], version: cur.version })).status).toBe(200);
    expect(diag().pinsNotSentTo).toEqual([{ instanceId: incluster.id, name: 'incluster', url: 'http://cam-proxy.cam-proxy.svc.cluster.local:8480' }]);
  });
});
