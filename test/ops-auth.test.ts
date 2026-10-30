// Operations tokens on the API: a bearer `cao_…` token opens only the write
// routes of the scope table, for the scopes it holds; every other route
// answers 403 `scope`. A bad token is 401 (one throttled record). The bearer
// decides over a session cookie; a bearer write needs no CSRF header.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, request as httpRequest, type IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { once } from 'events';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { apiRouter } from '../server/api/router';
import { diagCameras, diagProxies } from '../server/diag/views';
import { OPS_ROUTES, opsScopeFor } from '../server/ops/scopes';
import { OPS_SCOPES, type OpsScope } from '../server/ops/tokens';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

type M = 'get' | 'post' | 'put' | 'patch' | 'delete';
const bearer = (method: M, path: string, token: string, body?: unknown) => {
  const r = request(a.app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  return method === 'get' ? r : r.set('Content-Type', 'application/json').send(JSON.stringify(body ?? {}));
};
const issue = (scopes: OpsScope[], name = 'script') => {
  const { token, item } = a.ops.issue('admin@example.com', { name, scopes, days: 1 });
  return { token, prefix: item.hashPrefix, id: item.id };
};
const auditOf = (action: string) => a.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor: string; detail: string; outcome: string; target_id: string }[];
// Audit rows other than the (throttled) refusals.
const auditCount = () => (a.db.prepare(`SELECT count(*) n FROM audit_log WHERE action NOT IN ('ops-auth-refused', 'ops-scope-refused', 'audit-throttled')`).get() as { n: number }).n;
const scopeRefusals = (actor: string) => auditOf('ops-scope-refused').filter((x) => x.actor === actor);

