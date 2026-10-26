// Camera moves started from cams-admin (move.begin plan Task 3): the checks
// before any fix (A4), the three fixers (routes, the registry site, a host
// override), the re-check and move.begin to the source. A refused request
// writes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProxyInfo } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';
import { ApiError } from '../server/registry';

const ACTOR = 'admin@example.com';
const FP = 'SHA256:' + 'CD'.repeat(32);
const BOUNDS = { transfer: true, kinds: ['clips', 'stills'], space: 'fit', maxBudgetS: 3600 };

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 20;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string }
// An enrolled, online proxy reporting `site`; the registry has registrySite (default: the same), a LAN url, a TLS name and the CA pin.
async function proxy(o: { allow?: string[]; site?: string | null; registrySite?: string | null; url?: boolean; account?: string } = {}): Promise<Px> {
  const name = `mb${n++}`;
  const p = await enrolled(s, name, o.account ?? 'home');
  const site = o.site === undefined ? `site-${name}` : o.site;
  const client = makeClient(p.key, { commands: { allow: o.allow ?? ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }) });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'connected');
  const cur = s.built.registry.getProxy(p.accountId, p.proxyId);
  const registrySite = o.registrySite === undefined ? site : o.registrySite;
  s.built.registry.updateProxy(ACTOR, p.accountId, p.proxyId, {
    url: o.url === false ? null : `http://192.0.2.${ip++}:8480`, tlsSite: registrySite, tlsServername: `${name}.internal`, caFingerprints: [FP], version: cur.version,
  });
  return { ...p, client, name };
}
function camera(src: Px, proxyCameraId = 'cam1', camsId = `porch-${proxyCameraId}`) {
  return s.built.registry.createCamera(ACTOR, src.accountId, { camsId, name: `Cam ${camsId}`, kind: 'camera', proxyId: src.proxyId, proxyCameraId, host: '192.0.2.10', protocol: 'https' });
}
// One cams instance serving the account, routed to the given proxies.
function instance(accountId: string, routedTo: string[]) {
  const i = s.built.camsInstances.create(ACTOR, { name: `cluster${n++}`, displayName: 'Cluster', accounts: [accountId] });
  for (const p of routedTo) s.built.camsInstances.setRoute(ACTOR, i.id, p, { url: null, hidden: false });
  return i;
}
const got = (c: ProxyClient, command: string) => c.receivedCommands.filter((m) => m.body.command === command);
const auditFor = (action: string) => (s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string; target_type: string; target_id: string; target_label: string; actor: string; actor_type: string }[])
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, any> }));
const commandsOf = (command: string) => s.built.db.prepare('SELECT * FROM commands WHERE command = ?').all(command) as { args: string; proxy_id: string }[];
// Everything a fixer may touch: routes, registry proxies and camera overrides.
const fixable = () => JSON.stringify([
  s.built.db.prepare('SELECT * FROM cams_instance_routes ORDER BY instance_id, proxy_id').all(),
  s.built.db.prepare('SELECT * FROM proxies ORDER BY id').all(),
  s.built.db.prepare('SELECT * FROM cams_camera_overrides ORDER BY instance_id, camera_id').all(),
  s.built.db.prepare('SELECT id, version FROM cams_instances ORDER BY id').all(),
]);
const begin = (src: Px, tgt: Px, o: { camera?: string; bounds?: unknown } = {}) =>
  s.built.moves.begin(ACTOR, { sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId: o.camera ?? 'porch-cam1', bounds: o.bounds === undefined ? BOUNDS : o.bounds });

