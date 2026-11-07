// PoE switches: camera power (design 2026-11-07-poe-switches-design.md, "Verify", "Power-cycle", "Survey").
// A real server on a fake clock and the test client answering the switch commands with canned results.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { POWER_COMMANDS, SWITCH_COMMANDS } from '../contract/build';
import type { CameraPower } from '../server/switches/store';
import { SYSTEM } from '../server/switches/power';
import { SurveySchedule } from '../server/switches/schedule';
import { nextRunAt } from '../server/backup/scheduler';
import { makeSummary } from '../test-client/summaries';

const ACTOR = 'admin@example.com';
const ALL = [...SWITCH_COMMANDS, ...POWER_COMMANDS];
const HOST_UNKNOWN = 'camera host unknown in cams-admin';
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  reportedAddr = {};
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000', LIMIT_COMMANDS_PER_MIN: '1000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

// The cameras' reported addresses (summary camera.address) by proxy camera id; undefined → none reported.
let reportedAddr: Record<string, string | undefined> = {};
async function proxy(allow: string[] = ALL) {
  const p = await enrolled(s, `pw${n++}`);
  const summary = () => {
    const sum = makeSummary({ cameras: 2, now: Date.now() });
    for (const c of sum.cameras as { camera: { id: string; address?: string } }[]) {
      if (!(c.camera.id in reportedAddr)) continue;
      const a = reportedAddr[c.camera.id];
      if (a === undefined) delete c.camera.address;
      else c.camera.address = a;
    }
    return sum;
  };
  const client = makeClient(p.key, { commands: { allow }, summary });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { client, acc: p.accountId, prx: p.proxyId };
}
type P = Awaited<ReturnType<typeof proxy>>;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
// A camera of the proxy (before any switch is active: a new camera triggers a survey).
async function camera(p: P, host: string | null = `192.168.60.${20 + n}`) {
  const tag = `c${n++}`;
  const r = await call('POST', `/accounts/${p.acc}/cameras`, { camsId: tag, name: tag, kind: 'camera', proxyId: p.prx, proxyCameraId: tag, ...(host ? { host } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; camsId: string; proxyCameraId: string; host: string | null };
}
// An active switch without the test (no onActive survey).
async function sw(p: P, name: string, extra: Record<string, unknown> = {}) {
  const r = await call('POST', `/accounts/${p.acc}/switches`, { name, host: '192.168.1.217', proxyId: p.prx, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return s.built.switches.store.updateSwitch(ACTOR, p.acc, r.body.id, { state: 'active', sn: `SN${n++}` });
}
const setPower = (camId: string, power: CameraPower) => s.built.switches.store.setPower(camId, power, ACTOR, 'sysadmin', 'test');
const power = async (camId: string) => (await call('GET', `/cameras/${camId}/power`)).body;
const sent = (p: P, command: string) => p.client.receivedCommands.filter((m) => m.body.command === command).map((m) => m.body.args);
const commands = (p: P) => p.client.receivedCommands.map((m) => m.body.command as string);
const audits = (action: string) => (s.built.db.prepare('SELECT outcome, target_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; target_id: string; detail: string }[])
  .map((x) => ({ outcome: x.outcome, targetId: x.target_id, ...JSON.parse(x.detail ?? '{}') }));
const found = (port: number, watts: number) => ({ status: 'ok' as const, result: { sn: null, found: true, port, poe: true, watts, link: true } });
const notFound = (reason = 'no_traffic') => ({ status: 'ok' as const, result: { sn: null, found: false, reason } });
const checkDone = (camId: string) => until(async () => ['ok', 'failed'].includes((await power(camId)).lastCheck?.state), 5000, 'check done');
const cycleDone = (camId: string) => until(async () => ['ok', 'failed'].includes((await power(camId)).lastCycle?.state), 5000, 'cycle done');

describe('camera power', () => {
  it('verify: found on the mapped port → verifiedAt and watts updated', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', found(3, 4.5));
    const r = await call('POST', `/cameras/${cam.id}/power/verify`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.commandId).toMatch(/^cmd_/);
    await checkDone(cam.id);
    const v = await power(cam.id);
    expect(v.power).toEqual({ kind: 'poe', switchId: a.id, port: 3, watts: 4.5, verifiedAt: clock.now() });
    expect(v.lastCheck).toMatchObject({ op: 'verify', state: 'ok' });
    expect(v.switch).toMatchObject({ id: a.id, name: 'Alpha' });
    expect(sent(p, 'switch.locate')).toEqual([{ v: 1, switch: { id: a.id, model: 'sscpoe-web', host: '192.168.1.217', ports: 8, offSeconds: 10 }, host: cam.host }]);
  });

  it('verify: not on the mapped switch → search (by name, first found wins) → the record moves, audited, camera.power.set sent', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const z = await sw(p, 'Zulu');
    const b = await sw(p, 'Bravo');
    await sw(p, 'Charlie');
    setPower(cam.id, { kind: 'poe', switchId: z.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', (a) => (a.switch.id === b.id ? found(2, 3.9) : notFound()));
    expect((await call('POST', `/cameras/${cam.id}/power/verify`)).status).toBe(202);
    await checkDone(cam.id);
    expect(sent(p, 'switch.locate').map((a) => a.switch.id)).toEqual([z.id, b.id]);
    expect((await power(cam.id)).power).toEqual({ kind: 'poe', switchId: b.id, port: 2, watts: 3.9, verifiedAt: clock.now() });
    expect(audits('camera-power-set').at(-1)).toMatchObject({ outcome: 'ok', targetId: cam.id, to: { kind: 'poe', switchId: b.id, port: 2 } });
    await until(() => sent(p, 'camera.power.set').length > 0, 5000, 'power set');
    expect(sent(p, 'camera.power.set').at(-1)).toEqual({ v: 1, camera: cam.proxyCameraId, power: { kind: 'poe', switchName: 'Bravo', port: 2, watts: 3.9, verifiedAt: clock.now() } });
  });

  it('found nowhere: verify fails with the reasons, the record stays', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', notFound('not_reachable'));
    await call('POST', `/cameras/${cam.id}/power/verify`);
    await checkDone(cam.id);
    const v = await power(cam.id);
    expect(v.power).toEqual({ kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    expect(v.lastCheck).toMatchObject({ state: 'failed', code: 'not_found' });
    expect(v.lastCheck.reason).toMatch(/Alpha: camera not reachable from the operator/);
  });

  it('locate with 0 W → data-only; a cycle, forced or not, → 409 not_poe', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    p.client.switchResults.set('switch.locate', { status: 'ok', result: { sn: null, found: true, port: 4, poe: true, watts: 0, link: true } });
    const r = await call('PUT', `/cameras/${cam.id}/power`, { kind: 'auto' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await checkDone(cam.id);
    expect((await power(cam.id)).power).toEqual({ kind: 'data-only', switchId: a.id, port: 4, verifiedAt: clock.now() });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).body).toMatchObject({ error: 'not_poe' });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, { force: true })).body).toMatchObject({ error: 'not_poe' });
    expect(sent(p, 'switch.cycle')).toEqual([]);
  });

  it('declare adapter; propose a port: saved only when the traffic is on it', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    const r = await call('PUT', `/cameras/${cam.id}/power`, { kind: 'adapter' });
    expect([r.status, r.body.power]).toEqual([200, { kind: 'adapter' }]);
    expect((await call('POST', `/cameras/${cam.id}/power/verify`)).body).toMatchObject({ error: 'adapter' });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).body).toMatchObject({ error: 'not_poe' });
    p.client.switchResults.set('switch.locate', found(3, 5));
    expect((await call('PUT', `/cameras/${cam.id}/power`, { switchId: a.id, port: 5 })).status).toBe(202);
    await checkDone(cam.id);
    expect(await power(cam.id)).toMatchObject({ power: { kind: 'adapter' }, lastCheck: { op: 'propose', state: 'failed', code: 'not_on_port' } });
    expect((await call('PUT', `/cameras/${cam.id}/power`, { switchId: a.id, port: 3 })).status).toBe(202);
    await checkDone(cam.id);
    expect((await power(cam.id)).power).toEqual({ kind: 'poe', switchId: a.id, port: 3, watts: 5, verifiedAt: clock.now() });
    for (const body of [{ switchId: a.id, port: 9 }, { switchId: a.id }, { kind: 'other' }, { kind: 'adapter', x: 1 }]) {
      expect((await call('PUT', `/cameras/${cam.id}/power`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('forced cycle of a poe camera: switch.cycle with force and no host, audited as forced, cycling/cycled to its proxy', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    const r = await call('POST', `/cameras/${cam.id}/power/cycle`, { force: true });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle')).toEqual([{ v: 1, switch: expect.objectContaining({ id: a.id }), port: 3, host: null, force: true, camera: cam.id }]);
    expect((await power(cam.id)).lastCycle).toMatchObject({ force: true, state: 'ok', requestedAt: expect.any(Number) });
    expect(audits('camera-power-cycle-forced')).toEqual([expect.objectContaining({ outcome: 'ok', targetId: cam.id, switchId: a.id, port: 3 })]);
    await until(() => sent(p, 'camera.power.cycled').length > 0, 5000, 'cycled');
    const order = commands(p).filter((c) => c === 'camera.power.cycling' || c === 'switch.cycle' || c === 'camera.power.cycled');
    expect(order).toEqual(['camera.power.cycling', 'switch.cycle', 'camera.power.cycled']);
    expect(sent(p, 'camera.power.cycled')[0]).toMatchObject({ camera: cam.proxyCameraId, ok: true });
  });

  it('unforced cycle answered not_verified → search → one cycle on the found port (no loop)', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    const b = await sw(p, 'Bravo');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', (x) => (x.switch.id === b.id ? found(5, 4.1) : notFound()));
    // Every cycle answers not_verified: the retry on Bravo is the last one.
    p.client.switchResults.set('switch.cycle', { status: 'failed', code: 'not_verified' });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).status).toBe(202);
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle').map((x) => [x.switch.id, x.port, x.host, x.force])).toEqual([[a.id, 3, cam.host, false], [b.id, 5, cam.host, false]]);
    expect((await power(cam.id)).power).toMatchObject({ kind: 'poe', switchId: b.id, port: 5 });
    expect((await power(cam.id)).lastCycle).toMatchObject({ force: false, state: 'failed', code: 'not_verified' });
    // Now Bravo cycles.
    p.client.switchResults.set('switch.cycle', (x) => (x.switch.id === b.id ? { status: 'ok', result: { verified: true, offAt: 1, onAt: 2, watts: 4.3 } } : { status: 'failed', code: 'not_verified' }));
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    await call('POST', `/cameras/${cam.id}/power/cycle`, {});
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle')).toHaveLength(4);
    expect(await power(cam.id)).toMatchObject({ power: { kind: 'poe', switchId: b.id, port: 5, watts: 4.3 }, lastCycle: { state: 'ok' } });
  });

  it('unforced cycle: the retry answered not_verified too → no second search, even if the camera moved again', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    const b = await sw(p, 'Bravo');
    const c = await sw(p, 'Charlie');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    let searches = 0;
    // The first search finds it on Bravo; any later one would find it on Charlie.
    p.client.switchResults.set('switch.locate', (x) => (x.switch.id === b.id && searches++ === 0 ? found(5, 4) : x.switch.id === c.id ? found(1, 4) : notFound()));
    p.client.switchResults.set('switch.cycle', { status: 'failed', code: 'not_verified' });
    await call('POST', `/cameras/${cam.id}/power/cycle`, {});
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle').map((x) => x.switch.id)).toEqual([a.id, b.id]);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'failed', code: 'not_verified' });
  });

  it('unforced cycle: not_verified and found on the same port again → no retry', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', found(3, 4));
    p.client.switchResults.set('switch.cycle', { status: 'failed', code: 'not_verified' });
    await call('POST', `/cameras/${cam.id}/power/cycle`, {});
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle')).toHaveLength(1);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'failed', code: 'not_verified' });
  });

  it('unknown power → 409 power_unknown; without camera.power.* allowed the cycle still runs', async () => {
    const p = await proxy([...SWITCH_COMMANDS]);
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).body).toMatchObject({ error: 'power_unknown' });
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).status).toBe(202);
    await cycleDone(cam.id);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'ok' });
    expect(commands(p).filter((c) => c.startsWith('camera.power'))).toEqual([]);
  });

  it('a camera without host: the reason everywhere', async () => {
    const p = await proxy();
    const cam = await camera(p, null);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    for (const [m, path, body] of [['POST', 'verify', {}], ['POST', 'cycle', {}], ['PUT', '', { kind: 'auto' }], ['PUT', '', { switchId: a.id, port: 3 }]] as const) {
      const r = await call(m, `/cameras/${cam.id}/power${path ? `/${path}` : ''}`, body);
      expect([r.status, r.body], `${m} ${path} ${JSON.stringify(body)}`).toEqual([409, { error: 'host_unknown', message: HOST_UNKNOWN }]);
    }
    expect(s.built.power.cycle(SYSTEM, cam.id, {})).toEqual({ ok: false, code: 'host_unknown', reason: HOST_UNKNOWN });
    // A forced cycle needs no host: it sends host null.
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, { force: true })).status).toBe(202);
    await cycleDone(cam.id);
    expect(sent(p, 'switch.cycle')).toEqual([{ v: 1, switch: expect.objectContaining({ id: a.id }), port: 3, host: null, force: true, camera: cam.id }]);
    expect((await power(cam.id)).lastCycle).toMatchObject({ force: true, state: 'ok' });
  });

  it("an adopted camera (host from-proxy) takes its proxy's reported address: verify, cycle, survey; none reported → host unknown", async () => {
    reportedAddr = { cam1: '192.0.2.77:443', cam2: undefined };
    const p = await proxy();
    await until(() => s.built.status.row(p.prx)?.reported?.cameras.find((c) => c.ref === 'cam1')?.address === '192.0.2.77:443', 5000, 'address reported');
    const adopt = async (ref: string) => {
      const r = await call('POST', `/accounts/${p.acc}/proxies/${p.prx}/adopt`, { proxyCameraId: ref });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.host).toBe('from-proxy');
      return r.body as { id: string };
    };
    const c1 = await adopt('cam1');
    const c2 = await adopt('cam2');
    const a = await sw(p, 'Alpha');
    setPower(c1.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    setPower(c2.id, { kind: 'poe', switchId: a.id, port: 4, watts: 4 });
    p.client.switchResults.set('switch.locate', found(3, 4));
    expect((await call('POST', `/cameras/${c1.id}/power/verify`)).status).toBe(202);
    await checkDone(c1.id);
    expect(sent(p, 'switch.locate').map((x) => x.host)).toEqual(['192.0.2.77']);
    expect((await call('POST', `/cameras/${c1.id}/power/cycle`, {})).status).toBe(202);
    await cycleDone(c1.id);
    expect(sent(p, 'switch.cycle').map((x) => [x.host, x.force])).toEqual([['192.0.2.77', false]]);
    expect((await call('POST', `/switches/${a.id}/survey`)).status).toBe(202);
    await until(async () => (await call('GET', `/switches/${a.id}/survey`)).body.state === 'done', 5000, 'survey done');
    expect(sent(p, 'switch.survey')[0].cameras).toEqual([{ camera: c1.id, host: '192.0.2.77' }]);
    expect((await call('GET', `/switches/${a.id}/survey`)).body.results.find((x: { cameraId: string }) => x.cameraId === c2.id)).toMatchObject({ found: false, reason: HOST_UNKNOWN });
    expect((await call('POST', `/cameras/${c2.id}/power/verify`)).body).toEqual({ error: 'host_unknown', message: HOST_UNKNOWN });
  });

  it('adopting a camera, and a changed reported address, each trigger one survey', async () => {
    reportedAddr = { cam1: '192.0.2.77' };
    const p = await proxy();
    await until(() => s.built.status.row(p.prx)?.reported?.cameras.find((c) => c.ref === 'cam1')?.address === '192.0.2.77', 5000, 'address reported');
    const a = await sw(p, 'Alpha');
    const surveyDone = () => until(async () => (await call('GET', `/switches/${a.id}/survey`)).body.state === 'done', 5000, 'survey done');
    expect((await call('POST', `/accounts/${p.acc}/proxies/${p.prx}/adopt`, { proxyCameraId: 'cam1' })).status).toBe(201);
    await until(() => sent(p, 'switch.survey').length === 1, 5000, 'survey after adopt');
    await surveyDone();
    reportedAddr.cam1 = '192.0.2.78';
    await until(() => sent(p, 'switch.survey').length === 2, 5000, 'survey after an address change');
    await surveyDone();
    expect(sent(p, 'switch.survey')[1].cameras).toEqual([expect.objectContaining({ host: '192.0.2.78' })]);
    // More heartbeats (every 0.2 s) with the same address: no more surveys.
    await new Promise((r) => setTimeout(r, 800));
    expect(sent(p, 'switch.survey')).toHaveLength(2);
  });

  it('survey: 20 cameras → 2 commands; found → mapped; not seen keeps the mapping with notSeen; not_reachable sets nothing', async () => {
    const p = await proxy();
    const cams: Awaited<ReturnType<typeof camera>>[] = [];
    for (let i = 0; i < 20; i++) cams.push(await camera(p, `10.0.0.${i + 1}`));
    const noHost = await camera(p, null);
    const adapter = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(adapter.id, { kind: 'adapter' });
    setPower(cams[1].id, { kind: 'poe', switchId: a.id, port: 2, watts: 4 });
    setPower(cams[2].id, { kind: 'poe', switchId: a.id, port: 6, watts: 4 });
    p.client.switchResults.set('switch.survey', (x) => ({ status: 'ok', result: { sn: null, results: x.cameras.map((c: { camera: string }) =>
      c.camera === cams[0].id ? { camera: c.camera, found: true, port: 1, poe: true, watts: 3 }
        : c.camera === cams[2].id ? { camera: c.camera, found: false, reason: 'not_reachable' }
          : { camera: c.camera, found: false, reason: 'no_traffic' }) } }));
    const r = await call('POST', `/switches/${a.id}/survey`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.commandIds).toHaveLength(2);
    await until(async () => (await call('GET', `/switches/${a.id}/survey`)).body.state === 'done', 5000, 'survey done');
    const args = sent(p, 'switch.survey');
    expect(args.map((x) => x.cameras.length)).toEqual([16, 4]);
    const surveyed = args.flatMap((x) => x.cameras.map((c: { camera: string }) => c.camera));
    expect(surveyed).not.toContain(noHost.id);
    expect(surveyed).not.toContain(adapter.id);
    expect(args[0].cameras[0]).toEqual({ camera: cams[0].id, host: '10.0.0.1' });
    expect((await power(cams[0].id)).power).toEqual({ kind: 'poe', switchId: a.id, port: 1, watts: 3, verifiedAt: clock.now() });
    expect((await power(cams[1].id)).power).toEqual({ kind: 'poe', switchId: a.id, port: 2, watts: 4, notSeen: true });
    expect((await power(cams[2].id)).power).toEqual({ kind: 'poe', switchId: a.id, port: 6, watts: 4 });
    expect((await power(cams[3].id)).power).toEqual({ kind: 'unknown' });
    const view = (await call('GET', `/switches/${a.id}/survey`)).body;
    expect(view.results.find((x: { cameraId: string }) => x.cameraId === cams[2].id)).toMatchObject({ found: false, reason: 'not_reachable' });
    expect(view.results.find((x: { cameraId: string }) => x.cameraId === noHost.id)).toMatchObject({ found: false, reason: HOST_UNKNOWN });
    // A later survey that finds it clears notSeen.
    p.client.switchResults.set('switch.survey', (x) => ({ status: 'ok', result: { sn: null, results: x.cameras.map((c: { camera: string }) =>
      c.camera === cams[1].id ? { camera: c.camera, found: true, port: 2, poe: true, watts: 4 } : { camera: c.camera, found: false, reason: 'no_traffic' }) } }));
    await call('POST', `/switches/${a.id}/survey`);
    await until(async () => sent(p, 'switch.survey').length === 4 && (await call('GET', `/switches/${a.id}/survey`)).body.state === 'done', 5000, 'survey 2 done');
    expect((await power(cams[1].id)).power).toEqual({ kind: 'poe', switchId: a.id, port: 2, watts: 4, verifiedAt: clock.now() });
  });

  it('surveys are debounced: at most one queued per switch', async () => {
    const p = await proxy();
    await camera(p);
    const a = await sw(p, 'Alpha');
    const first = s.built.power.survey(SYSTEM, a.id);
    expect(first.commandIds).toHaveLength(1);
    expect(s.built.power.survey(SYSTEM, a.id)).toEqual({ commandIds: [], queued: true });
    expect(s.built.power.survey(SYSTEM, a.id)).toEqual({ commandIds: [], queued: true });
    await until(() => sent(p, 'switch.survey').length === 2, 5000, 'queued survey ran');
    await until(async () => (await call('GET', `/switches/${a.id}/survey`)).body.state === 'done', 5000, 'done');
    expect(sent(p, 'switch.survey')).toHaveLength(2);
  });

  it('triggers: a switch becoming active, a new camera, a changed host, the account survey', async () => {
    const p = await proxy();
    await camera(p);
    const r = await call('POST', `/accounts/${p.acc}/switches`, { name: 'Alpha', host: '192.168.1.217', proxyId: p.prx });
    p.client.switchResults.set('switch.read', { status: 'ok', result: { sn: 'GPS', firmware: 'V1', ports: [] } });
    await call('POST', `/switches/${r.body.id}/test`);
    await until(() => sent(p, 'switch.survey').length === 1, 5000, 'survey after test');
    await until(async () => (await call('GET', `/switches/${r.body.id}/survey`)).body.state === 'done', 5000, 'done');
    const cam = await camera(p);
    await until(() => sent(p, 'switch.survey').length === 2, 5000, 'survey after camera create');
    await until(async () => (await call('GET', `/switches/${r.body.id}/survey`)).body.state === 'done', 5000, 'done');
    const v = (await call('GET', `/accounts/${p.acc}/cameras/${cam.id}`)).body.version;
    expect((await call('PATCH', `/accounts/${p.acc}/cameras/${cam.id}`, { host: '10.1.1.1', version: v })).status).toBe(200);
    await until(() => sent(p, 'switch.survey').length === 3, 5000, 'survey after host change');
    await until(async () => (await call('GET', `/switches/${r.body.id}/survey`)).body.state === 'done', 5000, 'done');
    const all = await call('POST', `/accounts/${p.acc}/switches/survey`);
    expect(all.status).toBe(202);
    expect(all.body.switches).toEqual([{ switchId: r.body.id, commandIds: [expect.stringMatching(/^cmd_/)], queued: false }]);
    expect(audits('command-create').filter((x) => x.command === 'switch.survey').map((x) => x.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('the daily survey runs at 03:30 from the server tick', async () => {
    const p = await proxy();
    await camera(p);
    const a = await sw(p, 'Alpha');
    await sw(p, 'Off', { survey: false });
    const at = s.built.surveys.nextAt;
    clock.set(at - 1000);
    s.built.tick();
    expect(sent(p, 'switch.survey')).toHaveLength(0);
    clock.set(at);
    s.built.tick();
    await until(() => sent(p, 'switch.survey').length === 1, 5000, 'daily survey');
    expect(sent(p, 'switch.survey')[0].switch.id).toBe(a.id);
    expect(s.built.surveys.nextAt).toBeGreaterThan(at);
  });
});

describe('SurveySchedule', () => {
  it('fires once at 03:30 in its time zone, then the next day', () => {
    const c = fakeClock(Date.UTC(2026, 10, 7, 3, 0));
    const runs: number[] = [];
    const sch = new SurveySchedule({ clock: c, tz: 'UTC', run: () => runs.push(c.now()) });
    expect(sch.nextAt).toBe(Date.UTC(2026, 10, 7, 3, 30));
    expect(sch.nextAt).toBe(nextRunAt(Date.UTC(2026, 10, 7, 3, 0), '03:30', 'UTC'));
    sch.tick();
    c.set(Date.UTC(2026, 10, 7, 3, 29, 59));
    sch.tick();
    expect(runs).toEqual([]);
    c.set(Date.UTC(2026, 10, 7, 3, 30));
    sch.tick();
    sch.tick();
    expect(runs).toEqual([Date.UTC(2026, 10, 7, 3, 30)]);
    expect(sch.nextAt).toBe(Date.UTC(2026, 10, 8, 3, 30));
    c.set(Date.UTC(2026, 10, 8, 3, 31));
    sch.tick();
    expect(runs).toHaveLength(2);
  });
});

// Whole-branch review (branch-admin-review.md): I1 audits, I2 camera.power.set, I3 trunk ports.
describe('camera power: review fixes', () => {
  const surveyDone = (id: string, count: number, p: P) => until(async () => sent(p, 'switch.survey').length >= count && (await call('GET', `/switches/${id}/survey`)).body.state === 'done', 5000, 'survey done');
  const surveyAnswer = (p: P, hits: Record<string, number>) => (p.client.switchResults.set('switch.survey', (x) => ({ status: 'ok', result: { sn: null, results: x.cameras.map((c: { camera: string }) =>
    c.camera in hits ? { camera: c.camera, found: true, port: hits[c.camera], poe: true, watts: 4 } : { camera: c.camera, found: false, reason: 'no_traffic' }) } })));

  it("I1: a sysadmin's unforced cycle is audited against the camera: the start, the retry after a search, the final outcome", async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    const b = await sw(p, 'Bravo');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', (x) => (x.switch.id === b.id ? found(5, 4.1) : notFound()));
    p.client.switchResults.set('switch.cycle', (x) => (x.switch.id === b.id ? { status: 'ok', result: { verified: true, offAt: 1, onAt: 2, watts: 4.3 } } : { status: 'failed', code: 'not_verified' }));
    const r = await call('POST', `/cameras/${cam.id}/power/cycle`, {});
    expect(r.status).toBe(202);
    await cycleDone(cam.id);
    const cmds = sent(p, 'switch.cycle');
    expect(cmds).toHaveLength(2);
    const ids = (s.built.db.prepare(`SELECT id FROM commands WHERE command = 'switch.cycle' ORDER BY created_at, id`).all() as { id: string }[]).map((x) => x.id);
    expect(audits('camera-power-cycle')).toEqual([
      expect.objectContaining({ outcome: 'ok', targetId: cam.id, step: 'start', switchId: a.id, port: 3, cmdId: r.body.commandId, force: false }),
      expect.objectContaining({ outcome: 'ok', targetId: cam.id, step: 'retry', switchId: b.id, port: 5, cmdId: ids.find((x) => x !== r.body.commandId) }),
      expect.objectContaining({ outcome: 'ok', targetId: cam.id, step: 'final', code: null }),
    ]);
    // A failed one ends with outcome failed and its code; a forced one also gets its final record.
    p.client.switchResults.set('switch.cycle', { status: 'failed', code: 'switch_auth' });
    await call('POST', `/cameras/${cam.id}/power/cycle`, {});
    await cycleDone(cam.id);
    expect(audits('camera-power-cycle').at(-1)).toMatchObject({ outcome: 'failed', step: 'final', code: 'switch_auth', reason: 'the switch refused the password' });
    p.client.switchResults.set('switch.cycle', { status: 'ok', result: { verified: false, offAt: 1, onAt: 2 } });
    await call('POST', `/cameras/${cam.id}/power/cycle`, { force: true });
    await cycleDone(cam.id);
    expect(audits('camera-power-cycle-forced')).toHaveLength(1);
    expect(audits('camera-power-cycle').at(-1)).toMatchObject({ outcome: 'ok', step: 'final', force: true });
  });

  it('I1: verify and search are audited camera-power-verify (start and result); a survey switch-survey (start and summary)', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const other = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', found(3, 4.5));
    const r = await call('POST', `/cameras/${cam.id}/power/verify`);
    await checkDone(cam.id);
    expect(audits('camera-power-verify')).toEqual([
      expect.objectContaining({ outcome: 'ok', targetId: cam.id, step: 'start', op: 'verify', cmdId: r.body.commandId }),
      expect.objectContaining({ outcome: 'ok', targetId: cam.id, step: 'result', op: 'verify', switchId: a.id, port: 3, kind: 'poe' }),
    ]);
    p.client.switchResults.set('switch.locate', notFound());
    await call('PUT', `/cameras/${cam.id}/power`, { kind: 'auto' });
    await checkDone(cam.id);
    expect(audits('camera-power-verify').at(-1)).toMatchObject({ outcome: 'failed', step: 'result', op: 'search', code: 'not_found' });

    surveyAnswer(p, { [cam.id]: 3 });
    const sv = await call('POST', `/switches/${a.id}/survey`);
    expect(sv.status).toBe(202);
    await surveyDone(a.id, 1, p);
    expect(audits('switch-survey')).toEqual([
      expect.objectContaining({ outcome: 'ok', targetId: a.id, step: 'start', commandIds: sv.body.commandIds, cameras: 2 }),
      expect.objectContaining({ outcome: 'ok', targetId: a.id, step: 'done', found: 1, notFound: 1, trunks: [] }),
    ]);
    expect(other).toBeTruthy();
  });

  it('I2: a verify that confirms the same mapping sends camera.power.set again; a proxy without the entry is skipped silently', async () => {
    const p = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
    p.client.switchResults.set('switch.locate', found(3, 4));
    await call('POST', `/cameras/${cam.id}/power/verify`);
    await checkDone(cam.id);
    await until(() => sent(p, 'camera.power.set').length === 1, 5000, 'power set on the same mapping');
    expect(sent(p, 'camera.power.set')[0]).toEqual({ v: 1, camera: cam.proxyCameraId, power: { kind: 'poe', switchName: 'Alpha', port: 3, watts: 4, verifiedAt: clock.now() } });
    // A survey that confirms it too.
    surveyAnswer(p, { [cam.id]: 3 });
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 1, p);
    await until(() => sent(p, 'camera.power.set').length === 2, 5000, 'power set after the survey');

    const q = await proxy(SWITCH_COMMANDS.slice());
    const c2 = await camera(q);
    const b = await sw(q, 'Bravo');
    setPower(c2.id, { kind: 'poe', switchId: b.id, port: 2, watts: 4 });
    q.client.switchResults.set('switch.locate', found(2, 4));
    await call('POST', `/cameras/${c2.id}/power/verify`);
    await checkDone(c2.id);
    expect((await power(c2.id)).lastCheck).toMatchObject({ state: 'ok' });
    expect(sent(q, 'camera.power.set')).toEqual([]);
  });

  it("I2: a camera's new proxy (edit, move, adopt) gets camera.power.set", async () => {
    const p = await proxy();
    const q = await proxy();
    const cam = await camera(p);
    const a = await sw(p, 'Alpha');
    setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4, verifiedAt: 5 });
    const v = (await call('GET', `/accounts/${p.acc}/cameras/${cam.id}`)).body.version;
    const r = await call('PATCH', `/accounts/${p.acc}/cameras/${cam.id}`, { proxyId: q.prx, proxyCameraId: 'qcam', version: v });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await until(() => sent(q, 'camera.power.set').length === 1, 5000, 'power set to the new proxy');
    expect(sent(q, 'camera.power.set')[0]).toEqual({ v: 1, camera: 'qcam', power: { kind: 'poe', switchName: 'Alpha', port: 3, watts: 4, verifiedAt: 5 } });
    // The move's switch-over.
    s.built.registry.moveCamera('system', p.acc, cam.id, { proxyId: p.prx, proxyCameraId: 'back', tlsServername: null, moveId: 'mv_0123456789ABCDEFGHJK' });
    await until(() => sent(p, 'camera.power.set').some((x) => x.camera === 'back'), 5000, 'power set after the move');
    expect(sent(p, 'camera.power.set').find((x) => x.camera === 'back')).toMatchObject({ power: { kind: 'poe', switchName: 'Alpha', port: 3 } });
    // An adopted camera: its record (unknown) to its proxy.
    expect((await call('POST', `/accounts/${q.acc}/proxies/${q.prx}/adopt`, { proxyCameraId: 'cam2' })).status).toBe(201);
    await until(() => sent(q, 'camera.power.set').some((x) => x.camera === 'cam2'), 5000, 'power set after the adopt');
    expect(sent(q, 'camera.power.set').find((x) => x.camera === 'cam2')).toEqual({ v: 1, camera: 'cam2', power: { kind: 'unknown' } });
  });

  it('I3: two or more cameras on one port in a survey: a trunk port, none mapped from it, an older mapping onto it removed, the others kept (no notSeen), listed in the survey result', async () => {
    const p = await proxy();
    const cams: Awaited<ReturnType<typeof camera>>[] = [];
    for (let i = 0; i < 20; i++) cams.push(await camera(p, `10.0.1.${i + 1}`));
    const a = await sw(p, 'Alpha');
    const b = await sw(p, 'Bravo');
    // cams[0] was mapped to Alpha port 8 before; cams[1] and cams[17] (in the second chunk) are behind port 8 too.
    setPower(cams[0].id, { kind: 'poe', switchId: a.id, port: 8, watts: 4 });
    setPower(cams[1].id, { kind: 'poe', switchId: b.id, port: 2, watts: 4 });
    surveyAnswer(p, { [cams[0].id]: 8, [cams[1].id]: 8, [cams[17].id]: 8, [cams[2].id]: 4 });
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 2, p);
    // A mapping made before the port was known as a trunk is removed (a cycle there would cut the chained switch).
    expect((await power(cams[0].id)).power).toEqual({ kind: 'unknown' });
    expect((await power(cams[1].id)).power).toEqual({ kind: 'poe', switchId: b.id, port: 2, watts: 4 });
    expect((await power(cams[17].id)).power).toEqual({ kind: 'unknown' });
    expect((await power(cams[2].id)).power).toMatchObject({ kind: 'poe', switchId: a.id, port: 4 });
    const view = (await call('GET', `/switches/${a.id}/survey`)).body;
    expect(view.trunks).toEqual([{ port: 8, cameras: [cams[0], cams[1], cams[17]].map((c) => ({ cameraId: c.id, camsId: c.camsId })).sort((x, y) => x.camsId.localeCompare(y.camsId)) }]);
    expect(view.results.find((x: { cameraId: string }) => x.cameraId === cams[17].id)).toMatchObject({ found: true, port: 8, trunk: true });
    expect(view.results.find((x: { cameraId: string }) => x.cameraId === cams[17].id).kind).toBeUndefined();
    expect(audits('camera-power-set').filter((x) => [cams[0].id, cams[1].id, cams[17].id].includes(x.targetId) && x.why === 'survey')).toEqual([]);
    expect(audits('camera-power-set').filter((x) => x.targetId === cams[0].id).at(-1)).toMatchObject({ from: { kind: 'poe', port: 8 }, to: { kind: 'unknown' }, why: 'trunk port 8: another switch is chained on it' });
    await until(() => sent(p, 'camera.power.set').some((x) => x.camera === cams[0].proxyCameraId && x.power.kind === 'unknown'), 5000, 'unknown sent');
    expect(audits('switch-survey').at(-1)).toMatchObject({ step: 'done', trunks: [{ port: 8, cameras: 3 }] });
  });

  it('I3: a cascade: cameras behind a link port of Alpha map to Bravo, whichever survey runs first; a locate on a trunk port goes on searching', async () => {
    const p = await proxy();
    const c = await camera(p);
    const d = await camera(p);
    const a = await sw(p, 'Alpha');
    const b = await sw(p, 'Bravo');
    p.client.switchResults.set('switch.survey', (x) => ({ status: 'ok', result: { sn: null, results: x.cameras.map((k: { camera: string }) => ({ camera: k.camera, found: true, port: x.switch.id === a.id ? 8 : k.camera === c.id ? 2 : 3, poe: true, watts: x.switch.id === a.id ? 0 : 4 })) } }));
    await call('POST', `/switches/${b.id}/survey`);
    await surveyDone(b.id, 1, p);
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 2, p);
    expect((await power(c.id)).power).toMatchObject({ kind: 'poe', switchId: b.id, port: 2 });
    expect((await power(d.id)).power).toMatchObject({ kind: 'poe', switchId: b.id, port: 3 });
    await call('POST', `/switches/${b.id}/survey`);
    await surveyDone(b.id, 3, p);
    expect((await power(c.id)).power).toMatchObject({ kind: 'poe', switchId: b.id, port: 2 });

    // An old mapping on Alpha's trunk port: Alpha's locate finds the camera on port 8 → not found there, Bravo next.
    setPower(c.id, { kind: 'poe', switchId: a.id, port: 8, watts: 4 });
    p.client.switchResults.set('switch.locate', (x) => (x.switch.id === a.id ? found(8, 4) : found(2, 4)));
    await call('POST', `/cameras/${c.id}/power/verify`);
    await checkDone(c.id);
    expect(sent(p, 'switch.locate').map((x) => x.switch.id)).toEqual([a.id, b.id]);
    expect((await power(c.id)).power).toMatchObject({ kind: 'poe', switchId: b.id, port: 2 });
    // Only Alpha: not found, with the reason.
    p.client.switchResults.set('switch.locate', (x) => (x.switch.id === a.id ? found(8, 4) : notFound()));
    await call('POST', `/cameras/${d.id}/power/verify`);
    await checkDone(d.id);
    expect((await power(d.id)).lastCheck).toMatchObject({ state: 'failed', code: 'not_found' });
    expect((await power(d.id)).lastCheck.reason).toMatch(/Alpha: trunk port 8 \(2 cameras\)/);
  });
  it('I3 (Klaus): a chained switch is a configuration problem: on the survey, the switch (GET and list), the dashboard; audited once when it appears, cleared by a later survey', async () => {
    const p = await proxy();
    const c = await camera(p);
    const d = await camera(p);
    const a = await sw(p, 'Alpha');
    surveyAnswer(p, { [c.id]: 6, [d.id]: 6 });
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 1, p);
    const problem = { code: 'chained_switch', port: 6, cameras: 2 };
    expect((await call('GET', `/switches/${a.id}/survey`)).body.problems).toEqual([problem]);
    expect((await call('GET', `/switches/${a.id}`)).body.problems).toEqual([problem]);
    expect((await call('GET', `/accounts/${p.acc}/switches`)).body.items[0].problems).toEqual([problem]);
    const dash = (await call('GET', '/dashboard')).body.accounts.find((x: { id: string }) => x.id === p.acc);
    expect(dash.warnings).toContain('chained-switch');
    expect(dash.switchProblems).toEqual([{ switchId: a.id, switch: 'Alpha', ...problem }]);
    const flagged = () => audits('switch-survey').filter((x) => x.step === 'problem');
    expect(flagged()).toEqual([expect.objectContaining({ outcome: 'refused', targetId: a.id, code: 'chained_switch', port: 6, cameras: 2 })]);
    // Seen again: no second entry. Gone: cleared (audited ok), and off the dashboard.
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 2, p);
    expect(flagged()).toHaveLength(1);
    surveyAnswer(p, { [c.id]: 6, [d.id]: 7 });
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 3, p);
    expect((await call('GET', `/switches/${a.id}`)).body.problems).toEqual([]);
    expect(audits('switch-survey').filter((x) => x.step === 'problem-cleared')).toEqual([expect.objectContaining({ outcome: 'ok', code: 'chained_switch', port: 6 })]);
    const dash2 = (await call('GET', '/dashboard')).body.accounts.find((x: { id: string }) => x.id === p.acc);
    expect(dash2.warnings).not.toContain('chained-switch');
    expect(dash2.switchProblems).toEqual([]);
    expect((await power(c.id)).power).toMatchObject({ kind: 'poe', switchId: a.id, port: 6 });
  });
  it('trunk port (re-review): a cycle on a mapping that is a known trunk port is refused, forced or not, also for a proxy request', async () => {
    const p = await proxy();
    const c = await camera(p);
    const d = await camera(p);
    const a = await sw(p, 'Alpha');
    surveyAnswer(p, { [c.id]: 8, [d.id]: 8 });
    await call('POST', `/switches/${a.id}/survey`);
    await surveyDone(a.id, 1, p);
    // A mapping onto the trunk port (made by hand, as one older than the survey would be).
    setPower(c.id, { kind: 'poe', switchId: a.id, port: 8, watts: 4 });
    const reason = 'port 8 leads to another switch (configuration issue): not power-cycling';
    for (const body of [{}, { force: true }]) {
      const r = await call('POST', `/cameras/${c.id}/power/cycle`, body);
      expect([r.status, r.body], JSON.stringify(body)).toEqual([409, { error: 'trunk_port', message: reason }]);
    }
    expect(p.client.emitEvent({ kind: 'camera.power.cycle.request', camera: c.proxyCameraId, requestId: 'rq-trunk' })).toBe(true);
    await until(() => sent(p, 'camera.power.cycle.result').length > 0, 5000, 'result');
    expect(sent(p, 'camera.power.cycle.result')).toEqual([{ v: 1, camera: c.proxyCameraId, requestId: 'rq-trunk', ok: false, reason }]);
    expect(sent(p, 'switch.cycle')).toEqual([]);
  });
});
