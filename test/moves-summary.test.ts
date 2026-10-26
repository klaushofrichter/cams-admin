// The content summary before a move (Start move form): GET /accounts/:accountId/cameras/:cameraId/move-summary
// sends move.summary to the camera's proxy and waits for its answer; with a target it adds the space figures
// against the target's profile. An older proxy, an offline one, a refusal and a timeout each say so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProfile, makeProxyInfo } from '../test-client/summaries';
import { moveSummaryOf } from '../test-client/commands';
import type { ProxyClient } from '../test-client/client';

const ACTOR = 'admin@example.com';
const FP = 'SHA256:' + 'CD'.repeat(32);
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000', MOVE_SUMMARY_WAIT_MS: '400' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string }
async function proxy(o: { allow?: string[]; profile?: () => unknown; account?: string } = {}): Promise<Px> {
  const name = `ms${n++}`;
  const p = await enrolled(s, name, o.account ?? 'home');
  const client = makeClient(p.key, { commands: { allow: o.allow ?? ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site: `site-${name}`, caFingerprint: [FP] }), ...(o.profile ? { profile: o.profile } : {}) });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands && (!o.profile || !!s.built.status.row(p.proxyId)?.reported?.profile), 5000, 'connected');
  return { ...p, client, name };
}
const camera = (src: Px, proxyCameraId: string | null = 'cam1') =>
  s.built.registry.createCamera(ACTOR, src.accountId, { camsId: `c${n++}`, name: 'Porch', kind: 'camera', ...(proxyCameraId ? { proxyId: src.proxyId, proxyCameraId } : {}), host: '192.0.2.10', protocol: 'https' });
const path = (accountId: string, cameraId: string) => `/accounts/${accountId}/cameras/${cameraId}/move-summary`;
// The HTTP answer: status and body (s.api throws on >= 300; it sends the X-Cams-Admin header).
async function ask(accountId: string, cameraId: string, q: { targetProxyId?: unknown } = {}) {
  const qs = q.targetProxyId === undefined ? '' : `?target=${encodeURIComponent(String(q.targetProxyId))}`;
  try { return { status: 200, body: await s.api('GET', path(accountId, cameraId) + qs) }; } catch (e) { return { status: (e as { status: number }).status, body: (e as { body: any }).body }; }
}
const got = (c: ProxyClient, command: string) => c.receivedCommands.filter((m) => m.body.command === command);
const audits = (action: string) => (s.built.db.prepare('SELECT action, detail FROM audit_log WHERE action = ?').all(action) as { detail: string }[]).map((r) => JSON.parse(r.detail));