describe('move.begin from cams-admin', () => {
  it('begin with a clean precheck queues move.begin and fixes nothing', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    instance(src.accountId, [src.proxyId, tgt.proxyId]);
    const r = begin(src, tgt, { camera: cam.id });
    expect(r).toMatchObject({ ok: true, fixed: [], report: { ok: true } });
    const rows = commandsOf('move.begin');
    expect(rows).toHaveLength(1);
    expect(rows[0].proxy_id).toBe(src.proxyId);
    expect(JSON.parse(rows[0].args)).toEqual({ v: 1, camera: 'cam1', target: tgt.proxyId, bounds: BOUNDS });
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(auditFor('move-begin')).toMatchObject([{ outcome: 'ok', detail: { cmdId: r.ok && r.commandId, source: src.proxyId, target: tgt.proxyId, camera: cam.camsId, bounds: BOUNDS, fixed: [] } }]);
    // The fake source answers {requestId} and emits move.request with the bounds: the usual request path follows.
    await until(() => s.built.moves.store.list().length === 1, 5000, 'move row');
    const m = s.built.moves.store.list()[0];
    expect(m.bounds).toEqual(BOUNDS);
    expect(m.cameraId).toBe(cam.id);
    await until(() => got(tgt.client, 'move.offer').length === 1, 5000, 'offer');
    // The link from the command to the move: the view and the audit carry the request id, the begin's audit row the cmdId too.
    expect(m.requestId).toMatch(/^rq_/);
    await until(() => auditFor('move-begin').length === 2, 5000, 'begin result row');
    expect(auditFor('move-begin')[1]).toMatchObject({ outcome: 'ok', detail: { cmdId: r.ok && r.commandId, source: src.proxyId, requestId: m.requestId } });
  });

  it('a second start for the same camera while one is pending is refused with move_pending (409), and writes nothing', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    instance(src.accountId, [src.proxyId, tgt.proxyId]);
    // Two quick POSTs (a double click): one move.begin queued, the other 409.
    const body = { sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId: cam.id, bounds: BOUNDS };
    const out = await Promise.allSettled([s.api('POST', '/moves', body), s.api('POST', '/moves', body)]);
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const no = out.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(no.reason.status).toBe(409);
    expect(no.reason.body).toEqual({ error: 'move_pending', detail: `a move of ${cam.camsId} was just requested` });
    expect(commandsOf('move.begin')).toHaveLength(1);
    expect(auditFor('move-begin').filter((r) => r.outcome === 'refused')).toHaveLength(0);
    // Once the source made the move: refused while it is open.
    await until(() => s.built.moves.store.list().length === 1, 5000, 'move row');
    expect(begin(src, tgt, { camera: cam.id })).toEqual({ ok: false, status: 409, error: 'move_pending', detail: `a move of ${cam.camsId} is open` });
    expect(commandsOf('move.begin')).toHaveLength(1);
  });

  it('move_pending: a move.begin the source answered whose move has not arrived yet counts for a minute', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    instance(src.accountId, [src.proxyId, tgt.proxyId]);
    expect(begin(src, tgt, { camera: cam.id })).toMatchObject({ ok: true });
    expect(begin(src, tgt, { camera: cam.id })).toMatchObject({ ok: false, status: 409, error: 'move_pending', detail: `a move of ${cam.camsId} was just requested` });
    await until(() => s.built.moves.store.list().length === 1 && (s.built.db.prepare("SELECT state FROM commands WHERE command = 'move.begin'").get() as { state: string }).state === 'done', 5000, 'done and move row');
    // As if the move.request had not arrived yet: the answered command alone still holds the camera.
    s.built.db.exec('DELETE FROM move_chunks; DELETE FROM moves');
    expect(begin(src, tgt, { camera: cam.id })).toMatchObject({ ok: false, status: 409, error: 'move_pending', detail: `a move of ${cam.camsId} was just requested` });
    clock.advance(61_000);
    expect(begin(src, tgt, { camera: cam.id })).toMatchObject({ ok: true });
  });

  it('not_routed is fixed with a visible route, url null', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const i = instance(src.accountId, [src.proxyId]);
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true, fixed: [{ rule: 'routed', instanceId: i.id, proxyId: tgt.proxyId }], report: { ok: true } });
    expect(s.built.camsInstances.routes(i.id).find((x) => x.proxyId === tgt.proxyId)).toMatchObject({ url: null, hidden: false });
    const fx = auditFor('move-fix');
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ outcome: 'ok', target_type: 'cams-instance', target_id: i.id, detail: { rule: 'routed', source: src.proxyId, target: tgt.proxyId, camera: 'porch-cam1', instanceId: i.id, proxyId: tgt.proxyId } });
    expect(commandsOf('move.begin')).toHaveLength(1);
  });

  it('site_ca is fixed from the reported site when the registry is empty', async () => {
    const src = await proxy();
    const tgt = await proxy({ site: 'beta-2', registrySite: null });
    camera(src);
    const before = s.built.registry.proxyById(tgt.proxyId)!;
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true, report: { ok: true } });
    expect(r.ok && r.fixed).toContainEqual({ rule: 'site_ca', proxyId: tgt.proxyId, site: 'beta-2' });
    const after = s.built.registry.proxyById(tgt.proxyId)!;
    expect(after.tlsSite).toBe('beta-2');
    expect(after.caFingerprints).toEqual(before.caFingerprints);
    expect(after.tlsServername).toBe(before.tlsServername);
    expect(auditFor('move-fix')).toMatchObject([{ target_type: 'proxy', target_id: tgt.proxyId, detail: { rule: 'site_ca', proxyId: tgt.proxyId, site: 'beta-2' } }]);
  });

  it('a source without a site CA does not block the move or become a fix', async () => {
    const src = await proxy({ site: null, registrySite: null });
    const tgt = await proxy();
    camera(src);
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true, fixed: [], report: { ok: true } });
    expect(s.built.registry.proxyById(src.proxyId)!.tlsSite).toBeNull();
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(commandsOf('move.begin')).toHaveLength(1);
  });

  it('a source without a site CA and a target fixable by its reported site: only the target is fixed', async () => {
    const src = await proxy({ site: null, registrySite: null });
    const tgt = await proxy({ site: 'beta-2', registrySite: null });
    camera(src);
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true, fixed: [{ rule: 'site_ca', proxyId: tgt.proxyId, site: 'beta-2' }] });
    expect(s.built.registry.proxyById(src.proxyId)!.tlsSite).toBeNull();
  });

  it('a target without a site CA is still refused no_site_ca, naming only the target', async () => {
    const src = await proxy({ site: null, registrySite: null });
    const tgt = await proxy({ site: null, registrySite: null });
    camera(src);
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: false, status: 409, error: 'precheck', reason: 'no_site_ca', fixed: [] });
    const rep = (r as any).report.rules.find((x: any) => x.rule === 'site_ca');
    expect(rep.detail).toContain(tgt.proxyId);
    expect(rep.detail).not.toContain(src.proxyId);
  });

  it('a registry site that differs is not overwritten', async () => {
    const src = await proxy();
    const tgt = await proxy({ site: 'beta-2', registrySite: 'old' });
    camera(src);
    const was = fixable();
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: false, status: 409, error: 'precheck', reason: 'no_site_ca', fixed: [] });
    expect(s.built.registry.proxyById(tgt.proxyId)!.tlsSite).toBe('old');
    expect(fixable()).toBe(was);
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(auditFor('move-begin')).toMatchObject([{ outcome: 'refused', actor_type: 'sysadmin', actor: ACTOR, target_type: 'camera', target_label: 'porch-cam1', detail: { failing: ['site_ca'] } }]);
    expect(commandsOf('move.begin')).toHaveLength(0);
  });

  it('a hidden target route is not unhidden', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const i = instance(src.accountId, [src.proxyId]);
    s.built.camsInstances.setRoute(ACTOR, i.id, tgt.proxyId, { hidden: true });
    const was = fixable();
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: false, status: 409, error: 'precheck', reason: 'not_routed', fixed: [] });
    expect(s.built.camsInstances.routes(i.id).find((x) => x.proxyId === tgt.proxyId)).toMatchObject({ hidden: true });
    expect(fixable()).toBe(was);
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(auditFor('move-begin')).toMatchObject([{ outcome: 'refused', actor: ACTOR, detail: { failing: ['routed'] } }]);
    expect(commandsOf('move.begin')).toHaveLength(0);
  });

  it('a host override loses its host and keeps its camera user', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    const i = instance(src.accountId, [src.proxyId, tgt.proxyId]);
    const j = instance(src.accountId, [src.proxyId, tgt.proxyId]);
    s.built.camsInstances.setOverride(ACTOR, i.id, cam.id, { host: '192.0.2.50', cameraUser: 'viewer' });
    s.built.camsInstances.setOverride(ACTOR, j.id, cam.id, { host: '192.0.2.51' });
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true, report: { ok: true } });
    expect(r.ok && r.fixed).toEqual(expect.arrayContaining([
      { rule: 'no_host_override', instanceId: i.id, cameraId: cam.id },
      { rule: 'no_host_override', instanceId: j.id, cameraId: cam.id },
    ]));
    expect(s.built.camsInstances.overrides(i.id)).toMatchObject([{ cameraId: cam.id, host: null, cameraUser: 'viewer' }]);
    expect(s.built.camsInstances.overrides(j.id)).toEqual([]);
    const fx = auditFor('move-fix');
    expect(fx).toHaveLength(2);
    for (const f of fx) expect(f).toMatchObject({ target_type: 'cams-instance', detail: { rule: 'no_host_override', cameraId: cam.id, camera: cam.camsId } });
  });

  it('non-fixable failure fixes nothing', async () => {
    const src = await proxy();
    const tgt = await proxy({ registrySite: null });
    const cam = camera(src);
    const i = instance(src.accountId, [src.proxyId]);
    s.built.camsInstances.setOverride(ACTOR, i.id, cam.id, { host: '192.0.2.50' });
    tgt.client.abort();
    clock.advance(10 * 60_000);
    await until(() => s.built.status.view(tgt.proxyId).state === 'offline' && s.built.status.view(src.proxyId).state === 'online', 5000, 'target offline');
    const was = fixable();
    const auditN = (s.built.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: false, status: 409, error: 'precheck', reason: 'target_offline', fixed: [] });
    expect(r.ok === false && r.report!.rules.find((x) => x.rule === 'target_online')).toMatchObject({ ok: false });
    expect(fixable()).toBe(was);
    expect(auditFor('move-fix')).toHaveLength(0);
    // The one row a refusal writes: move-begin refused, the failing rules by name (nothing else of the request persists).
    expect((s.built.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n).toBe(auditN + 1);
    const refused = auditFor('move-begin');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'refused', actor_type: 'sysadmin', actor: ACTOR, target_type: 'camera', target_id: cam.id, target_label: cam.camsId });
    expect(refused[0].detail).toEqual({ failing: ['target_online', 'site_ca', 'routed', 'no_host_override'] });
    expect(commandsOf('move.begin')).toHaveLength(0);
  });

  it('source checks come first', async () => {
    const src = await proxy();
    const tgt = await proxy({ registrySite: null });
    const other = await proxy();
    const sendless = await proxy({ allow: ['move.receive'] });
    const urlless = await proxy({ url: false });
    camera(src);
    camera(other, 'cam2', 'yard');
    camera(sendless, 'cam1', 'sendless');
    camera(urlless, 'cam1', 'urlless');
    const off = await proxy();
    camera(off, 'cam1', 'off');
    // Every case has a fixable failure (the target's site) that must stay unfixed.
    instance(src.accountId, [src.proxyId]);
    off.client.abort();
    clock.advance(10 * 60_000);
    await until(() => s.built.status.view(off.proxyId).state === 'offline' && s.built.status.view(src.proxyId).state === 'online'
      && s.built.status.view(sendless.proxyId).state === 'online' && s.built.status.view(urlless.proxyId).state === 'online', 5000, 'states');
    const was = fixable();
    expect(begin(src, tgt, { camera: 'yard' })).toMatchObject({ ok: false, status: 409, error: 'camera_not_on_source' });
    expect(begin(off, tgt, { camera: 'off' })).toMatchObject({ ok: false, status: 409, error: 'source_offline' });
    expect(begin(sendless, tgt, { camera: 'sendless' })).toMatchObject({ ok: false, status: 409, error: 'moves_not_allowed' });
    expect(begin(urlless, tgt, { camera: 'urlless' })).toMatchObject({ ok: false, status: 409, error: 'source_registry_incomplete' });
    expect(s.built.moves.begin(ACTOR, { sourceProxyId: 'prx_0000000000000000000Z', targetProxyId: tgt.proxyId, cameraId: 'cam1', bounds: null })).toMatchObject({ ok: false, status: 404, error: 'not_found', field: 'sourceProxyId' });
    expect(begin(src, tgt, { camera: 'nope' })).toMatchObject({ ok: false, status: 404, error: 'not_found', field: 'cameraId' });
    expect(fixable()).toBe(was);
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(auditFor('move-begin')).toHaveLength(0);
    expect(commandsOf('move.begin')).toHaveLength(0);
  });

  it('a plain-http source without a TLS name (the Pi) is not registry-incomplete', async () => {
    const src = await proxy({ site: null, registrySite: null });
    const tgt = await proxy();
    const cur = s.built.registry.getProxy(src.accountId, src.proxyId);
    s.built.registry.updateProxy(ACTOR, src.accountId, src.proxyId, { tlsServername: null, caFingerprints: [], version: cur.version });
    camera(src);
    expect(begin(src, tgt)).toMatchObject({ ok: true });
    expect(commandsOf('move.begin')).toHaveLength(1);
  });

  it('a target without a registry url is refused before any fix', async () => {
    const src = await proxy();
    const tgt = await proxy({ url: false, site: 'beta-2', registrySite: null });
    camera(src);
    instance(src.accountId, [src.proxyId]);
    const was = fixable();
    expect(begin(src, tgt)).toMatchObject({ ok: false, status: 409, error: 'target_registry_incomplete' });
    expect(fixable()).toBe(was);
    expect(auditFor('move-fix')).toHaveLength(0);
    expect(commandsOf('move.begin')).toHaveLength(0);
  });

  it('cameraId may be the cams id', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    const r = begin(src, tgt, { camera: cam.camsId });
    expect(r).toMatchObject({ ok: true, fixed: [] });
    expect(JSON.parse(commandsOf('move.begin')[0].args)).toMatchObject({ camera: 'cam1', target: tgt.proxyId });
  });

  it('a refused move.begin is audited and leaves no move', async () => {
    const src = await proxy();
    const tgt = await proxy({ site: 'beta-2', registrySite: null });
    const cam = camera(src);
    src.client.moveResults['move.begin'] = { status: 'failed', code: 'busy' };
    const r = begin(src, tgt);
    expect(r).toMatchObject({ ok: true });
    await until(() => auditFor('move-begin').some((a) => a.outcome === 'failed'), 5000, 'failed move-begin audit');
    const failed = auditFor('move-begin').find((a) => a.outcome === 'failed')!;
    expect(failed.detail).toEqual({ cmdId: r.ok && r.commandId, source: src.proxyId, code: 'busy' });
    // Attributed like the ok row: the requester, the camera.
    expect(failed).toMatchObject({ actor_type: 'sysadmin', actor: ACTOR, target_type: 'camera', target_id: cam.id, target_label: cam.camsId });
    expect(s.built.moves.store.list()).toHaveLength(0);
    expect(auditFor('move-fix')).toMatchObject([{ detail: { rule: 'site_ca', proxyId: tgt.proxyId } }]);
    expect(s.built.registry.proxyById(tgt.proxyId)!.tlsSite).toBe('beta-2');
  });

  it('bounds null starts a move with no auto-approval', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    expect(begin(src, tgt, { bounds: null })).toMatchObject({ ok: true });
    expect(JSON.parse(commandsOf('move.begin')[0].args).bounds).toBeNull();
    await until(() => s.built.moves.store.list().length === 1, 5000, 'move row');
    expect(s.built.moves.store.list()[0].bounds).toBeNull();
  });

  it('bad bounds are 400 bounds', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const err = (body: unknown) => {
      try {
        s.built.moves.begin(ACTOR, body);
      } catch (e) {
        return e instanceof ApiError ? { status: e.status, code: e.code, field: e.field } : e;
      }
      return null;
    };
    expect(err({ sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId: 'cam1', bounds: { ...BOUNDS, maxBudgetS: 30 } })).toEqual({ status: 400, code: 'invalid', field: 'bounds' });
    expect(err({ sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId: 'cam1' })).toEqual({ status: 400, code: 'invalid', field: 'bounds' });
    expect(err({ sourceProxyId: src.proxyId, cameraId: 'cam1', bounds: null })).toEqual({ status: 400, code: 'invalid', field: 'targetProxyId' });
    expect(err({ targetProxyId: tgt.proxyId, cameraId: 'cam1', bounds: null })).toEqual({ status: 400, code: 'invalid', field: 'sourceProxyId' });
    expect(err({ sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId: '', bounds: null })).toEqual({ status: 400, code: 'invalid', field: 'cameraId' });
    expect(err(null)).toMatchObject({ status: 400, code: 'invalid' });
    expect(commandsOf('move.begin')).toHaveLength(0);
  });
});
