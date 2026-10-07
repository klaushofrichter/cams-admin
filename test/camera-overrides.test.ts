import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, snapshotRevision, type SnapshotDeps } from '../server/cams/snapshot';
import { exportForInstance } from '../server/import/export';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { strictCamsErrors, strictCamsValidator } from './helpers/contract';

// Per-instance camera overrides (migration 7): a cams instance may reach a
// camera at another host or with another camera user than the shared
// registry values (the cluster at the camera's LAN address with user "cams",
// the Pi through its local proxy, "from-proxy" with user "proxy").
describe('camera overrides per cams instance', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());
  let home: any, beta: any, pi: any, b1: any, cam1: any, cam2: any, bcam: any, cluster: any, piInst: any, betaOnly: any;
  let d: SnapshotDeps;
  const cams = (instanceId: string, account = 'home') => buildSnapshot(d, instanceId).accounts.find((x) => x.name === account)!.cameras;
  const lastAudit = () => a.audit.list({ limit: 1 }).items[0];

  beforeAll(async () => {
    d = { db: a.db, clock: a.clock, signingKey: a.signing.key, signingFingerprint: a.signing.fingerprint };
    home = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    beta = (await a.api('post', '/accounts', { name: 'beta', displayName: 'Beta' })).body;
    pi = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' })).body;
    b1 = (await a.api('post', `/accounts/${beta.id}/proxies`, { name: 'b1', displayName: 'B1', runsOn: 'cloud', url: 'https://b1.example.net' })).body;
    cam1 = (await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'cam1', name: 'Backyard', kind: 'camera', proxyId: pi.id, proxyCameraId: 'cam1', host: '192.0.2.164', protocol: 'https', cameraUser: 'cams' })).body;
    cam2 = (await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'cam2', name: 'Loose', kind: 'camera', host: '192.0.2.31', cameraUser: 'cams' })).body;
    bcam = (await a.api('post', `/accounts/${beta.id}/cameras`, { camsId: 'g1', name: 'Gate', kind: 'camera', proxyId: b1.id, proxyCameraId: 'g1', host: '192.0.2.50', cameraUser: 'cams' })).body;
    cluster = (await a.api('post', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home.id] })).body;
    piInst = (await a.api('post', '/cams-instances', { name: 'pi', displayName: 'Pi', accounts: [home.id] })).body;
    betaOnly = (await a.api('post', '/cams-instances', { name: 'beta-only', displayName: 'Beta only', accounts: [beta.id] })).body;
    await a.api('put', `/cams-instances/${cluster.id}/routes/${pi.id}`, { url: null, hidden: false });
    await a.api('put', `/cams-instances/${piInst.id}/routes/${pi.id}`, { url: 'http://127.0.0.1:8480', hidden: false });
  });

  it('the table: STRICT, one row per (instance, camera), at least one value; gone with the camera or the instance', () => {
    const t = a.db.prepare(`SELECT strict FROM pragma_table_list WHERE name = 'cams_camera_overrides'`).get() as { strict: number };
    expect(t.strict).toBe(1);
    const fks = a.db.prepare(`SELECT "table", on_delete FROM pragma_foreign_key_list('cams_camera_overrides') ORDER BY "table"`).all();
    expect(fks).toEqual([{ table: 'cameras', on_delete: 'CASCADE' }, { table: 'cams_instances', on_delete: 'CASCADE' }]);
    expect(() => a.db.prepare(`INSERT INTO cams_camera_overrides (instance_id, camera_id, host, camera_user, created_at, updated_at) VALUES (?, ?, NULL, NULL, 1, 1)`).run(piInst.id, cam1.id)).toThrow(/CHECK/);
  });

  it('PUT sets an override (audited, version 1); the instance\'s snapshot carries it, the other instance\'s does not; the contract shape is unchanged', async () => {
    const before = snapshotRevision(a.db, cluster.id, d.signingFingerprint);
    const piRev = snapshotRevision(a.db, piInst.id, d.signingFingerprint);
    const r = await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: 'proxy' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ instanceId: piInst.id, cameraId: cam1.id, accountId: home.id, camsId: 'cam1', host: 'from-proxy', cameraUser: 'proxy', version: 1 });
    expect(lastAudit()).toMatchObject({ action: 'camera-override-set', accountId: home.id, targetType: 'cams-instance', targetId: piInst.id, detail: { camera: 'cam1', host: { from: null, to: 'from-proxy' }, cameraUser: { from: null, to: 'proxy' } } });
    expect(cams(piInst.id).find((c) => c.camsId === 'cam1')).toMatchObject({ host: 'from-proxy', cameraUser: 'proxy', protocol: 'https' });
    expect(cams(cluster.id).find((c) => c.camsId === 'cam1')).toMatchObject({ host: '192.0.2.164', cameraUser: 'cams' });
    // Only the pi instance's revision moves (cams re-pulls and holds the new host until confirmed).
    expect(snapshotRevision(a.db, piInst.id, d.signingFingerprint)).not.toBe(piRev);
    expect(snapshotRevision(a.db, cluster.id, d.signingFingerprint)).toBe(before);
    expect(strictCamsValidator('snapshot')(buildSnapshot(d, piInst.id)), strictCamsErrors()).toBe(true);
    // The shared camera is untouched.
    expect((await a.api('get', `/accounts/${home.id}/cameras/${cam1.id}`)).body).toMatchObject({ host: '192.0.2.164', cameraUser: 'cams' });
  });

  it('GET lists the instance\'s overrides with the shared values beside them', async () => {
    const r = await a.api('get', `/cams-instances/${piInst.id}/camera-overrides`);
    expect(r.body.items).toEqual([expect.objectContaining({ cameraId: cam1.id, camsId: 'cam1', accountName: 'home', name: 'Backyard', host: 'from-proxy', cameraUser: 'proxy', sharedHost: '192.0.2.164', sharedCameraUser: 'cams', version: 1 })]);
    expect((await a.api('get', `/cams-instances/${cluster.id}/camera-overrides`)).body.items).toEqual([]);
  });

  it('a change is version-checked: a stale or missing version is 409 conflict; a null field inherits the camera\'s value', async () => {
    expect((await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: 'x' })).body.error).toBe('conflict');
    expect((await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: 'x', version: 7 })).status).toBe(409);
    const r = await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: null, version: 1 });
    expect(r.body).toMatchObject({ host: 'from-proxy', cameraUser: null, version: 2 });
    expect(cams(piInst.id).find((c) => c.camsId === 'cam1')).toMatchObject({ host: 'from-proxy', cameraUser: 'cams' });
    // Both null: that is a clear (DELETE), not an override.
    expect((await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: null, cameraUser: null, version: 2 })).body).toMatchObject({ error: 'invalid', field: 'host' });
    await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: 'proxy', version: 2 });
  });

  it('values are validated like the camera\'s own: host = hostname or IP with an optional port, or from-proxy; user ≤ 64 characters', async () => {
    const put = (body: object) => a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${cam2.id}`, body);
    for (const host of ['http://192.0.2.1', 'a b', 'x'.repeat(254), '192.0.2.1:99999', 'host/path', 7]) expect((await put({ host })).body, String(host)).toMatchObject({ error: 'invalid', field: 'host' });
    for (const cameraUser of [' ', 'u'.repeat(65), 5]) expect((await put({ host: '192.0.2.9', cameraUser })).body, String(cameraUser)).toMatchObject({ error: 'invalid', field: 'cameraUser' });
    expect((await put({ host: 'x', other: 1 })).body).toMatchObject({ error: 'invalid', field: 'other' });
    for (const host of ['192.0.2.9', 'cam.example.net:8443', 'from-proxy']) {
      const r = await put({ host, version: (await a.api('get', `/cams-instances/${piInst.id}/camera-overrides`)).body.items.find((x: any) => x.cameraId === cam2.id)?.version });
      expect(r.status, `${host} ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await a.api('delete', `/cams-instances/${piInst.id}/camera-overrides/${cam2.id}`)).status).toBe(204);
  });

  it('only for a camera of an account the instance serves: another account\'s camera is 404 (no write, no leak)', async () => {
    const n = a.audit.list({ limit: 200 }).items.length;
    expect((await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${bcam.id}`, { host: '192.0.2.99' })).status).toBe(404);
    expect((await a.api('put', `/cams-instances/${betaOnly.id}/camera-overrides/${cam1.id}`, { host: '192.0.2.99' })).status).toBe(404);
    expect((await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/cam_NOPE`, { host: '192.0.2.99' })).status).toBe(404);
    expect((await a.api('put', `/cams-instances/cms_NOPE/camera-overrides/${cam1.id}`, { host: '192.0.2.99' })).status).toBe(404);
    expect(a.audit.list({ limit: 200 }).items.length).toBe(n);
    expect(JSON.stringify(buildSnapshot(d, betaOnly.id))).not.toContain('192.0.2.99');
  });

  it('the Export for an instance carries its overrides (file mode reaches the camera the same way)', () => {
    const dd = { db: a.db, registry: a.registry, instances: a.camsInstances };
    expect(exportForInstance(dd, home.id, piInst.id).cameras.find((c: any) => c.id === 'cam1')).toMatchObject({ host: 'from-proxy', user: 'proxy' });
    expect(exportForInstance(dd, home.id, cluster.id).cameras.find((c: any) => c.id === 'cam1')).toMatchObject({ host: '192.0.2.164', user: 'cams' });
  });

  it('DELETE clears it (audited); the camera\'s value applies again; a second DELETE is 404', async () => {
    const r = await a.api('delete', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`);
    expect(r.status).toBe(204);
    expect(lastAudit()).toMatchObject({ action: 'camera-override-clear', targetId: piInst.id, detail: { camera: 'cam1', host: 'from-proxy', cameraUser: 'proxy' } });
    expect(cams(piInst.id).find((c) => c.camsId === 'cam1')).toMatchObject({ host: '192.0.2.164', cameraUser: 'cams' });
    expect((await a.api('delete', `/cams-instances/${piInst.id}/camera-overrides/${cam1.id}`)).status).toBe(404);
  });

  it('deleting the camera or the instance takes its overrides with it', async () => {
    const tmpCam = (await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'tmp', name: 'Tmp', kind: 'camera', host: '192.0.2.70' })).body;
    const tmpInst = (await a.api('post', '/cams-instances', { name: 'tmp', displayName: 'Tmp', accounts: [home.id] })).body;
    await a.api('put', `/cams-instances/${tmpInst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy' });
    await a.api('put', `/cams-instances/${piInst.id}/camera-overrides/${tmpCam.id}`, { host: '192.0.2.71' });
    const n = () => (a.db.prepare('SELECT count(*) n FROM cams_camera_overrides').get() as { n: number }).n;
    expect(n()).toBe(2);
    await a.api('delete', `/accounts/${home.id}/cameras/${tmpCam.id}`);
    await a.api('delete', `/cams-instances/${tmpInst.id}`, { confirmName: 'tmp' });
    expect(n()).toBe(0);
  });
});
