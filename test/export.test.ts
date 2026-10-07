import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { exportForInstance } from '../server/import/export';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

const schema = JSON.parse(readFileSync(join(__dirname, 'fixtures/import/cameras-file.schema.json'), 'utf8'));
const validCamerasFile = new Ajv2020({ strict: false }).compile(schema);

describe('the Export (M §11.6): a cameras.json for file mode', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());
  let home: any, pi: any, cluster: any, cluster2: any, piInst: any, clusterInst: any;

  beforeAll(async () => {
    home = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    pi = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480', caFingerprints: ['ab'.repeat(32)] })).body;
    cluster = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster', url: 'https://cluster.example.net', tlsServername: 'cluster.example.net' })).body;
    cluster2 = (await a.api('post', `/accounts/${home.id}/proxies`, { name: 'nourl', displayName: 'No URL', runsOn: 'cloud' })).body;
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'cam1', name: 'Yard', kind: 'camera', proxyId: pi.id, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https', cameraUser: 'cams' });
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'cam2', name: 'Drive', kind: 'camera', proxyId: cluster.id, proxyCameraId: 'cam2', host: '192.0.2.31', protocol: 'https', tlsServername: 'cam2.example.net', cameraUser: 'cams', webUiUrl: 'https://192.0.2.31', webUiNote: 'LAN only' });
    await a.api('post', `/accounts/${home.id}/cameras`, { camsId: 'cam3', name: 'Lost', kind: 'camera', proxyId: cluster2.id, proxyCameraId: 'cam3', host: '192.0.2.33', cameraUser: 'cams' });
    clusterInst = (await a.api('post', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home.id] })).body;
    piInst = (await a.api('post', '/cams-instances', { name: 'pi', displayName: 'Pi', accounts: [home.id] })).body;
    await a.api('put', `/cams-instances/${piInst.id}/routes/${pi.id}`, { url: 'http://127.0.0.1:8480', hidden: false });
    await a.api('put', `/cams-instances/${piInst.id}/routes/${cluster.id}`, { url: null, hidden: true });
    a.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES ('tok_00000000000000000001',?,?,'client',?,'cams cluster',?,'active',1,1,'x')`)
      .run(home.id, pi.id, clusterInst.id, 'sha256:' + 'c'.repeat(64));
  });

  it('per instance: its route URL, hidden proxies left out, pins and names as registered; no password, token or hash', () => {
    const d = { db: a.db, registry: a.registry, instances: a.camsInstances };
    const c = exportForInstance(d, home.id, clusterInst.id);
    expect(c.cameras.map((x: any) => [x.id, x.proxy?.url ?? null])).toEqual([['cam1', 'https://proxy.example.net:8480'], ['cam2', 'https://cluster.example.net'], ['cam3', null]]);
    expect(c.cameras[0]).toEqual({ id: 'cam1', name: 'Yard', host: 'from-proxy', protocol: 'https', user: 'cams', proxy: { url: 'https://proxy.example.net:8480', camera: 'cam1', caFingerprint: ['SHA256:' + 'AB'.repeat(32)] } });
    expect(c.cameras[1]).toMatchObject({ tlsServername: 'cam2.example.net', webUiUrl: 'https://192.0.2.31', webUiNote: 'LAN only', proxy: { tlsServername: 'cluster.example.net' } });
    expect(c.tokens).toEqual([{ proxyId: pi.id, tokenId: 'tok_00000000000000000001', kind: 'client', state: 'active' }]);
    const p = exportForInstance(d, home.id, piInst.id);
    expect(p.cameras.map((x: any) => [x.id, x.proxy?.url ?? null])).toEqual([['cam1', 'http://127.0.0.1:8480'], ['cam3', null]]);
    expect(p.tokens).toEqual([]);
    const all = JSON.stringify([c, p]);
    expect(all).not.toMatch(/"password"|"token"|"adminToken"|sha256:/);
  });

  it('round-trips through cams\'s parseCameras rules once a password and a token are added (proxies without a URL are listed, not exported)', () => {
    const c = exportForInstance({ db: a.db, registry: a.registry, instances: a.camsInstances }, home.id, clusterInst.id);
    const file = c.cameras.map((x: any) => ({ ...x, password: 'placeholder-password', ...(x.proxy ? { proxy: { ...x.proxy, token: 'p'.repeat(43) } } : {}) }));
    expect(validCamerasFile(file), JSON.stringify(validCamerasFile.errors)).toBe(true);
    expect(c.warnings).toEqual(['cam3: its proxy nourl has no URL for this instance (exported without a proxy)']);
  });

  it('GET /accounts/:id/export?instance=… answers an attachment and is audited export-run; an unserved instance is 400', async () => {
    const r = await a.api('get', `/accounts/${home.id}/export?instance=${clusterInst.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="cameras-home-cluster\.json"$/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.cameras).toHaveLength(3);
    expect(a.audit.list({ action: 'export-run' }).items[0]).toMatchObject({ accountId: home.id, targetId: clusterInst.id });
    const other = (await a.api('post', '/accounts', { name: 'beta', displayName: 'Beta' })).body;
    expect((await a.api('get', `/accounts/${other.id}/export?instance=${clusterInst.id}`)).status).toBe(400);
  });

  it('POST /accounts/:id/import runs the importer (dry run) and answers its result', async () => {
    const file = JSON.parse(readFileSync(join(__dirname, 'fixtures/import/cluster.json'), 'utf8'));
    const r = await a.api('post', `/accounts/${home.id}/import`, { instanceId: clusterInst.id, file });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, applied: false, account: 'home', instance: 'cluster' });
    const bad = await a.api('post', `/accounts/${home.id}/import`, { instanceId: clusterInst.id, file: { ...file, cameras: [{ ...file.cameras[0], password: 'x' }] } });
    expect([bad.status, bad.body.error]).toEqual([400, 'invalid']);
  });
});
