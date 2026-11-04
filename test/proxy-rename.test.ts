// A proxy's short name is a label. Everything that matters goes by its id: a rename leaves enrollment, keys, tokens,
// routes, cameras and moves alone (the safety check behind allowing it; the snapshot side is in cams-snapshot.test.ts).
import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { validProxyName } from '../web/src/lib/proxy';

const a = testApp(tmpDir());
afterAll(() => a.close());
const ACTOR = 'admin@example.com';
const acc = a.registry.createAccount(ACTOR, { name: 'home', displayName: 'Home' }).id;
const other = a.registry.createAccount(ACTOR, { name: 'away', displayName: 'Away' }).id;

const rows = (sql: string, id: string) => a.db.prepare(sql).all(id);

describe('renaming a proxy', () => {
  it('changes the name and nothing that goes by the id', async () => {
    const p = a.registry.createProxy(ACTOR, acc, { name: 'before', displayName: 'Before', runsOn: 'local-host', url: 'https://proxy.example.net:8480' }).id;
    const cam = a.registry.createCamera(ACTOR, acc, { camsId: 'cam1', name: 'Yard', kind: 'camera', proxyId: p, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https' }).id;
    const inst = a.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [acc] }).id;
    a.camsInstances.setRoute(ACTOR, inst, p, { url: null, hidden: false });
    a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at) VALUES ('key_1', ?, 'pub', 'SHA256:AA', 1)`).run(p);
    a.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES ('tok_1',?,?,'client','manual','seeded',?,'active',1,1,'x')`).run(acc, p, `sha256:${'a'.repeat(64)}`);
    a.enrollment.createCode(ACTOR, acc, p, 24);
    const exportBody = async () => (await a.api('get', `/accounts/${acc}/export?instance=${inst}`)).body;
    const exportedBefore = await exportBody();
    const tied = () => ({
      keys: rows('SELECT * FROM proxy_keys WHERE proxy_id = ?', p),
      tokens: rows('SELECT * FROM proxy_tokens WHERE proxy_id = ?', p),
      codes: rows('SELECT * FROM enrollment_codes WHERE proxy_id = ?', p),
      routes: rows('SELECT * FROM cams_instance_routes WHERE proxy_id = ?', p),
      camera: a.registry.getCamera(acc, cam),
    });
    const before = tied();
    expect(before.keys).toHaveLength(1);
    const r = await a.api('patch', `/accounts/${acc}/proxies/${p}`, { name: 'after', version: a.registry.getProxy(acc, p).version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: p, name: 'after', displayName: 'Before', url: 'https://proxy.example.net:8480' });
    expect(tied()).toEqual(before);
    // Nothing in the export goes by the proxy's name: the same file before and after.
    expect(await exportBody()).toEqual(exportedBefore);
  });

  it('a name is unique per account only, as when it was created', async () => {
    const p1 = a.registry.createProxy(ACTOR, acc, { name: 'one', displayName: 'One', runsOn: 'local-host' });
    a.registry.createProxy(ACTOR, acc, { name: 'two', displayName: 'Two', runsOn: 'local-host' });
    a.registry.createProxy(ACTOR, other, { name: 'three', displayName: 'Three', runsOn: 'local-host' });
    expect((await a.api('patch', `/accounts/${acc}/proxies/${p1.id}`, { name: 'two', version: p1.version })).status).toBe(409);
    expect((await a.api('patch', `/accounts/${acc}/proxies/${p1.id}`, { name: 'three', version: p1.version })).status).toBe(200);
  });

  it('the page\'s name rule is the server\'s', () => {
    const p = a.registry.createProxy(ACTOR, acc, { name: 'rule', displayName: 'Rule', runsOn: 'local-host' });
    let version = p.version;
    for (const name of ['a', 'pi', 'mini-pc', '1a', 'a'.repeat(32), 'a'.repeat(33), 'Pi', '-a', 'a b', 'a_b', 'é', '']) {
      let accepted = true;
      try { version = a.registry.updateProxy(ACTOR, acc, p.id, { name, version }).version; } catch { accepted = false; }
      expect(validProxyName(name), name).toBe(accepted);
    }
  });
});
