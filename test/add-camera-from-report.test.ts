// Finding 12b (account move 2026-11-08): Add camera with a proxy left host and protocol null, and cams refused the whole
// account part (snapshot_invalid). Host, protocol and TLS name now come from the proxy's report of that camera when
// the request leaves them out; given values win.
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const built: { close(): Promise<void> }[] = [];
afterEach(async () => { while (built.length) await built.pop()!.close(); });

describe('Add camera takes host, protocol and TLS name from the proxy report', () => {
  const dir = tmpDir();
  async function setup(o: { site?: boolean; truncated?: boolean } = {}) {
    const a = testApp(dir);
    built.push(a);
    const acc = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    const p = (await a.api('post', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', hostKind: 'pi' })).body;
    a.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    const summary = makeSummary({ cameras: 2, now: Date.now(), site: o.site });
    if (o.truncated) for (const c of summary.cameras as Record<string, unknown>[]) for (const k of Object.keys(c)) if (k !== 'camera' && k !== 'items') delete c[k];
    a.status.heartbeat(p.id, { summary, proxy: makeProxyInfo({ now: Date.now() }), truncated: o.truncated === true }, Date.now());
    const add = (body: Record<string, unknown>) => a.api('post', `/accounts/${acc.id}/cameras`, { kind: 'camera', proxyId: p.id, ...body });
    return { a, acc, p, add };
  }

  it('a site-CA camera: host = reported address, https, TLS name = the cert servername', async () => {
    const { add, a, acc, p } = await setup({ site: true });
    const c = (await add({ camsId: 'cam1', name: 'Gate', proxyCameraId: 'cam1' })).body;
    expect(c).toMatchObject({ host: '192.0.2.10', protocol: 'https', tlsServername: 'cam1.garage.internal' });
    // The proxy's status answer carries them too, for the form.
    const st = (await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/status`)).body;
    expect(st.reported.cameras.find((x: { ref: string }) => x.ref === 'cam2')).toMatchObject({ address: '192.0.2.11', protocol: 'https', tlsName: 'cam2.garage.internal' });
  });

  it('given values win; an http camera (no cert) gets http and no TLS name', async () => {
    const { add } = await setup();
    expect((await add({ camsId: 'cam1', name: 'Gate', proxyCameraId: 'cam1' })).body).toMatchObject({ host: '192.0.2.10', protocol: 'http', tlsServername: null });
    expect((await add({ camsId: 'cam2', name: 'Yard', proxyCameraId: 'cam2', host: '192.0.2.99', protocol: 'https', tlsServername: 'yard.example.net' })).body)
      .toMatchObject({ host: '192.0.2.99', protocol: 'https', tlsServername: 'yard.example.net' });
  });

  it('nothing reported (a truncated summary, an unknown camera, no proxy): nothing filled', async () => {
    const t = await setup({ truncated: true });
    expect((await t.add({ camsId: 'cam1', name: 'Gate', proxyCameraId: 'cam1' })).body).toMatchObject({ host: '192.0.2.10', protocol: null, tlsServername: null });
    expect((await t.add({ camsId: 'cam9', name: 'Other', proxyCameraId: 'cam9' })).body).toMatchObject({ host: null, protocol: null });
    expect((await t.a.api('post', `/accounts/${t.acc.id}/cameras`, { camsId: 'lone', name: 'Lone', kind: 'camera' })).body).toMatchObject({ host: null, protocol: null, proxyId: null });
  });

  // Finding 22: the form's hint says the camera's own name replaces the typed one, so behind a proxy the name is optional.
  it('behind a proxy the name is optional: the reported name, else the cams id; without a proxy it stays required', async () => {
    const { add, a, acc } = await setup();
    expect((await add({ camsId: 'gate', proxyCameraId: 'cam1' })).body).toMatchObject({ name: 'Camera 1' });
    expect((await add({ camsId: 'yard', name: '', proxyCameraId: 'cam2' })).body).toMatchObject({ name: 'Camera 2' });
    // A typed name wins.
    expect((await add({ camsId: 'porch', name: 'Porch', proxyCameraId: 'cam8' })).body).toMatchObject({ name: 'Porch' });
    // Not reported by the proxy: the cams id.
    expect((await add({ camsId: 'shed', proxyCameraId: 'cam9' })).body).toMatchObject({ name: 'shed' });
    // No proxy: no report will come, the name stays required.
    for (const body of [{ camsId: 'lone', kind: 'camera' }, { camsId: 'lone', kind: 'camera', name: '' }]) {
      const r = await a.api('post', `/accounts/${acc.id}/cameras`, body);
      expect(r.status).toBe(400);
    }
  });
});
