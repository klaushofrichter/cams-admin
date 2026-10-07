import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readEpoch } from '../server/db/open';
import { CamsInstances } from '../server/cams/instances';
import { Importer, parseCamsExport, type ImportResult } from '../server/import/importer';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { generateKeyPairSync } from 'crypto';
import { buildSnapshot } from '../server/cams/snapshot';

const load = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures/import', `${n}.json`), 'utf8'));
const CLUSTER = load('cluster');
const PI = load('pi');
// Cut-over step 6, synthesized (RFC 5737 / RFC 2606 values, no real tokens): the cluster's cams
// reaches cam1 at the camera's address with user "cams", the Pi's cams through its proxy.
const CUT_CLUSTER = load('cutover-cluster');
const CUT_PI = load('cutover-pi');
const SIGNING = generateKeyPairSync('ed25519').privateKey;
const PIN = 'SHA256:' + 'AB'.repeat(32);
const H = (c: string) => 'sha256:' + c.repeat(64);
const DRY = { apply: false, acceptMismatch: [] as string[], createProxies: false, hideUnlisted: false };
const APPLY = { ...DRY, apply: true };
const kinds = (r: ImportResult, k: string) => r.changes.filter((c) => c.kind === k) as any[];

describe('the importer (M §11.2)', () => {
  const dir = tmpDir();
  let r: ReturnType<typeof makeRegistry>;
  let status: StatusStore;
  let inst: CamsInstances;
  let imp: Importer;
  let home: any, piProxy: any, clusterProxy: any, cluster: any, pi: any;
  const db = () => r.db;
  const manual = (id: string, proxy: any, hash: string, kind = 'client') =>
    r.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,?,'manual','cams',?,'active',1,1,'a@example.com')`).run(id, proxy.accountId, proxy.id, kind, hash);
  const beat = (proxy: any, cameras: string[], fps: string[] | null) => {
    const s = makeSummary({ cameras: cameras.length, now: r.clock.now() });
    s.cameras.forEach((c: any, i: number) => { c.camera.id = cameras[i]; });
    status.hello(proxy.id, 'v1', r.clock.now(), ['status']);
    status.heartbeat(proxy.id, { summary: s, proxy: makeProxyInfo({ now: r.clock.now(), site: fps ? 'home' : null, caFingerprint: fps ?? undefined }), truncated: false }, r.clock.now());
  };

  // Apply is bound to the dry run shown (review M2): a dry run with the same options, then apply with its planId.
  const applyRun = (acc: string, i: string, file: unknown, o: typeof APPLY & Record<string, unknown>) => {
    const d = imp.run(ACTOR, acc, i, file, { ...o, apply: false });
    return imp.run(ACTOR, acc, i, file, { ...o, apply: true, planId: d.planId });
  };

  beforeEach(() => {
    r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 });
    status = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000, snapshotMs: 600_000 });
    inst = new CamsInstances({ db: r.db, clock: r.clock, audit: r.audit, registry: r.reg, cfg: { publicUrl: 'https://admin.example.org', enrollCodeDefaultH: 24 }, serverKeys: ['pk'], serverKeyFingerprints: ['SHA256:' + '00'.repeat(32)], onRevoke: () => {} });
    imp = new Importer({ db: r.db, clock: r.clock, audit: r.audit, registry: r.reg, instances: inst, status });
    home = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    piProxy = r.reg.createProxy(ACTOR, home.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
    clusterProxy = r.reg.createProxy(ACTOR, home.id, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster', url: 'https://cluster-proxy.example.net' });
    r.db.prepare(`UPDATE proxies SET state = 'enrolled'`).run();
    // The P2 manual tokens of cut-over steps 1–2.
    manual('tok_00000000000000000001', piProxy, H('1'));
    manual('tok_00000000000000000002', piProxy, H('2'), 'admin');
    manual('tok_00000000000000000003', clusterProxy, H('3'));
    manual('tok_00000000000000000004', piProxy, H('4'));
    beat(piProxy, ['cam1'], [PIN]);
    beat(clusterProxy, ['cam1', 'cam2'], null);
    status.flush(true);
    cluster = inst.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [home.id] });
    pi = inst.create(ACTOR, { name: 'pi', displayName: 'Pi', accounts: [home.id] });
  });

  it('dry run by default: proxies matched by token hash, cameras new, pins set, nothing written but the import-run record', () => {
    const e = readEpoch(db());
    const res = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(kinds(res, 'proxy-matched').map((c) => [c.name, c.by])).toEqual([['pi', 'token'], ['cluster', 'token']]);
    expect(kinds(res, 'camera-new').map((c) => c.camsId)).toEqual(['cam1', 'cam2']);
    expect(kinds(res, 'camera-new')[1].fields).toMatchObject({ proxyId: clusterProxy.id, proxyCameraId: 'cam2', host: '192.0.2.31', tlsServername: 'cam2.example.net', cameraUser: 'cams', webUiNote: 'LAN only' });
    expect(kinds(res, 'pins-set')).toEqual([{ kind: 'pins-set', proxyId: piProxy.id, name: 'pi', from: [], to: [PIN] }]);
    // Routes are default-deny: the file's proxies get a route at their registered URL (url null; a trailing slash is the same URL).
    expect(kinds(res, 'route-add').map((c) => [c.name, c.url])).toEqual([['pi', null], ['cluster', null]]);
    expect(res).toMatchObject({ dryRun: true, applied: false, blocked: false, noChanges: false, mismatches: [] });
    expect(readEpoch(db())).toBe(e + 1);
    expect(r.audit.list({ limit: 1 }).items[0]).toMatchObject({ action: 'import-run', outcome: 'ok' });
  });

  it('apply writes everything in one transaction with one import-apply record; a second apply shows noChanges', () => {
    const e = readEpoch(db());
    const a = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(a).toMatchObject({ applied: true, dryRun: false });
    expect(readEpoch(db())).toBe(e + 2); // the dry run's import-run record + the apply transaction
    expect(r.reg.listCameras(home.id).map((c) => [c.camsId, c.proxyId])).toEqual([['cam1', piProxy.id], ['cam2', clusterProxy.id]]);
    expect(r.reg.getProxy(home.id, piProxy.id).caFingerprints).toEqual([PIN]);
    expect(r.audit.list({ action: 'import-apply' }).items).toHaveLength(1);
    const again = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(again).toMatchObject({ noChanges: true, applied: false });
    expect(again.changes.every((c) => c.kind === 'proxy-matched' || c.kind === 'registry-only')).toBe(true);
  });

  it('the Pi file after the cluster file: a loopback route for the pi instance only, the registered URL unchanged, nothing deleted', () => {
    applyRun(home.id, cluster.id, CLUSTER, APPLY);
    const res = applyRun(home.id, pi.id, PI, { ...APPLY, hideUnlisted: true });
    expect(res.applied).toBe(true);
    expect(res.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'route-add', proxyId: piProxy.id, url: 'http://127.0.0.1:8480' }),
      expect.objectContaining({ kind: 'registry-only', camsId: 'cam2' }),
    ]));
    expect(kinds(res, 'camera-change')).toEqual([]);
    expect(r.reg.getProxy(home.id, piProxy.id).url).toBe('https://proxy.example.net:8480');
    expect(kinds(res, 'route-hide')).toEqual([]); // the cluster proxy has no route for the Pi: it stays invisible (default-deny)
    expect(inst.routes(pi.id).map((x) => [x.proxyId, x.url, x.hidden])).toEqual([[piProxy.id, 'http://127.0.0.1:8480', false]]);
    expect(inst.routes(cluster.id).map((x) => [x.proxyId, x.url, x.hidden])).toEqual(expect.arrayContaining([[piProxy.id, null, false], [clusterProxy.id, null, false]]));
    expect(r.reg.listCameras(home.id)).toHaveLength(2);
    expect(applyRun(home.id, pi.id, PI, { ...APPLY, hideUnlisted: true }).noChanges).toBe(true);
  });

  it('a changed camera is listed field by field and applied', () => {
    applyRun(home.id, cluster.id, CLUSTER, APPLY);
    const f = structuredClone(CLUSTER);
    f.cameras[1].name = 'Front';
    f.cameras[1].host = '192.0.2.32';
    const res = applyRun(home.id, cluster.id, f, APPLY);
    expect(kinds(res, 'camera-change')).toEqual([{ kind: 'camera-change', cameraId: expect.stringMatching(/^cam_/), camsId: 'cam2', fields: { name: { from: 'Driveway', to: 'Front' }, host: { from: '192.0.2.31', to: '192.0.2.32' } } }]);
    expect(r.reg.listCameras(home.id).find((c) => c.camsId === 'cam2')).toMatchObject({ name: 'Front', host: '192.0.2.32' });
  });

  it('proxy groups follow cams\'s rule: same url + token hash = one proxy; one url with two tokens is two groups', () => {
    const f = structuredClone(CLUSTER);
    f.cameras.push({ ...structuredClone(f.cameras[1]), id: 'cam3', proxy: { ...f.cameras[1].proxy, camera: 'cam3' } });
    f.cameras.push({ ...structuredClone(f.cameras[1]), id: 'cam4', proxy: { ...f.cameras[1].proxy, camera: 'cam4', token: { sha256: '9'.repeat(64) } } });
    const res = imp.run(ACTOR, home.id, cluster.id, f, { ...DRY, acceptMismatch: [] });
    expect(kinds(res, 'proxy-matched').map((c) => [c.name, c.by])).toEqual([['pi', 'token'], ['cluster', 'token'], ['cluster', 'url']]);
    expect(kinds(res, 'token-external').map((c) => c.hashPrefix)).toEqual(['sha256:99999999']);
  });

  it('cross-check: a proxy.camera not in the proxy\'s reported cameras, a pin that differs, an offline proxy → mismatches; apply blocked unless every id is accepted', () => {
    beat(piProxy, ['other'], ['SHA256:' + 'EF'.repeat(32)]);
    const res = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(res).toMatchObject({ blocked: true, applied: false });
    expect(res.mismatches.map((m) => [m.what, m.camsId ?? null])).toEqual(expect.arrayContaining([['camera-not-on-proxy', 'cam1'], ['pin-differs', null]]));
    expect(r.reg.listCameras(home.id)).toEqual([]);
    const again = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(again.mismatches.map((m) => m.id)).toEqual(res.mismatches.map((m) => m.id)); // stable ids
    const ok = applyRun(home.id, cluster.id, CLUSTER, { ...APPLY, acceptMismatch: res.mismatches.map((m) => m.id) });
    expect(ok.applied).toBe(true);
    r.clock.advance(120_000);
    status.tick();
    const off = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(off.mismatches.map((m) => m.what)).toContain('proxy-offline');
  });

  it('never deletes: a registry camera missing from the file is listed registry-only', () => {
    r.reg.createCamera(ACTOR, home.id, { camsId: 'old', name: 'Old', kind: 'camera' });
    const res = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(kinds(res, 'registry-only').map((c) => c.camsId)).toEqual(['old']);
    expect(r.reg.listCameras(home.id).map((c) => c.camsId)).toContain('old');
  });

  it('an unknown proxy without createProxies: listed proxy-new, apply blocked with unknown_proxy; with it: created as runs_on local-host, pending', () => {
    const f = structuredClone(CLUSTER);
    f.cameras[1].proxy = { url: 'https://new-proxy.example.net:8480', token: { sha256: '7'.repeat(64) }, camera: 'cam2' };
    const res = applyRun(home.id, cluster.id, f, APPLY);
    expect(kinds(res, 'proxy-new')).toEqual([{ kind: 'proxy-new', name: 'new-proxy', url: 'https://new-proxy.example.net:8480' }]);
    expect(res).toMatchObject({ blocked: true, applied: false, blockers: ['unknown_proxy'] });
    const ok = applyRun(home.id, cluster.id, f, { ...APPLY, createProxies: true });
    expect(ok.applied).toBe(true);
    const created = r.reg.listProxies(home.id).find((p) => p.name === 'new-proxy')!;
    expect(created).toMatchObject({ runsOn: 'local-host', state: 'pending', url: 'https://new-proxy.example.net:8480' });
    expect(r.reg.listCameras(home.id).find((c) => c.camsId === 'cam2')!.proxyId).toBe(created.id);
    expect(r.db.prepare(`SELECT state, holder, label FROM proxy_tokens WHERE proxy_id = ?`).all(created.id)).toEqual([{ state: 'external', holder: 'manual', label: 'imported new-proxy.example.net:8480' }]);
  });

  it('a hash of the file\'s token that is unknown is recorded as an external token; never sent in tokens.apply', () => {
    r.db.prepare(`DELETE FROM proxy_tokens WHERE id = 'tok_00000000000000000003'`).run();
    const res = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(kinds(res, 'token-external')).toEqual([{ kind: 'token-external', proxyId: clusterProxy.id, name: 'cluster', tokenKind: 'client', hashPrefix: 'sha256:33333333' }]);
    expect(r.db.prepare(`SELECT state, kind, label FROM proxy_tokens WHERE hash = ?`).get(H('3'))).toEqual({ state: 'external', kind: 'client', label: 'imported cluster-proxy.example.net' });
    expect(r.db.prepare(`SELECT count(*) n FROM commands`).get()).toEqual({ n: 0 });
  });

  it('parseCamsExport refuses a password field, a token in clear (a string), a hash that is not 64 hex, a wrong kind', () => {
    const bad = (mut: (f: any) => void) => {
      const f = structuredClone(CLUSTER);
      mut(f);
      return () => parseCamsExport(f);
    };
    expect(bad((f) => { f.cameras[0].password = 'x'; })).toThrow(expect.objectContaining({ status: 400 }));
    expect(bad((f) => { f.cameras[0].proxy.token = 'a'.repeat(43); })).toThrow(expect.objectContaining({ field: 'cameras[0].proxy.token' }));
    expect(bad((f) => { f.cameras[0].proxy.token = { sha256: 'abc' }; })).toThrow(expect.objectContaining({ status: 400 }));
    expect(bad((f) => { f.kind = 'other'; })).toThrow(expect.objectContaining({ field: 'kind' }));
    expect(bad((f) => { f.cameras[0].proxy.extra = { password: 'x' }; })).toThrow(expect.objectContaining({ status: 400 }));
    expect(parseCamsExport(CLUSTER).cameras).toHaveLength(2);
  });

  it('the diff and the audit detail carry only 8-hex hash prefixes (secret guard)', () => {
    r.db.prepare(`DELETE FROM proxy_tokens`).run();
    const res = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    const all = JSON.stringify(res) + JSON.stringify(r.db.prepare('SELECT detail FROM audit_log').all());
    for (const c of ['1', '2', '3']) expect(all).not.toContain(c.repeat(64));
    expect(all).not.toMatch(/[0-9a-f]{16}/);
  });

  it('the instance must serve the account', () => {
    const other = r.reg.createAccount(ACTOR, { name: 'beta', displayName: 'Beta' });
    expect(() => imp.run(ACTOR, other.id, cluster.id, CLUSTER, DRY)).toThrow(expect.objectContaining({ status: 400, field: 'instanceId' }));
  });

  it('a URL that only matches a route of another account never detaches the cameras: unknown_proxy blocks (review I2)', () => {
    const demo = r.reg.createAccount(ACTOR, { name: 'demo', displayName: 'Demo' });
    const demoPx = r.reg.createProxy(ACTOR, demo.id, { name: 'demo-pi', displayName: 'Demo Pi', runsOn: 'local-host', url: 'https://demo.example.net' });
    const both = inst.create(ACTOR, { name: 'both', displayName: 'Both', accounts: [home.id, demo.id] });
    inst.setRoute(ACTOR, both.id, demoPx.id, { url: 'http://127.0.0.1:8480', hidden: false });
    const f = structuredClone(PI);
    f.cameras[0].proxy.token = { sha256: '8'.repeat(64) }; // unknown here
    const res = applyRun(home.id, both.id, f, APPLY);
    expect(res).toMatchObject({ applied: false, blocked: true, blockers: ['unknown_proxy'] });
    expect(kinds(res, 'proxy-matched')).toEqual([]);
    expect(kinds(res, 'camera-new')[0].fields.proxyId).not.toBeNull();
    expect(r.reg.listCameras(home.id)).toEqual([]);
  });

  it('a group matching two proxies is a blocker that accepting cannot lift; no camera is ever imported without its proxy (review I2)', () => {
    r.db.prepare(`UPDATE proxies SET url = 'https://cluster-proxy.example.net' WHERE id = ?`).run(piProxy.id);
    r.db.prepare(`DELETE FROM proxy_tokens`).run();
    const res = applyRun(home.id, cluster.id, CLUSTER, APPLY);
    expect(res.blockers).toContain('proxy_ambiguous');
    const again = applyRun(home.id, cluster.id, CLUSTER, { ...APPLY, acceptMismatch: res.mismatches.map((m) => m.id), createProxies: true });
    expect(again).toMatchObject({ applied: false, blocked: true });
    expect(again.blockers).toContain('proxy_ambiguous');
    expect(r.reg.listCameras(home.id)).toEqual([]);
  });

  it('a token hash already held in another account is reported, not silently skipped (review M4)', () => {
    const other = r.reg.createAccount(ACTOR, { name: 'other', displayName: 'Other' });
    const op = r.reg.createProxy(ACTOR, other.id, { name: 'op', displayName: 'Op', runsOn: 'cloud' });
    r.db.prepare(`DELETE FROM proxy_tokens WHERE id = 'tok_00000000000000000003'`).run();
    manual('tok_00000000000000000009', op, H('3'));
    const res = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(res.mismatches.map((m) => m.what)).toContain('token-in-other-account');
    expect(kinds(res, 'token-external')).toEqual([]);
  });

  it('a second pin the proxy does not report is its own mismatch (review M9)', () => {
    const f = structuredClone(CLUSTER);
    f.cameras[0].proxy.caFingerprint = [PIN, 'SHA256:' + 'EE'.repeat(32)];
    const res = imp.run(ACTOR, home.id, cluster.id, f, DRY);
    expect(res.mismatches.map((m) => m.what)).toEqual(['pin-unverified']);
    expect(imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY).mismatches).toEqual([]);
  });

  it('Apply is bound to the dry run shown: same plan, same sysadmin, once, within 10 minutes (review M2)', () => {
    const d = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(d.planId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(() => imp.run(ACTOR, home.id, cluster.id, CLUSTER, APPLY)).toThrow(expect.objectContaining({ status: 409, code: 'plan_expired' }));
    // Options changed after the dry run: another plan.
    expect(() => imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, hideUnlisted: true, planId: d.planId })).toThrow(expect.objectContaining({ status: 409, code: 'plan_changed' }));
    const d2 = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(() => imp.run('other@example.com', home.id, cluster.id, CLUSTER, { ...APPLY, planId: d2.planId })).toThrow(expect.objectContaining({ code: 'plan_expired' }));
    const d3 = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    r.clock.advance(601_000);
    expect(() => imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, planId: d3.planId })).toThrow(expect.objectContaining({ code: 'plan_expired' }));
    const d4 = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    r.reg.createCamera(ACTOR, home.id, { camsId: 'between', name: 'B', kind: 'camera' }); // the registry changed meanwhile
    expect(() => imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, planId: d4.planId })).toThrow(expect.objectContaining({ code: 'plan_changed' }));
    const d5 = imp.run(ACTOR, home.id, cluster.id, CLUSTER, DRY);
    expect(imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, planId: d5.planId }).applied).toBe(true);
    expect(() => imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, planId: d5.planId })).toThrow(expect.objectContaining({ code: 'plan_expired' })); // once
  });
  describe('per-instance camera overrides (cut-over step 6)', () => {
    const snap = (i: any) => buildSnapshot({ db: r.db, clock: r.clock, signingKey: SIGNING, signingFingerprint: 'SHA256:' + '00'.repeat(32) }, i.id).accounts.map(({ revision: _r, ...a }) => a);
    const cam = (id: string) => snap({ id: pi.id }) && r.reg.listCameras(home.id).find((c) => c.camsId === id)!;
    const route = (i: any, px: any) => inst.routes(i.id).find((x) => x.proxyId === px.id);
    beforeEach(() => {
      manual('tok_00000000000000000005', piProxy, H('5'));
      manual('tok_00000000000000000006', piProxy, H('6'), 'admin');
      manual('tok_00000000000000000007', clusterProxy, H('7'));
      manual('tok_00000000000000000008', piProxy, H('8'));
    });

    it('the cluster file for cluster, then the Pi file for pi: the Pi\'s host and user become pi\'s overrides; the cluster\'s snapshot is unchanged; every second dry run is "No changes"', () => {
      expect(applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY).applied).toBe(true);
      expect(cam('cam1')).toMatchObject({ name: 'Backyard Left', host: '192.0.2.164', cameraUser: 'cams' });
      expect(route(cluster, clusterProxy)?.url).toBe('http://cam-proxy.cam-proxy.svc.cluster.test:8480');
      const clusterBefore = snap(cluster);
      const dry = imp.run(ACTOR, home.id, pi.id, CUT_PI, DRY);
      expect(dry).toMatchObject({ blocked: false, mismatches: [], looksLike: [] });
      expect(kinds(dry, 'camera-change')).toEqual([]);
      expect(kinds(dry, 'camera-override')).toEqual([{
        kind: 'camera-override', cameraId: cam('cam1').id, camsId: 'cam1', instance: 'pi',
        fields: { host: { from: '192.0.2.164', to: 'from-proxy', override: 'from-proxy' }, cameraUser: { from: 'cams', to: 'proxy', override: 'proxy' } },
      }]);
      expect(applyRun(home.id, pi.id, CUT_PI, APPLY).applied).toBe(true);
      expect(snap(cluster)).toEqual(clusterBefore);
      expect(snap(pi)[0].cameras).toEqual([expect.objectContaining({ camsId: 'cam1', host: 'from-proxy', cameraUser: 'proxy', protocol: 'https' })]);
      expect(snap(pi)[0].proxies.map((x: any) => [x.name, x.url])).toEqual([['pi', 'http://127.0.0.1:8480']]);
      expect(cam('cam1')).toMatchObject({ host: '192.0.2.164', cameraUser: 'cams' }); // the shared camera is untouched
      expect(r.audit.list({ action: 'camera-override-set' }).items).toHaveLength(1);
      // Second dry runs, both instances; the cluster file again after the Pi import.
      expect(imp.run(ACTOR, home.id, pi.id, CUT_PI, DRY).noChanges).toBe(true);
      expect(imp.run(ACTOR, home.id, cluster.id, CUT_CLUSTER, DRY).noChanges).toBe(true);
      expect(applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY)).toMatchObject({ noChanges: true, applied: false });
      expect(snap(cluster)).toEqual(clusterBefore);
    });

    it('the other order (the Pi file first): the cluster\'s values become the cluster\'s overrides; both second dry runs are "No changes"', () => {
      expect(applyRun(home.id, pi.id, CUT_PI, APPLY).applied).toBe(true);
      const piBefore = snap(pi);
      const res = applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
      expect(res.applied).toBe(true);
      expect(kinds(res, 'camera-override').map((c) => [c.camsId, c.instance, c.fields.host.to, c.fields.cameraUser.to])).toEqual([['cam1', 'cluster', '192.0.2.164', 'cams']]);
      expect(kinds(res, 'camera-new').map((c) => c.camsId)).toEqual(['cam2']);
      expect(snap(pi)).toEqual(piBefore);
      expect(snap(cluster)[0].cameras.map((c: any) => [c.camsId, c.host, c.cameraUser])).toEqual([['cam1', '192.0.2.164', 'cams'], ['cam2', 'cam2.cam-sim.svc.cluster.test', 'cams']]);
      expect(imp.run(ACTOR, home.id, pi.id, CUT_PI, DRY).noChanges).toBe(true);
      expect(imp.run(ACTOR, home.id, cluster.id, CUT_CLUSTER, DRY).noChanges).toBe(true);
    });

    it('a file with the camera\'s shared values again clears the instance\'s override; a camera no other instance serves still changes the shared value', () => {
      applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
      applyRun(home.id, pi.id, CUT_PI, APPLY);
      const back = structuredClone(CUT_PI);
      back.cameras[0].host = '192.0.2.164';
      back.cameras[0].user = 'cams';
      const res = applyRun(home.id, pi.id, back, APPLY);
      expect(kinds(res, 'camera-override')[0].fields).toEqual({ host: { from: 'from-proxy', to: '192.0.2.164', override: null }, cameraUser: { from: 'proxy', to: 'cams', override: null } });
      expect(inst.overrides(pi.id)).toEqual([]);
      expect(r.audit.list({ action: 'camera-override-clear' }).items).toHaveLength(1);
      // cam2 is only routed to the cluster: a new host there is the shared value.
      const moved = structuredClone(CUT_CLUSTER);
      moved.cameras[1].host = 'cam2b.cam-sim.svc.cluster.test';
      const m = applyRun(home.id, cluster.id, moved, APPLY);
      expect(kinds(m, 'camera-change').map((c) => [c.camsId, c.fields.host])).toEqual([['cam2', { from: 'cam2.cam-sim.svc.cluster.test', to: 'cam2b.cam-sim.svc.cluster.test' }]]);
      expect(kinds(m, 'camera-override')).toEqual([]);
    });

    it('a shared value that is still empty is filled in, never made an override (nothing to keep for the other instance)', () => {
      r.reg.createCamera(ACTOR, home.id, { camsId: 'cam1', name: 'Backyard Left', kind: 'camera', proxyId: piProxy.id, proxyCameraId: 'cam1' });
      inst.setRoute(ACTOR, pi.id, piProxy.id, { url: 'http://127.0.0.1:8480', hidden: false });
      const res = imp.run(ACTOR, home.id, cluster.id, CUT_CLUSTER, DRY);
      expect(kinds(res, 'camera-override')).toEqual([]);
      expect(kinds(res, 'camera-change')[0].fields).toMatchObject({ host: { from: null, to: '192.0.2.164' }, cameraUser: { from: null, to: 'cams' } });
    });

    it('an invalid host in the file for an override is refused at the dry run (never at apply)', () => {
      applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
      const bad = structuredClone(CUT_PI);
      bad.cameras[0].host = 'not a host';
      expect(() => imp.run(ACTOR, home.id, pi.id, bad, DRY)).toThrow(expect.objectContaining({ status: 400, field: 'cameras[0].host' }));
    });

    describe('a file that looks like another instance\'s (the Import tab picked the wrong instance)', () => {
      it('the Pi file for the cluster: it moves a visible route of the cluster → an other-instance mismatch blocks Apply until confirmed', () => {
        applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
        const res = applyRun(home.id, cluster.id, CUT_PI, APPLY);
        expect(res).toMatchObject({ applied: false, blocked: true });
        expect(res.mismatches.map((m) => [m.what, m.proxyId])).toEqual([['other-instance', piProxy.id]]);
        expect(res.mismatches[0].detail).toContain('http://127.0.0.1:8480');
        expect(cam('cam1')).toMatchObject({ host: '192.0.2.164', cameraUser: 'cams' });
        expect(route(cluster, piProxy)?.url).toBeNull();
      });

      it('the cluster file for the Pi after both imports: its URL is the cluster\'s route → looksLike names the cluster', () => {
        applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
        applyRun(home.id, pi.id, CUT_PI, APPLY);
        const res = imp.run(ACTOR, home.id, pi.id, CUT_CLUSTER, DRY);
        expect(res.looksLike).toEqual(['cluster']);
        expect(res.blocked).toBe(true);
        expect(res.mismatches.filter((m) => m.what === 'other-instance').map((m) => m.proxyId).sort()).toEqual([piProxy.id, clusterProxy.id].sort());
      });

      it('a token in the file that another instance holds → looksLike names it', () => {
        r.db.prepare(`UPDATE proxy_tokens SET holder = ? WHERE id = 'tok_00000000000000000008'`).run(pi.id);
        const res = imp.run(ACTOR, home.id, cluster.id, CUT_PI, DRY);
        expect(res.looksLike).toEqual(['pi']);
        expect(res.mismatches.map((m) => m.what)).toContain('other-instance');
        expect(applyRun(home.id, pi.id, CUT_PI, APPLY).applied).toBe(true); // its own instance: no warning
      });

      it('confirming (accepting the mismatch) applies it, as for any mismatch', () => {
        applyRun(home.id, cluster.id, CUT_CLUSTER, APPLY);
        const d = imp.run(ACTOR, home.id, cluster.id, CUT_PI, DRY);
        const ok = applyRun(home.id, cluster.id, CUT_PI, { ...APPLY, acceptMismatch: d.mismatches.map((m) => m.id) });
        expect(ok.applied).toBe(true);
      });
    });
  });
});
