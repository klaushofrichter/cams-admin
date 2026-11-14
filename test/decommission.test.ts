// Remove camera / Decommission proxy (spec "decommission + account-move fixes" 2026-11-08, B4/B5): a real server and
// the test client answering camera.remove.preview, camera.remove and proxy.unenroll.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { DECOMMISSION_COMMANDS } from '../contract/build';
import { makeSummary } from '../test-client/summaries';

const dir = tmpDir();
let s: Running;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', LIMIT_COMMANDS_PER_MIN: '1000' });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
// A connected proxy reporting `cameras` (cam1, cam2, …), its allow list as given.
async function proxy(o: { allow?: string[]; cameras?: number } = {}) {
  const name = `px${n++}`;
  const p = await enrolled(s, name);
  let cameras = o.cameras ?? 2;
  const client = makeClient(p.key, { commands: { allow: o.allow ?? [...DECOMMISSION_COMMANDS] }, summary: () => {
    const sum = makeSummary({ cameras: Math.max(1, cameras), now: Date.now() });
    if (cameras === 0) sum.cameras = []; // a host without cameras
    return sum;
  } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { client, acc: p.accountId, prx: p.proxyId, name, setCameras: (k: number) => { cameras = k; } };
}
type P = Awaited<ReturnType<typeof proxy>>;
async function camera(p: P, ref: string) {
  const r = await call('POST', `/accounts/${p.acc}/cameras`, { camsId: `${p.name}-${ref}`, name: ref, kind: 'camera', proxyId: p.prx, proxyCameraId: ref, host: '192.0.2.30' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; camsId: string };
}
const audits = (action: string) => (s.built.db.prepare('SELECT outcome, actor, target_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; actor: string; target_id: string | null; detail: string }[])
  .map((x) => ({ outcome: x.outcome, actor: x.actor, targetId: x.target_id, ...JSON.parse(x.detail ?? '{}') }));
const sent = (p: P, command: string) => p.client.receivedCommands.filter((m) => m.body.command === command).map((m) => m.body.args);
const finalOf = async (acc: string, cmdId: string) => {
  let row: any;
  await until(async () => { row = (await call('GET', `/accounts/${acc}/commands/${cmdId}`)).body; return ['done', 'refused', 'failed', 'expired'].includes(row.state); }, 5000, 'final');
  return row;
};

describe('Remove camera', () => {
  it('preview: the counts from the proxy (camera.remove.preview); another account’s camera 404; a camera without a proxy 409', async () => {
    const p = await proxy();
    const c = await camera(p, 'cam1');
    const r = await call('GET', `/accounts/${p.acc}/cameras/${c.id}/remove-preview`);
    expect([r.status, r.body]).toEqual([200, { cameraId: c.id, proxyId: p.prx, camera: 'cam1', clips: 12, stills: 340, archivedClips: 2, bytes: 123_456_789 }]);
    expect(sent(p, 'camera.remove.preview')).toEqual([{ v: 1, camera: 'cam1' }]);
    const lone = (await call('POST', `/accounts/${p.acc}/cameras`, { camsId: 'lone', name: 'Lone', kind: 'camera' })).body;
    expect((await call('GET', `/accounts/${p.acc}/cameras/${lone.id}/remove-preview`)).body.error).toBe('camera_not_on_proxy');
    const other = (await call('POST', '/accounts', { name: 'other', displayName: 'Other' })).body;
    expect((await call('GET', `/accounts/${other.id}/cameras/${c.id}/remove-preview`)).status).toBe(404);
  });

  it('an older proxy (no camera.remove.preview entry) → 409 not_allowed_on_proxy, nothing sent; a proxy that says not_allowed → 424 update', async () => {
    const p = await proxy({ allow: ['camera.remove'] });
    const c = await camera(p, 'cam1');
    const r = await call('GET', `/accounts/${p.acc}/cameras/${c.id}/remove-preview`);
    expect([r.status, r.body.error]).toEqual([409, 'not_allowed_on_proxy']);
    const q = await proxy();
    const d = await camera(q, 'cam1');
    q.client.refuseNext = { code: 'not_allowed' };
    const r2 = await call('GET', `/accounts/${q.acc}/cameras/${d.id}/remove-preview`);
    expect([r2.status, r2.body.error]).toEqual([424, 'proxy_update_needed']);
  });

  it('a proxy without a handler for the preview (failed not_implemented) → 424 update', async () => {
    const p = await proxy();
    const c = await camera(p, 'cam1');
    p.client.decommissionResults.set('camera.remove.preview', { status: 'failed', code: 'not_implemented' });
    const r = await call('GET', `/accounts/${p.acc}/cameras/${c.id}/remove-preview`);
    expect([r.status, r.body.error]).toEqual([424, 'proxy_update_needed']);
  });

  it('remove, delete now with archive: typed confirm, the command, then the record goes (adopt block), audited camera-remove with the answer', async () => {
    const p = await proxy();
    const c = await camera(p, 'cam1');
    const base = `/accounts/${p.acc}/cameras/${c.id}/remove`;
    expect((await call('POST', base, { content: 'delete', archive: true })).body.error).toBe('confirm_required');
    expect((await call('POST', base, { content: 'delete', archive: true, confirm: 'nope' })).body.error).toBe('confirm_required');
    expect((await call('POST', base, { content: 'keep', archive: true, confirm: c.camsId })).body).toEqual({ error: 'invalid', field: 'archive' });
    expect((await call('POST', base, { content: 'purge', confirm: c.camsId })).body).toEqual({ error: 'invalid', field: 'content' });
    const r = await call('POST', base, { content: 'delete', archive: true, confirm: c.camsId });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const fin = await finalOf(p.acc, r.body.commandId);
    expect(fin.state).toBe('done');
    expect(sent(p, 'camera.remove')).toEqual([{ v: 1, camera: 'cam1', content: 'delete', archive: true }]);
    await until(async () => (await call('GET', `/accounts/${p.acc}/cameras/${c.id}`)).status === 404, 5000, 'record deleted');
    expect(s.built.registry.isAdoptBlocked(p.prx, 'cam1')).toBe(true);
    expect(audits('camera-remove')).toEqual([expect.objectContaining({
      outcome: 'ok', actor: 'admin@example.com', targetId: c.id, cmdId: r.body.commandId, proxyId: p.prx, proxyCameraId: 'cam1', content: 'delete', archive: true,
      removed: expect.arrayContaining(['configuration']), leftovers: [], deleted: { clips: 12, stills: 340, archivedClips: 2 },
    })]);
    expect(audits('camera-delete')).toEqual([]);
  });

  it('keep (default archive false); a proxy that fails (move_open) keeps the record, audited failed; an offline proxy → 409 proxy_offline', async () => {
    const p = await proxy();
    const c = await camera(p, 'cam1');
    p.client.decommissionResults.set('camera.remove', { status: 'failed', code: 'move_open' });
    const r = await call('POST', `/accounts/${p.acc}/cameras/${c.id}/remove`, { content: 'keep', confirm: c.camsId });
    expect(r.status).toBe(202);
    expect((await finalOf(p.acc, r.body.commandId)).state).toBe('failed');
    expect(sent(p, 'camera.remove')).toEqual([{ v: 1, camera: 'cam1', content: 'keep', archive: false }]);
    await until(() => audits('camera-remove').length === 1, 5000, 'audit');
    expect(audits('camera-remove')[0]).toMatchObject({ outcome: 'failed', state: 'failed', code: 'move_open' });
    expect((await call('GET', `/accounts/${p.acc}/cameras/${c.id}`)).status).toBe(200);
    await p.client.stop('shutdown');
    await until(() => !s.built.hub.connected(p.prx), 5000, 'offline');
    const off = await call('POST', `/accounts/${p.acc}/cameras/${c.id}/remove`, { content: 'keep', confirm: c.camsId });
    expect([off.status, off.body.error]).toEqual([409, 'proxy_offline']);
  });

  it('counts toward the fleet budget of disruptive commands', async () => {
    const p = await proxy();
    // Hold the proxy's answers: the first remove stays open.
    p.client.dropCommands = 1;
    const a = await camera(p, 'cam1');
    const q = await proxy();
    const b = await camera(q, 'cam1');
    expect((await call('POST', `/accounts/${p.acc}/cameras/${a.id}/remove`, { content: 'keep', confirm: a.camsId })).status).toBe(202);
    const r = await call('POST', `/accounts/${q.acc}/cameras/${b.id}/remove`, { content: 'keep', confirm: b.camsId });
    expect([r.status, r.body.error]).toEqual([409, 'fleet_busy']);
  });
});

describe('Decommission proxy', () => {
  it('refused while the proxy reports cameras (named); typed confirm; then unenroll, the record deleted, keys revoked, audited', async () => {
    const p = await proxy({ cameras: 1 });
    const base = `/accounts/${p.acc}/proxies/${p.prx}`;
    const pre = (await call('GET', `${base}/decommission-preview`)).body;
    expect(pre).toMatchObject({ reportedCameras: ['cam1'], connected: true, activeMoves: 0, switches: [] });
    const busy = await call('POST', `${base}/decommission`, { confirm: p.name });
    expect([busy.status, busy.body.error, busy.body.message]).toEqual([409, 'has_cameras', 'the proxy reports cam1: remove it first']);
    p.setCameras(0);
    await until(() => (s.built.status.row(p.prx)?.reported?.cameras.length ?? 1) === 0, 5000, 'no cameras reported');
    expect((await call('POST', `${base}/decommission`, { confirm: 'nope' })).body.error).toBe('confirm_required');
    const r = await call('POST', `${base}/decommission`, { confirm: p.name });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const fin = await finalOf(p.acc, r.body.commandId);
    expect(fin).toMatchObject({ state: 'done', command: 'proxy.unenroll' });
    await until(async () => (await call('GET', base)).status === 404, 5000, 'record deleted');
    // The answer stays readable by account after the proxy's record is gone.
    expect((await call('GET', `/accounts/${p.acc}/commands/${r.body.commandId}`)).body).toMatchObject({ state: 'done', proxyId: null });
    expect(audits('proxy-unenroll')).toEqual([expect.objectContaining({ outcome: 'ok', targetId: p.prx, cmdId: r.body.commandId, unenrollAt: expect.any(Number) })]);
    expect(audits('proxy-delete').map((x) => x.targetId)).toEqual([p.prx]);
    expect(s.built.db.prepare('SELECT count(*) n FROM proxy_keys WHERE proxy_id = ? AND revoked_at IS NULL').get(p.prx)).toEqual({ n: 0 });
  });

  it('a proxy that refuses (has_cameras) keeps its record; offline → 409 proxy_offline; another account 404', async () => {
    const p = await proxy({ cameras: 0 });
    await until(() => (s.built.status.row(p.prx)?.reported?.cameras.length ?? 1) === 0, 5000, 'no cameras reported');
    const base = `/accounts/${p.acc}/proxies/${p.prx}`;
    p.client.decommissionResults.set('proxy.unenroll', { status: 'failed', code: 'has_cameras' });
    const r = await call('POST', `${base}/decommission`, { confirm: p.name });
    expect((await finalOf(p.acc, r.body.commandId)).state).toBe('failed');
    await until(() => audits('proxy-unenroll').length === 1, 5000, 'audit');
    expect(audits('proxy-unenroll')[0]).toMatchObject({ outcome: 'failed', code: 'has_cameras' });
    expect((await call('GET', base)).status).toBe(200);
    const other = (await call('POST', '/accounts', { name: 'other2', displayName: 'Other' })).body;
    expect((await call('POST', `/accounts/${other.id}/proxies/${p.prx}/decommission`, { confirm: p.name })).status).toBe(404);
    await p.client.stop('shutdown');
    await until(() => !s.built.hub.connected(p.prx), 5000, 'offline');
    const off = await call('POST', `${base}/decommission`, { confirm: p.name });
    expect([off.status, off.body.error]).toEqual([409, 'proxy_offline']);
  });
});