let acc: string, px: string, inst: string;
let n = 0;
// An active proxy token, as if the proxy had confirmed it.
const seedToken = () => {
  const id = `tok_9${String(n++).padStart(19, '0')}`;
  a.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,'client','manual','seeded',?,'active',1,1,'admin@example.com')`).run(id, acc, px, 'sha256:' + String(n).padStart(64, 'e'));
  return id;
};
// A move in copying, with proxies and a camera of its own.
const seedMove = () => {
  const i = n++;
  const s = `prx_os${i}`, t = `prx_ot${i}`, cam = `cam_o${i}`, mv = `mv_O${String(i).padStart(19, '0')}`;
  for (const id of [s, t]) a.db.prepare(`INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES (?,?,?,?,'cluster','enrolled',1,1)`).run(id, acc, id, id);
  a.db.prepare(`INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,'pc','M','camera',1,1)`).run(cam, acc, s, `m${i}`);
  a.db.prepare(`INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,'copying',1,1)`).run(mv, acc, cam, s, t, `rq_o${i}`);
  return mv;
};

beforeAll(() => {
  acc = a.registry.createAccount('admin@example.com', { name: 'home', displayName: 'Home' }).id;
  px = a.registry.createProxy('admin@example.com', acc, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' }).id;
  inst = a.camsInstances.create('admin@example.com', { name: 'cluster', displayName: 'Cluster', accounts: [acc] }).id;
});
// Room under the live-token cap for each test.
beforeEach(() => void a.db.prepare(`UPDATE ops_tokens SET revoked_at = 1, revoked_by = 'test' WHERE revoked_at IS NULL`).run());

describe('the scope table', () => {
  it('matches each :param as one non-empty segment', () => {
    expect(opsScopeFor('POST', '/moves/mv_1/cancel')).toBe('moves');
    expect(opsScopeFor('PUT', '/cams-instances/ci_1/routes/prx_1')).toBe('routes');
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens/apply')).toBe('tokens');
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens/tok_1/revoke')).toBe('tokens');
    expect(opsScopeFor('GET', '/moves/mv_1/cancel')).toBeNull();
    expect(opsScopeFor('PUT', '/cams-instances/ci_1/camera-overrides/cam_1')).toBeNull();
    expect(opsScopeFor('POST', '/moves//cancel')).toBeNull();
    expect(opsScopeFor('POST', '/moves/a/b/cancel')).toBeNull();
    expect(opsScopeFor('POST', '/moves/mv_1/cancel/x')).toBeNull();
    expect(opsScopeFor('POST', '/x/moves/mv_1/cancel')).toBeNull();
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/tokens')).toBeNull();
    expect(opsScopeFor('PATCH', '/accounts/acc_1/proxies/prx_1')).toBe('registry');
    expect(opsScopeFor('PATCH', '/accounts/acc_1/cameras/cam_1')).toBe('registry');
    expect(opsScopeFor('DELETE', '/accounts/acc_1/proxies/prx_1')).toBeNull();
    expect(opsScopeFor('POST', '/accounts/acc_1/proxies/prx_1/adopt')).toBe('onboard');
    expect(opsScopeFor('POST', '/accounts/acc_1/cameras')).toBeNull();
  });

  it('coverage: every route of the router is in the table or refuses a token with every scope', async () => {
    const router = apiRouter({ ...a, serverKeyFingerprints: [a.signing.fingerprint] });
    const routes: { method: string; path: string }[] = [];
    for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path });
    }
    expect(routes.length).toBeGreaterThan(50);
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const o of OPS_ROUTES) expect(have.has(`${o.method} ${o.path}`), `${o.method} ${o.path}`).toBe(true);
    const inTable = new Set(OPS_ROUTES.map((o) => `${o.method} ${o.path}`));
    const { token, prefix } = issue([...OPS_SCOPES], 'all');
    const before = auditCount();
    for (const r of routes) {
      if (inTable.has(`${r.method} ${r.path}`)) continue;
      const res = await bearer(r.method.toLowerCase() as M, r.path.replace(/:[A-Za-z]+/g, 'x1'), token);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body, `${r.method} ${r.path}`).toEqual({ error: 'scope' });
    }
    // Nothing but one throttled refusal for the token.
    expect(auditCount()).toBe(before);
    expect(scopeRefusals(`ops-token:${prefix}`)).toHaveLength(1);
  });
});

describe('scoped writes', () => {
  it('a tokens token revokes a proxy token; the audit actor is the token', async () => {
    const t = issue(['tokens']);
    const tok = seedToken();
    const r = await bearer('post', `/accounts/${acc}/proxies/${px}/tokens/${tok}/revoke`, t.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((a.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(tok) as { state: string }).state).toBe('revoked');
    const rec = auditOf('token-revoke').find((x) => JSON.parse(x.detail).tokenId === tok)!;
    expect(rec.actor).toBe(`ops-token:${t.prefix}`);
    expect(rec.actor).toMatch(/^ops-token:[0-9a-f]{8}$/);
  });

  it('a tokens token may not set a route; a routes token sets and deletes one', async () => {
    const path = `/cams-instances/${inst}/routes/${px}`;
    const t = issue(['tokens']);
    const no = await bearer('put', path, t.token, { url: null, hidden: false });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'scope' });
    expect(a.camsInstances.routes(inst)).toHaveLength(0);
    const r = issue(['routes']);
    expect((await bearer('put', path, r.token, { url: null, hidden: false })).status).toBe(200);
    expect(a.camsInstances.routes(inst)).toHaveLength(1);
    expect((await bearer('delete', path, r.token)).status).toBe(204);
    expect(a.camsInstances.routes(inst)).toHaveLength(0);
    expect(auditOf('route-update').slice(-2).map((x) => x.actor)).toEqual([`ops-token:${r.prefix}`, `ops-token:${r.prefix}`]);
  });

  // The registry edits Klaus otherwise makes by hand: a proxy's TLS site and CA
  // pins, a camera's host and TLS name (cams viewers still hold on a changed endpoint).
  it('a registry token edits a proxy and a camera; other scopes may not', async () => {
    const cam = a.registry.createCamera('admin@example.com', acc, { camsId: 'simcam', name: 'Sim', kind: 'sim', proxyId: px, proxyCameraId: 'cam9', host: '192.0.2.30', protocol: 'https' }).id;
    const pin = `SHA256:${'AB'.repeat(32)}`;
    const other = issue(['tokens', 'routes', 'moves']);
    expect((await bearer('patch', `/accounts/${acc}/proxies/${px}`, other.token, { tlsSite: 'cluster' })).status).toBe(403);
    expect((await bearer('patch', `/accounts/${acc}/cameras/${cam}`, other.token, { tlsServername: 'cam9.cluster.internal' })).status).toBe(403);
    const t = issue(['registry']);
    // The row versions come from the diag views (an ops token never reads).
    const pv = (diagProxies({ ...a, serverKeyFingerprints: [a.signing.fingerprint] }).items.find((x) => x.id === px)!).rowVersion;
    const cv = (diagCameras({ ...a, serverKeyFingerprints: [a.signing.fingerprint] }).items.find((x) => x.id === cam)!).rowVersion;
    expect(pv).toBe(a.registry.getProxy(acc, px).version);
    const p = await bearer('patch', `/accounts/${acc}/proxies/${px}`, t.token, { version: pv, tlsSite: 'cluster', caFingerprints: [pin] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ tlsSite: 'cluster', caFingerprints: [pin] });
    const c = await bearer('patch', `/accounts/${acc}/cameras/${cam}`, t.token, { version: cv, host: '10.43.61.52', tlsServername: 'cam9.cluster.internal', webUiUrl: null });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ host: '10.43.61.52', tlsServername: 'cam9.cluster.internal', webUiUrl: null });
    expect(auditOf('proxy-update').at(-1)!.actor).toBe(`ops-token:${t.prefix}`);
    expect(auditOf('camera-update').at(-1)!.actor).toBe(`ops-token:${t.prefix}`);
    // Creating stays with a sign-in; deleting needs the offboard scope.
    expect((await bearer('delete', `/accounts/${acc}/cameras/${cam}`, t.token)).status).toBe(403);
  });

  // Onboarding by script: adopting a camera the proxy reports (host from-proxy, model from the report).
  it('an onboard token adopts a reported camera; other scopes and a plain create may not', async () => {
    const acct = a.registry.createAccount('admin@example.com', { name: 'onboardacc', displayName: 'O' }).id;
    const p = a.registry.createProxy('admin@example.com', acct, { name: 'onb', displayName: 'Onb', runsOn: 'local-host' }).id;
    a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(p);
    a.status.heartbeat(p, { summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: makeProxyInfo({ now: Date.now() }), truncated: false }, Date.now());
    const path = `/accounts/${acct}/proxies/${p}/adopt`;
    const other = issue(['tokens', 'routes', 'moves', 'registry']);
    const no = await bearer('post', path, other.token, { proxyCameraId: 'cam1' });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'scope' });
    expect(a.registry.listCameras(acct)).toHaveLength(0);
    const t = issue(['onboard']);
    const r = await bearer('post', path, t.token, { proxyCameraId: 'cam1', camsId: 'frontdoor', name: 'Front door' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ camsId: 'frontdoor', name: 'Front door', proxyId: p, proxyCameraId: 'cam1', host: 'from-proxy', model: 'RLC-1224A' });
    expect(auditOf('camera-adopt').at(-1)!.actor).toBe(`ops-token:${t.prefix}`);
    // A camera the proxy doesn't report is refused by the handler, as for a session.
    expect((await bearer('post', path, t.token, { proxyCameraId: 'cam9' })).body).toMatchObject({ error: 'not_reported' });
    // A plain create stays session-only, whatever the scopes.
    const all = issue([...OPS_SCOPES]);
    const c = await bearer('post', `/accounts/${acct}/cameras`, all.token, { camsId: 'x', name: 'X', kind: 'camera', proxyId: p, proxyCameraId: 'cam2' });
    expect(c.status).toBe(403);
    expect(c.body).toEqual({ error: 'scope' });
    expect(a.registry.listCameras(acct)).toHaveLength(1);
  });

  // An enrolled proxy that takes commands, with the allow-list given (the commands service checks it).
  const commandProxy = (name: string, allow: string[]) => {
    const acct = a.registry.createAccount('admin@example.com', { name: `${name}acc`, displayName: name }).id;
    const p = a.registry.createProxy('admin@example.com', acct, { name, displayName: name, runsOn: 'local-host' }).id;
    a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(p);
    a.status.hello(p, 'v2', Date.now(), ['status', 'commands']);
    a.status.heartbeat(p, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow, seenWindow: 1000 } }, truncated: false }, Date.now());
    return { acct, p, base: `/accounts/${acct}/proxies/${p}` };
  };
  const commandCount = (proxyId: string) => (a.db.prepare('SELECT count(*) n FROM commands WHERE proxy_id = ?').get(proxyId) as { n: number }).n;

  it('an actions token runs a camera action, renames and restarts; a config token may not', async () => {
    const { p, base } = commandProxy('act', ['camera.action:camera-test', 'camera.name.set', 'proxy.restart']);
    const cases: [string, unknown][] = [
      [`${base}/actions`, { camera: 'cam1', action: 'camera-test' }],
      [`${base}/cameras/cam1/name`, { name: 'Front door' }],
      [`${base}/restart`, { confirm: 'proxy.restart' }],
    ];
    const c = issue(['config']);
    for (const [path, body] of cases) {
      const no = await bearer('post', path, c.token, body);
      expect(no.status, path).toBe(403);
      expect(no.body, path).toEqual({ error: 'scope' });
    }
    expect(commandCount(p)).toBe(0);
    const t = issue(['actions']);
    for (const [path, body] of cases) {
      const r = await bearer('post', path, t.token, body);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(202);
      expect(r.body).toEqual({ commandId: expect.any(String) });
    }
    expect(commandCount(p)).toBe(3);
    const rows = auditOf('command-create').filter((x) => x.target_id === p);
    expect(rows.map((x) => x.actor)).toEqual(Array(3).fill(`ops-token:${t.prefix}`));
  });

  it('an actions token refreshes onboarding and sets the time; an offboard token may not', async () => {
    const { p, base } = commandProxy('onbact', ['camera.onboarding.get', 'camera.action:camera-time-set']);
    // The fleet gate counts every proxy's disruptive commands: the earlier tests' restart is over and out of the window.
    a.db.prepare(`UPDATE commands SET state = 'expired', created_at = created_at - 3600000 WHERE state IN ('queued', 'sent', 'received')`).run();
    const cases: [string, unknown, string][] = [
      [`${base}/cameras/cam1/onboarding/refresh`, {}, 'camera.onboarding.get'],
      [`${base}/actions`, { camera: 'cam1', action: 'camera-time-set', confirm: 'camera-time-set' }, 'camera.action'],
    ];
    const o = issue(['offboard', 'onboard', 'registry']);
    for (const [path, body] of cases) {
      const no = await bearer('post', path, o.token, body);
      expect(no.status, path).toBe(403);
      expect(no.body, path).toEqual({ error: 'scope' });
    }
    expect(commandCount(p)).toBe(0);
    const t = issue(['actions']);
    for (const [path, body] of cases) expect((await bearer('post', path, t.token, body)).status, path).toBe(202);
    const made = a.db.prepare('SELECT command, args FROM commands WHERE proxy_id = ? ORDER BY rowid').all(p) as { command: string; args: string }[];
    expect(made.map((x) => [x.command, JSON.parse(x.args)])).toEqual([['camera.onboarding.get', { v: 1, camera: 'cam1' }], ['camera.action', { v: 1, camera: 'cam1', action: 'camera-time-set' }]]);
    expect(auditOf('command-create').filter((x) => x.target_id === p).map((x) => x.actor)).toEqual(Array(2).fill(`ops-token:${t.prefix}`));
    // The typed confirm still applies to a token.
    expect((await bearer('post', `${base}/actions`, t.token, { camera: 'cam2', action: 'camera-time-set' })).body).toEqual({ error: 'confirm_required', field: 'confirm' });
    expect(cases.map((c) => c[2])).toEqual(made.map((x) => x.command));
  });

  it('a config token previews and applies; an actions token may not', async () => {
    const { acct, p, base } = commandProxy('cfg', ['config.get', 'config.set', 'config.unset', 'config.rollback']);
    const view = { revision: 'sha256:' + 'c'.repeat(64), schema: 1, cameras: ['cam1'], omittedCameras: [], settable: { 'sse.pingS': { type: 'integer', min: 5, max: 300 } }, paths: { 'sse.pingS': { v: 30, s: 'default' } } };
    a.config.storeView(p, 'cmd_seed', view);
    // The heartbeat queued its own config.get (ProxyConfig.onHeartbeat); it expired.
    a.db.prepare(`UPDATE commands SET state = 'expired' WHERE proxy_id = ?`).run(p);
    const before = commandCount(p);
    const t = issue(['actions']);
    for (const [path, body] of [[`${base}/config/refresh`, {}], [`${base}/config/preview`, { set: { 'sse.pingS': 7 } }], [`${base}/config/apply`, { previewId: 'cmd_x' }],
      [`${base}/config/rollback/preview`, { cmdId: 'cmd_x' }], [`${base}/config/rollback/apply`, { previewId: 'cmd_x' }]] as [string, unknown][]) {
      const no = await bearer('post', path, t.token, body);
      expect(no.status, path).toBe(403);
      expect(no.body, path).toEqual({ error: 'scope' });
    }
    expect(commandCount(p)).toBe(before);
    const c = issue(['config']);
    expect((await bearer('post', `${base}/config/refresh`, c.token)).status).toBe(202);
    const pv = await bearer('post', `${base}/config/preview`, c.token, { set: { 'sse.pingS': 7 } });
    expect(pv.status, JSON.stringify(pv.body)).toBe(202);
    // The proxy answers the dry run (as the test client would).
    a.db.prepare(`UPDATE commands SET state = 'done', finished_at = ?, result = ? WHERE id = ?`).run(Date.now(), JSON.stringify({ changes: [{ path: 'sse.pingS', from: 30, to: 7 }] }), pv.body.commandId);
    const ap = await bearer('post', `${base}/config/apply`, c.token, { previewId: pv.body.commandId });
    expect(ap.status, JSON.stringify(ap.body)).toBe(202);
    // The rollback routes reach their handlers too.
    expect((await bearer('post', `${base}/config/rollback/preview`, c.token, { cmdId: 'nope' })).body).toEqual({ error: 'invalid', field: 'cmdId' });
    expect((await bearer('post', `${base}/config/rollback/apply`, c.token, { previewId: 'nope' })).body).toEqual({ error: 'invalid', field: 'previewId' });
    expect(auditOf('command-create').filter((x) => x.target_id === p && x.actor !== 'system').map((x) => x.actor)).toEqual(Array(3).fill(`ops-token:${c.prefix}`));
    expect(a.registry.getProxy(acct, p).id).toBe(p);
  });

  it('an offboard token deletes a camera (audit camera-delete, token actor); a registry token may not', async () => {
    const cam = a.registry.createCamera('admin@example.com', acc, { camsId: 'offb', name: 'Off', kind: 'camera', proxyId: px, proxyCameraId: 'cam7', host: '192.0.2.31', protocol: 'https' }).id;
    const r = issue(['registry', 'onboard', 'actions', 'config']);
    const no = await bearer('delete', `/accounts/${acc}/cameras/${cam}`, r.token);
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'scope' });
    expect(a.registry.getCamera(acc, cam).id).toBe(cam);
    const t = issue(['offboard']);
    expect((await bearer('delete', `/accounts/${acc}/cameras/${cam}`, t.token)).status).toBe(204);
    expect(a.registry.listCameras(acc).some((c) => c.id === cam)).toBe(false);
    const rec = auditOf('camera-delete').at(-1)!;
    expect(rec.actor).toBe(`ops-token:${t.prefix}`);
    expect(rec.target_id).toBe(cam);
  });

  it('a moves token cancels a move', async () => {
    const t = issue(['moves']);
    const mv = seedMove();
    const r = await bearer('post', `/moves/${mv}/cancel`, t.token, { copied: 'delete', confirm: 'cancel' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ id: mv, phase: 'cancelling' });
  });

  it('a moves token may POST /moves; a routes token gets 403 scope and nothing is fixed', async () => {
    const acct = a.registry.createAccount('admin@example.com', { name: 'beginacc', displayName: 'B' }).id;
    const mk = (name: string, allow: string[]) => {
      const p = a.registry.createProxy('admin@example.com', acct, { name, displayName: name, runsOn: 'local-host' }).id;
      a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(p);
      a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, ?, 1, 1)`).run(`key_${String(n++).padStart(20, '0')}`, p, `pk${p}`, `fp${p}`);
      const cur = a.registry.getProxy(acct, p);
      a.registry.updateProxy('admin@example.com', acct, p, { url: 'http://192.0.2.9:8480', tlsSite: 'site-ops', tlsServername: `${name}.internal`, version: cur.version });
      a.status.hello(p, 'v2', Date.now(), ['status', 'commands']);
      a.status.heartbeat(p, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now(), site: 'site-ops' }), commands: { enabled: true, paused: false, pauseReason: null, allow, seenWindow: 1000 } }, truncated: false }, Date.now());
      return p;
    };
    const s = mk('bs', ['move.send', 'move.receive']);
    const t = mk('bt', ['move.send', 'move.receive']);
    a.registry.createCamera('admin@example.com', acct, { camsId: 'beginporch', name: 'P', kind: 'camera', proxyId: s, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
    const ci = a.camsInstances.create('admin@example.com', { name: 'beginci', displayName: 'C', accounts: [acct] }).id;
    a.camsInstances.setRoute('admin@example.com', ci, s, { url: null, hidden: false });
    const body = { sourceProxyId: s, targetProxyId: t, cameraId: 'beginporch', bounds: null };
    const cmds = () => (a.db.prepare(`SELECT count(*) n FROM commands WHERE command = 'move.begin'`).get() as { n: number }).n;
    expect(opsScopeFor('POST', '/moves')).toBe('moves');
    const rt = issue(['routes']);
    const bad = await bearer('post', '/moves', rt.token, body);
    expect(bad.status).toBe(403);
    expect(bad.body).toMatchObject({ error: 'scope' });
    expect(a.camsInstances.routes(ci)).toHaveLength(1);
    expect(cmds()).toBe(0);
    const mt = issue(['moves']);
    const ok = await bearer('post', '/moves', mt.token, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body).toMatchObject({ commandId: expect.any(String), fixed: [{ rule: 'routed', instanceId: ci, proxyId: t }] });
    expect(cmds()).toBe(1);
    expect(auditOf('move-begin').at(-1)!.actor).toBe(`ops-token:${mt.prefix}`);
  });

  it('every other table route reaches its handler with a token in scope', async () => {
    // A proxy that takes tokens.apply (for retire and apply).
    const p2 = a.registry.createProxy('admin@example.com', acc, { name: 'p2', displayName: 'P2', runsOn: 'local-host' }).id;
    a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(p2);
    a.status.hello(p2, 'v2', Date.now(), ['status', 'commands']);
    a.status.heartbeat(p2, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 } }, truncated: false }, Date.now());
    const tok = `tok_9${String(n++).padStart(19, '0')}`;
    a.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,'client','manual','seeded',?,'active',1,1,'admin@example.com')`).run(tok, acc, p2, 'sha256:' + String(n).padStart(64, 'd'));
    const cam = a.registry.createCamera('admin@example.com', acc, { camsId: 'yard', name: 'Yard', kind: 'camera', proxyId: px, proxyCameraId: 'cam1', host: '192.0.2.20', protocol: 'https' }).id;
    a.camsInstances.setOverride('admin@example.com', inst, cam, { host: 'from-proxy', cameraUser: 'proxy' });
    const mv = seedMove();
    const t = issue([...OPS_SCOPES]);
    const actor = `ops-token:${t.prefix}`;
    const cases: [M, string, unknown, number, string][] = [
      ['post', `/accounts/${acc}/proxies/${p2}/tokens/${tok}/retire`, { hours: 24 }, 200, 'token-retire'],
      ['post', `/accounts/${acc}/proxies/${p2}/tokens/apply`, {}, 202, 'command-create'],
      ['post', `/moves/${mv}/end-transfer`, { confirm: 'end transfer' }, 202, 'move-end-transfer'],
      ['delete', `/cams-instances/${inst}/camera-overrides/${cam}`, undefined, 204, 'camera-override-clear'],
    ];
    for (const [m, path, body, status, action] of cases) {
      const r = await bearer(m, path, t.token, body);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(status);
      expect(auditOf(action).at(-1)!.actor, path).toBe(actor);
    }
    expect(scopeRefusals(actor)).toHaveLength(0);
  });

  it('a bearer write needs no X-Cams-Admin header; a session write without it is still 403 csrf', async () => {
    const t = issue(['moves']);
    const r = await request(a.app).post(`/api/v1/moves/${seedMove()}/cancel`).set('Authorization', `Bearer ${t.token}`).set('Content-Type', 'application/json').send('{"copied":"delete","confirm":"cancel"}');
    expect(r.status).toBe(202);
    const s = await request(a.app).post(`/api/v1/moves/${seedMove()}/cancel`).set('Cookie', a.cookie).set('Content-Type', 'application/json').send('{"copied":"delete","confirm":"cancel"}');
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: 'csrf' });
  });

  it('60 writes a minute per token: the 61st is 429', async () => {
    const t = issue(['moves']);
    for (let i = 0; i < 60; i++) expect((await bearer('post', '/moves/mv_NOPE/cancel', t.token, { confirm: 'cancel' })).status).toBe(404);
    const r = await bearer('post', '/moves/mv_NOPE/cancel', t.token, { confirm: 'cancel' });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited' });
    // Another token has its own budget.
    expect((await bearer('post', '/moves/mv_NOPE/cancel', issue(['moves']).token, { confirm: 'cancel' })).status).toBe(404);
  });
});

describe('review focus', () => {
  it('1: a token on a session-only write route is 403 scope, nothing written', async () => {
    const t = issue([...OPS_SCOPES]);
    const before = auditCount();
    const live = () => (a.db.prepare('SELECT count(*) n FROM ops_tokens WHERE revoked_at IS NULL').get() as { n: number }).n;
    const tokensBefore = live();
    for (const [path, body] of [['/diag-tokens', { name: 'x' }], [`/accounts/${acc}/proxies/${px}/tokens`, { kind: 'client', label: 'x' }], ['/ops-tokens', { name: 'x', scopes: ['moves'] }]] as const) {
      const r = await bearer('post', path, t.token, body);
      expect(r.status, path).toBe(403);
      expect(r.body, path).toEqual({ error: 'scope' });
    }
    expect(auditCount()).toBe(before);
    expect(live()).toBe(tokensBefore);
    // One throttled refusal for the three: the method and the scope needed, never the path's ids or the body.
    const rec = scopeRefusals(`ops-token:${t.prefix}`);
    expect(rec).toHaveLength(1);
    expect(rec[0].outcome).toBe('refused');
    expect(JSON.parse(rec[0].detail)).toEqual({ method: 'POST', scope: null });
    for (const leak of [acc, px, t.token, '"x"']) expect(JSON.stringify(rec)).not.toContain(leak);
    expect((a.db.prepare(`SELECT count(*) n FROM proxy_tokens WHERE label = 'x'`).get() as { n: number }).n).toBe(0);
  });

  it('2: a routes token on a tokens route is 403 scope', async () => {
    const t = issue(['routes']);
    const tok = seedToken();
    const r = await bearer('post', `/accounts/${acc}/proxies/${px}/tokens/${tok}/revoke`, t.token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'scope' });
    expect((a.db.prepare('SELECT state FROM proxy_tokens WHERE id = ?').get(tok) as { state: string }).state).toBe('active');
    const rec = scopeRefusals(`ops-token:${t.prefix}`);
    expect(rec).toHaveLength(1);
    expect(JSON.parse(rec[0].detail)).toEqual({ method: 'POST', scope: 'tokens' });
    expect(JSON.stringify(rec)).not.toContain(tok);
    // Each token has its own throttle window: another one is recorded too.
    const u = issue(['routes'], 'other');
    await bearer('post', `/accounts/${acc}/proxies/${px}/tokens/${tok}/revoke`, u.token);
    expect(scopeRefusals(`ops-token:${u.prefix}`)).toHaveLength(1);
  });

  it('3: an expired, revoked or diag token on a write is 401; an ops token on the diag API is 401', async () => {
    const path = `/moves/${seedMove()}/cancel`;
    const body = { copied: 'delete', confirm: 'cancel' };
    const e = issue(['moves'], 'expired');
    a.db.prepare('UPDATE ops_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.id);
    const rv = issue(['moves'], 'revoked');
    a.ops.revoke('admin@example.com', rv.id);
    const diag = a.diag.issue('admin@example.com', { name: 'reader', days: 1 }).token;
    const before = auditOf('ops-auth-refused').length;
    for (const tok of [e.token, rv.token, diag, 'cao_' + 'x'.repeat(43), 'nope']) {
      const r = await bearer('post', path, tok, body);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthorized' });
    }
    // Throttled: one record for the burst, never keyed on the client address.
    const refused = auditOf('ops-auth-refused');
    expect(refused.length).toBe(before + 1);
    expect(refused.at(-1)!.outcome).toBe('refused');
    expect(JSON.stringify(refused)).not.toContain('cao_');
    expect((a.db.prepare('SELECT phase FROM moves WHERE id = ?').get(path.split('/')[2]) as { phase: string }).phase).toBe('copying');
    // The diag API takes only diag tokens.
    const ok = issue(['moves']);
    expect((await bearer('get', '/diag/proxies', ok.token)).status).toBe(401);
  });

  it('4: with a session cookie as well, the bearer decides', async () => {
    const path = `/moves/${seedMove()}/cancel`;
    const body = JSON.stringify({ copied: 'delete', confirm: 'cancel' });
    const e = issue(['moves'], 'expired');
    a.db.prepare('UPDATE ops_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.id);
    const withBoth = (tok: string, p = path, m: M = 'post') => request(a.app)[m](`/api/v1${p}`).set('Cookie', a.cookie).set('X-Cams-Admin', '1').set('Authorization', `Bearer ${tok}`).set('Content-Type', 'application/json').send(body);
    expect((await withBoth(e.token)).status).toBe(401);
    // A live token without the scope: the session doesn't stand in.
    const r = issue(['routes']);
    expect((await withBoth(r.token)).status).toBe(403);
    expect((await withBoth(r.token, '/diag-tokens')).status).toBe(403);
    // A GET with both: refused (tokens read nothing here).
    const g = await request(a.app).get('/api/v1/me').set('Cookie', a.cookie).set('Authorization', `Bearer ${r.token}`);
    expect(g.status).toBe(403);
    expect(g.body).toEqual({ error: 'scope' });
    // In scope: the token is the actor, not the session's e-mail.
    const m = issue(['moves']);
    expect((await withBoth(m.token)).status).toBe(202);
    expect(auditOf('move-cancel').at(-1)!.actor).toBe(`ops-token:${m.prefix}`);
  });

  it('the import route refuses a token before it reads the big body', async () => {
    const t = issue([...OPS_SCOPES]);
    // A body announced at 900 KiB (under the import's 1 MiB), of which 1 KiB is sent: a parser
    // would wait for the rest, so an answer now means the body was never read.
    const srv = createServer(a.app).listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as AddressInfo).port;
    try {
      for (const cookie of [false, true]) {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/v1/accounts/${acc}/import`, headers: {
          Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', 'Content-Length': String(900 * 1024),
          ...(cookie ? { Cookie: a.cookie, 'X-Cams-Admin': '1' } : {}),
        } });
        req.on('error', () => {});
        req.write('{"instanceId":"' + 'x'.repeat(1024));
        const [res] = (await Promise.race([once(req, 'response'), new Promise((_r, rej) => setTimeout(() => rej(new Error('the body was waited for')), 2000))])) as [IncomingMessage];
        let text = '';
        for await (const c of res) text += c;
        req.destroy();
        expect(res.statusCode, `cookie ${cookie}`).toBe(403);
        expect(JSON.parse(text)).toEqual({ error: 'scope' });
      }
    } finally {
      srv.close();
    }
    expect(auditOf('import-run')).toHaveLength(0);
  });
});

