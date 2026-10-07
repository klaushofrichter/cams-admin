// The P3 API (plan Task 6): proxy settings, previews, apply by preview id,
// rollback, camera actions, rename and restart. A real server and the test
// client with the reference proxy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { RefProxyConfig } from '../test-client/config';
import type { ProxyClient } from '../test-client/client';

const dir = tmpDir();
let s: Running;
const clients: ProxyClient[] = [];
let n = 0;
const ALL = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action:camera-test', 'camera.action:camera-reboot', 'camera.name.set', 'proxy.restart'];

beforeEach(async () => {
  resetAccounts();
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000' });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow = ALL, account?: string) {
  const p = await enrolled(s, `api${n++}`, account);
  const ref = new RefProxyConfig({ cameras: ['cam1'] });
  const client = makeClient(p.key, { commands: { allow, config: ref } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  const base = `/accounts/${p.accountId}/proxies/${p.proxyId}`;
  return { ...p, client, ref, base };
}
// The raw answer: status and body, never throwing.
async function call(method: string, path: string, body?: unknown, o: { csrf?: boolean } = {}) {
  const r = await fetch(`${s.url}/api/v1${path}`, {
    method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, ...(o.csrf === false ? {} : { 'X-Cams-Admin': '1' }), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const finalOf = async (base: string, id: string) => {
  let row: any;
  await until(async () => { row = (await call('GET', `${base}/commands/${id}`)).body; return !['queued', 'sent', 'received'].includes(row.state); }, 5000, `final ${id}`);
  return row;
};
const withView = async (base: string) => until(async () => (await call('GET', `${base}/config`)).body.view !== null, 5000, 'view');

describe('the P3 API', () => {
  it('config: GET state; refresh 202 / 409 already_fetching; preview 202 → apply 202 → the proxy changed; rollback preview → apply', async () => {
    const p = await proxy();
    await withView(p.base);
    const st = (await call('GET', `${p.base}/config`)).body;
    expect(st).toMatchObject({ changedOnProxy: false, fetching: null, view: { paths: { 'sse.pingS': { v: 30, s: 'default' } } } });
    const pv = await call('POST', `${p.base}/config/preview`, { set: { 'sse.pingS': 7 } });
    expect(pv.status).toBe(202);
    expect(await finalOf(p.base, pv.body.commandId)).toMatchObject({ state: 'done', dryRun: true, result: { changes: [{ path: 'sse.pingS', from: 30, to: 7 }] } });
    const ap = await call('POST', `${p.base}/config/apply`, { previewId: pv.body.commandId });
    expect(ap.status).toBe(202);
    await finalOf(p.base, ap.body.commandId);
    expect(p.ref.current('sse.pingS')).toBe(7);
    expect((await call('POST', `${p.base}/config/apply`, { previewId: pv.body.commandId })).body).toEqual({ error: 'preview_used' });
    const rp = await call('POST', `${p.base}/config/rollback/preview`, { cmdId: ap.body.commandId });
    expect(rp.status).toBe(202);
    expect(await finalOf(p.base, rp.body.commandId)).toMatchObject({ state: 'done', result: { of: ap.body.commandId } });
    const ra = await call('POST', `${p.base}/config/rollback/apply`, { previewId: rp.body.commandId });
    expect(ra.status).toBe(202);
    await finalOf(p.base, ra.body.commandId);
    expect(p.ref.current('sse.pingS')).toBe(30);
    // Reload while a read is open (the proxy holds this one).
    await until(async () => (await call('GET', `${p.base}/config`)).body.fetching === null, 5000, 'reads done');
    p.client.dropCommands = 1;
    const rf = await call('POST', `${p.base}/config/refresh`, {});
    expect(rf.status).toBe(202);
    expect((await call('GET', `${p.base}/config`)).body.fetching).toBe(rf.body.commandId);
    expect(await call('POST', `${p.base}/config/refresh`, {})).toEqual({ status: 409, body: { error: 'already_fetching' } });
  });

  it('config error codes: 400 invalid / not_remote_settable / widening_local_only; 409 preview_required / not_rollbackable / no_view', async () => {
    const p = await proxy();
    await withView(p.base);
    expect(await call('POST', `${p.base}/config/preview`, { set: { 'cameras.cam1.host': '192.0.2.9' } })).toEqual({ status: 400, body: { error: 'not_remote_settable', field: 'cameras.cam1.host' } });
    expect(await call('POST', `${p.base}/config/preview`, { set: { 'storage.maxPercent': 10 } })).toEqual({ status: 400, body: { error: 'not_remote_settable', field: 'storage settings are local only' } });
    expect((await call('POST', `${p.base}/config/preview`, { set: { 'retention.clipsDays': 1 } })).body).toEqual({ error: 'widening_local_only', field: 'retention.clipsDays: a remote change may only keep data longer' });
    expect((await call('POST', `${p.base}/config/preview`, { set: {} })).status).toBe(400);
    expect((await call('POST', `${p.base}/config/apply`, {})).body).toEqual({ error: 'invalid', field: 'previewId' });
    expect((await call('POST', `${p.base}/config/apply`, { previewId: 'cmd_0123456789ABCDEFGHJK' })).status).toBe(404);
    const get = s.built.db.prepare(`SELECT id FROM commands WHERE command = 'config.get'`).get() as { id: string };
    expect((await call('POST', `${p.base}/config/apply`, { previewId: get.id })).body).toEqual({ error: 'preview_required' });
    expect((await call('POST', `${p.base}/config/rollback/preview`, { cmdId: get.id })).body).toEqual({ error: 'not_rollbackable' });
    const q = await proxy(['config.set']);
    expect((await call('POST', `${q.base}/config/preview`, { set: { 'sse.pingS': 7 } })).body).toEqual({ error: 'no_view' });
    expect((await call('POST', `${q.base}/config/refresh`, {})).body).toEqual({ error: 'not_allowed_on_proxy' });
  });

  it('actions: GET available; camera-test 202; disruptive needs confirm; rename 202; restart 202 / 400 confirm_required', async () => {
    const p = await proxy();
    const av = (await call('GET', `${p.base}/actions`)).body;
    expect(av).toMatchObject({ rename: true, restart: true });
    expect(av.actions.find((a: any) => a.action === 'camera-reboot')).toEqual({ action: 'camera-reboot', disruptive: true, allowed: true });
    const t = await call('POST', `${p.base}/actions`, { camera: 'cam1', action: 'camera-test' });
    expect(t.status).toBe(202);
    expect(await finalOf(p.base, t.body.commandId)).toMatchObject({ state: 'done', result: { httpStatus: 200 } });
    expect(await call('POST', `${p.base}/actions`, { camera: 'cam1', action: 'camera-reboot' })).toEqual({ status: 400, body: { error: 'confirm_required', field: 'confirm' } });
    expect((await call('POST', `${p.base}/actions`, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' })).status).toBe(202);
    expect((await call('POST', `${p.base}/actions`, { camera: 'cam1', action: 'find-camera' })).body).toEqual({ error: 'invalid', field: 'action' });
    const rn = await call('POST', `${p.base}/cameras/cam1/name`, { name: 'Porch' });
    expect(rn.status).toBe(202);
    expect(await finalOf(p.base, rn.body.commandId)).toMatchObject({ state: 'done', result: { name: 'Porch', verified: true } });
    expect(await call('POST', `${p.base}/restart`, {})).toEqual({ status: 400, body: { error: 'confirm_required', field: 'confirm' } });
    expect((await call('POST', `${p.base}/restart`, { confirm: 'proxy.restart' })).status).toBe(202);
  });

  it('every P3 route: another account\'s proxy id in the URL → 404; writes need the CSRF header', async () => {
    const p = await proxy();
    const q = await proxy(ALL, 'other');
    const wrong = `/accounts/${q.accountId}/proxies/${p.proxyId}`;
    for (const [m, path, body] of [
      ['GET', '/config'], ['POST', '/config/refresh', {}], ['POST', '/config/preview', { set: { 'sse.pingS': 7 } }], ['POST', '/config/apply', { previewId: 'cmd_0123456789ABCDEFGHJK' }],
      ['POST', '/config/rollback/preview', { cmdId: 'cmd_0123456789ABCDEFGHJK' }], ['POST', '/config/rollback/apply', { previewId: 'cmd_0123456789ABCDEFGHJK' }],
      ['GET', '/actions'], ['POST', '/actions', { camera: 'cam1', action: 'camera-test' }], ['POST', '/cameras/cam1/name', { name: 'x' }], ['POST', '/restart', { confirm: 'proxy.restart' }],
    ] as [string, string, unknown][]) {
      expect((await call(m, `${wrong}${path}`, body)).status, `${m} ${path}`).toBe(404);
      if (m === 'POST') expect((await call(m, `${p.base}${path}`, body, { csrf: false })).status, `csrf ${path}`).toBe(403);
    }
  });

  it('a GET with a body or query args changes nothing; values over 200 characters never reach /audit or a command view', async () => {
    const p = await proxy();
    await withView(p.base);
    const before = (s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n;
    expect((await call('GET', `${p.base}/config?set=1&previewId=x`)).status).toBe(200);
    expect((s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n).toBe(before);
    const long = 'N'.repeat(300);
    const pv = await call('POST', `${p.base}/config/preview`, { set: { 'cameras.cam1.name': long } });
    expect(pv.status).toBe(202);
    const audit = JSON.stringify((await call('GET', '/audit?limit=50')).body);
    expect(audit).toContain('cameras.cam1.name');
    expect(audit).toMatch(/N{200}/);
    expect(audit).not.toMatch(/N{201}/);
    const list = JSON.stringify((await call('GET', `${p.base}/commands`)).body);
    expect(list).not.toMatch(/N{201}/);
  });
});