describe('move.summary before a move', () => {
  it('a session request without the X-Cams-Admin header is refused (403 csrf) and sends nothing', async () => {
    const src = await proxy();
    const cam = camera(src);
    const r = await fetch(`${s.url}/api/v1${path(src.accountId, cam.id)}`, { headers: { Cookie: `__Host-cams_admin=${s.cookie}` } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'csrf' });
    expect(got(src.client, 'move.summary')).toHaveLength(0);
  });

  it("answers the source's summary for the camera, sent as move.summary {v, camera} (read only: no move-* audit)", async () => {
    const src = await proxy();
    const cam = camera(src);
    const r = await ask(src.accountId, cam.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ cameraId: cam.id, proxyId: src.proxyId, summary: moveSummaryOf(), space: null, target: null });
    expect(got(src.client, 'move.summary').map((m) => m.body.args)).toEqual([{ v: 1, camera: 'cam1' }]);
    // A command like config.get: its command-create and command-result records, nothing of a move.
    expect(audits('command-create').filter((d) => d.command === 'move.summary')).toHaveLength(1);
    expect((s.built.db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'move-%'").get() as { n: number }).n).toBe(0);
    expect(s.built.moves.store.list()).toEqual([]);
  });

  it('with a target: the space figures against its profile (budget left, fits or not); none without a profile', async () => {
    const src = await proxy();
    const roomy = await proxy({ profile: () => makeProfile({ budgetBytes: 100_000_000, usedBytes: 40_000_000 }) });
    const tight = await proxy({ profile: () => makeProfile({ budgetBytes: 100_000_000, usedBytes: 99_999_000 }) });
    const old = await proxy();
    const cam = camera(src);
    const need = Object.values(moveSummaryOf()).reduce((t: number, k) => t + (k as { bytes: number }).bytes, 0);
    const a = await ask(src.accountId, cam.id, { targetProxyId: roomy.proxyId });
    expect(a.body.space).toMatchObject({ needBytes: need, budgetBytes: 100_000_000, usedBytes: 40_000_000, leftBytes: 60_000_000, fits: true, overCaps: [] });
    expect(a.body.target).toEqual({ proxyId: roomy.proxyId, name: roomy.name, profile: true });
    const b = await ask(src.accountId, cam.id, { targetProxyId: tight.proxyId });
    expect(b.body.space).toMatchObject({ leftBytes: 1000, fits: false });
    const c = await ask(src.accountId, cam.id, { targetProxyId: old.proxyId });
    expect(c.body).toMatchObject({ space: null, target: { proxyId: old.proxyId, profile: false } });
    // The summary is kept for a short while: three answers, one command.
    expect(got(src.client, 'move.summary')).toHaveLength(1);
  });

  it('a second ask for the same camera while the first waits shares its command', async () => {
    const src = await proxy();
    const cam = camera(src);
    const [a, b] = await Promise.all([ask(src.accountId, cam.id), ask(src.accountId, cam.id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(got(src.client, 'move.summary')).toHaveLength(1);
  });

  it('an older proxy (move.summary unknown: not_allowed) is 424 proxy_update_needed with the release it needs', async () => {
    const src = await proxy();
    const cam = camera(src);
    src.client.moveResults['move.summary'] = { status: 'refused', code: 'not_allowed' };
    const r = await ask(src.accountId, cam.id);
    expect(r).toEqual({ status: 424, body: { error: 'proxy_update_needed', detail: 'the proxy needs cam-proxy 2026.10.26 or later' } });
  });

  it('the proxy does not know the camera: 409 unknown_camera; another failure is 502 with its code', async () => {
    const src = await proxy();
    const cam = camera(src);
    src.client.moveResults['move.summary'] = { status: 'failed', code: 'unknown_camera' };
    expect(await ask(src.accountId, cam.id)).toMatchObject({ status: 409, body: { error: 'unknown_camera' } });
    src.client.moveResults['move.summary'] = { status: 'failed', code: 'internal' };
    expect(await ask(src.accountId, cam.id)).toMatchObject({ status: 502, body: { error: 'proxy_failed', detail: 'internal' } });
    src.client.moveResults['move.summary'] = { status: 'ok', result: { nothing: true } };
    expect(await ask(src.accountId, cam.id)).toMatchObject({ status: 502, body: { error: 'bad_result' } });
  });

  it('no answer in time: 504 timeout', async () => {
    const src = await proxy();
    const cam = camera(src);
    src.client.dropCommands = 1;
    const t = Date.now();
    expect(await ask(src.accountId, cam.id)).toMatchObject({ status: 504, body: { error: 'timeout' } });
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('refused before anything is sent: offline source, moves not allowed, a camera on no proxy, another account, unknown ids', async () => {
    const src = await proxy({ allow: ['move.receive'] });
    const cam = camera(src);
    expect(await ask(src.accountId, cam.id)).toMatchObject({ status: 409, body: { error: 'not_allowed_on_proxy' } });
    const loose = camera(src, null);
    expect(await ask(src.accountId, loose.id)).toMatchObject({ status: 409, body: { error: 'camera_not_on_proxy' } });
    const other = await proxy({ account: 'other' });
    expect(await ask(other.accountId, cam.id)).toMatchObject({ status: 404 });
    expect(await ask(src.accountId, cam.id, { targetProxyId: other.proxyId })).toMatchObject({ status: 404, body: { error: 'not_found', field: 'targetProxyId' } });
    expect(await ask(src.accountId, cam.id, { targetProxyId: 'x'.repeat(65) })).toMatchObject({ status: 400, body: { error: 'invalid', field: 'targetProxyId' } });
    const off = await proxy();
    const offCam = camera(off);
    await off.client.stop('shutdown');
    await until(() => s.built.status.row(off.proxyId)?.connected !== true, 5000, 'offline');
    expect(await ask(off.accountId, offCam.id)).toMatchObject({ status: 409, body: { error: 'source_offline' } });
    expect(got(src.client, 'move.summary')).toHaveLength(0);
  });
});