describe('the Authorization header', () => {
  it('a bare or malformed Bearer header is no token: the session decides, as on the diag API', async () => {
    for (const h of ['Bearer', 'Bearer ', 'Bearer a b', 'Basic dXNlcjpwYXNz']) {
      expect((await request(a.app).get('/api/v1/me').set('Cookie', a.cookie).set('Authorization', h)).status, h).toBe(200);
      expect((await request(a.app).get('/api/v1/diag/proxies').set('Cookie', a.cookie).set('Authorization', h)).status, h).toBe(200);
      // Without a session: 401, and the session's CSRF check still applies to a write.
      expect((await request(a.app).get('/api/v1/me').set('Authorization', h)).status, h).toBe(401);
      expect((await request(a.app).post('/api/v1/moves/mv_NOPE/cancel').set('Cookie', a.cookie).set('Authorization', h).set('Content-Type', 'application/json').send('{}')).body, h).toEqual({ error: 'csrf' });
    }
  });
});

describe('managing ops tokens', () => {
  it('a session issues (shown once, no-store), lists and revokes; a token is 403 scope', async () => {
    const r = await a.api('post', '/ops-tokens', { name: 'mac', scopes: ['routes', 'moves'], days: 7 });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ token: expect.stringMatching(/^cao_[A-Za-z0-9_-]{43}$/), item: expect.objectContaining({ name: 'mac', scopes: ['routes', 'moves'], state: 'active' }), shownOnce: true });
    const { token, item } = r.body;
    const list = await a.api('get', '/ops-tokens');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.items.find((x: { id: string }) => x.id === item.id)).toMatchObject({ name: 'mac', state: 'active' });
    expect((await a.api('post', '/ops-tokens', { name: 'bad', scopes: ['nope'] })).body).toEqual({ error: 'invalid', field: 'scopes' });
    // The token can't manage tokens, not even itself.
    expect((await bearer('get', '/ops-tokens', token)).status).toBe(403);
    expect((await bearer('post', '/ops-tokens', token, { name: 'x', scopes: ['moves'] })).status).toBe(403);
    expect((await bearer('post', `/ops-tokens/${item.id}/revoke`, token)).status).toBe(403);
    const rv = await a.api('post', `/ops-tokens/${item.id}/revoke`);
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ id: item.id, state: 'revoked', revokedBy: 'admin@example.com' });
    expect((await bearer('post', `/moves/${seedMove()}/cancel`, token, { copied: 'delete', confirm: 'cancel' })).status).toBe(401);
    expect((await a.api('post', '/ops-tokens/opt_NOPE/revoke')).status).toBe(404);
  });

  it('/me still works with a session', async () => {
    expect((await a.api('get', '/me')).body).toMatchObject({ email: 'admin@example.com' });
  });
});
