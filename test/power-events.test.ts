// PoE switches: a power-cycle asked for by a camera's own proxy (design 2026-11-07-poe-switches-design.md, "Asking
// from a proxy"): the event camera.power.cycle.request {camera, requestId}, answered with the command
// camera.power.cycle.result {camera, requestId, ok, reason?} once the cycle is final (also across a restart).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { POWER_COMMANDS, SWITCH_COMMANDS } from '../contract/build';
import type { CameraPower } from '../server/switches/store';

const ACTOR = 'admin@example.com';
const ALL = [...SWITCH_COMMANDS, ...POWER_COMMANDS];
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000', LIMIT_COMMANDS_PER_MIN: '1000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow: string[] = ALL) {
  const p = await enrolled(s, `pe${n++}`);
  const client = makeClient(p.key, { commands: { allow } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands && client.state === 'connected', 5000, 'commands report');
  return { client, acc: p.accountId, prx: p.proxyId };
}
type P = Awaited<ReturnType<typeof proxy>>;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
async function camera(p: P) {
  const tag = `c${n++}`;
  const r = await call('POST', `/accounts/${p.acc}/cameras`, { camsId: tag, name: tag, kind: 'camera', proxyId: p.prx, proxyCameraId: tag, host: `192.168.60.${20 + n}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; camsId: string; proxyCameraId: string; host: string };
}
async function sw(p: P, name: string) {
  const r = await call('POST', `/accounts/${p.acc}/switches`, { name, host: '192.168.1.217', proxyId: p.prx });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return s.built.switches.store.updateSwitch(ACTOR, p.acc, r.body.id, { state: 'active', sn: `SN${n++}` });
}
const setPower = (camId: string, power: CameraPower) => s.built.switches.store.setPower(camId, power, ACTOR, 'sysadmin', 'test');
const power = async (camId: string) => (await call('GET', `/cameras/${camId}/power`)).body;
const sent = (p: P, command: string) => p.client.receivedCommands.filter((m) => m.body.command === command).map((m) => m.body.args);
const results = (p: P) => sent(p, 'camera.power.cycle.result');
const audits = (action: string) => (s.built.db.prepare('SELECT actor_type, actor, outcome, target_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_type: string; actor: string; outcome: string; target_id: string | null; detail: string }[])
  .map((x) => ({ actorType: x.actor_type, actor: x.actor, outcome: x.outcome, targetId: x.target_id, ...JSON.parse(x.detail ?? '{}') }));
const ask = (p: P, camera: string, requestId: string, o: { forge?: boolean } = {}) => expect(p.client.emitEvent({ kind: 'camera.power.cycle.request', camera, requestId }, o)).toBe(true);
const settle = () => new Promise((r) => setTimeout(r, 250));

// A camera with a poe mapping on an active switch run by `op` (the camera's own proxy by default).
async function poeCamera(p: P, op: P = p) {
  const cam = await camera(p);
  const a = await sw(op, `Sw${n++}`);
  setPower(cam.id, { kind: 'poe', switchId: a.id, port: 3, watts: 4 });
  return { cam, a };
}

describe('power-cycle requests from proxies', () => {
  it('a signed request → switch.cycle to the operator → camera.power.cycle.result ok to the camera\'s proxy; audited as the proxy', async () => {
    const p = await proxy();
    const { cam, a } = await poeCamera(p);
    ask(p, cam.proxyCameraId, 'rq-1');
    await until(() => results(p).length > 0, 5000, 'result');
    expect(sent(p, 'switch.cycle')).toEqual([{ v: 1, switch: expect.objectContaining({ id: a.id }), port: 3, host: cam.host, force: false, camera: cam.id }]);
    expect(results(p)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-1', ok: true }]);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'ok', force: false });
    // The request (as the proxy), then the final outcome against the camera (step final, with the request id).
    await until(() => audits('camera-power-cycle').length === 2, 5000, 'final audit');
    expect(audits('camera-power-cycle')).toEqual([
      expect.objectContaining({ actorType: 'proxy', actor: p.prx, outcome: 'ok', targetId: cam.id, requestId: 'rq-1', cmdId: expect.stringMatching(/^cmd_/) }),
      expect.objectContaining({ actorType: 'proxy', actor: p.prx, outcome: 'ok', targetId: cam.id, step: 'final', requestId: 'rq-1', code: null }),
    ]);
    const cc = s.built.db.prepare(`SELECT actor_type FROM audit_log WHERE action = 'command-create' AND detail LIKE '%switch.cycle%'`).all() as { actor_type: string }[];
    expect(cc).toEqual([{ actor_type: 'proxy' }]);
    await settle();
    expect(results(p)).toHaveLength(1);
  });

  it('a camera unknown to cams-admin (or another proxy\'s) → ok:false "camera not in cams-admin", no cycle', async () => {
    const p = await proxy();
    const q = await proxy();
    const { cam } = await poeCamera(q);
    ask(p, 'nosuchcam', 'rq-a');
    ask(p, cam.proxyCameraId, 'rq-b');
    await until(() => results(p).length === 2, 5000, 'results');
    expect(results(p)).toEqual([
      { v: 1, camera: 'nosuchcam', requestId: 'rq-a', ok: false, reason: 'camera not in cams-admin' },
      { v: 1, camera: cam.proxyCameraId, requestId: 'rq-b', ok: false, reason: 'camera not in cams-admin' },
    ]);
    expect([...sent(p, 'switch.cycle'), ...sent(q, 'switch.cycle')]).toEqual([]);
    expect(audits('camera-power-cycle')).toEqual([
      expect.objectContaining({ actorType: 'proxy', actor: p.prx, outcome: 'refused', targetId: null, requestId: 'rq-a' }),
      expect.objectContaining({ actorType: 'proxy', actor: p.prx, outcome: 'refused', targetId: null, requestId: 'rq-b' }),
    ]);
  });

  it('a failed cycle → ok:false with the reason; a refusal up front (power unknown) → ok:false with its reason', async () => {
    const p = await proxy();
    const { cam } = await poeCamera(p);
    p.client.switchResults.set('switch.cycle', { status: 'failed', code: 'switch_auth' });
    ask(p, cam.proxyCameraId, 'rq-f');
    await until(() => results(p).length > 0, 5000, 'result');
    expect(results(p)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-f', ok: false, reason: 'the switch refused the password' }]);
    const other = await camera(p);
    ask(p, other.proxyCameraId, 'rq-u');
    await until(() => results(p).length === 2, 5000, 'result 2');
    expect(results(p)[1]).toEqual({ v: 1, camera: other.proxyCameraId, requestId: 'rq-u', ok: false, reason: 'what powers the camera is unknown: verify or search first' });
  });

  it('a second request while a cycle is open (from any caller) → "a power-cycle is already running"; within 60 s → "too soon"', async () => {
    const p = await proxy();
    const op = await proxy();
    const { cam } = await poeCamera(p, op);
    // A sysadmin's cycle is open (the operator drops the switch.cycle: it stays sent).
    op.client.dropCommands = 1;
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).status).toBe(202);
    ask(p, cam.proxyCameraId, 'rq-busy');
    await until(() => results(p).length > 0, 5000, 'busy result');
    expect(results(p)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-busy', ok: false, reason: 'a power-cycle is already running' }]);
    // The open cycle ends (re-sent after 10 s, answered).
    clock.advance(10_000);
    s.built.commands.tick();
    await until(async () => (await power(cam.id)).lastCycle?.state === 'ok', 5000, 'cycle done');
    ask(p, cam.proxyCameraId, 'rq-1');
    await until(() => results(p).length === 2, 5000, 'result 1');
    expect(results(p)[1]).toMatchObject({ requestId: 'rq-1', ok: true });
    clock.advance(59_000);
    ask(p, cam.proxyCameraId, 'rq-2');
    await until(() => results(p).length === 3, 5000, 'result 2');
    expect(results(p)[2]).toEqual({ v: 1, camera: cam.proxyCameraId, requestId: 'rq-2', ok: false, reason: 'too soon' });
    clock.advance(1_000);
    ask(p, cam.proxyCameraId, 'rq-3');
    await until(() => results(p).length === 4, 5000, 'result 3');
    expect(results(p)[3]).toMatchObject({ requestId: 'rq-3', ok: true });
    expect(audits('camera-power-cycle').filter((a) => a.actorType === 'proxy' && a.step !== 'final').map((a) => [a.requestId, a.outcome])).toEqual([['rq-busy', 'refused'], ['rq-1', 'ok'], ['rq-2', 'refused'], ['rq-3', 'ok']]);
  });

  it('a proxy without camera.power.cycle.result allowed: the cycle runs, no result is sent', async () => {
    const p = await proxy(ALL.filter((x) => x !== 'camera.power.cycle.result'));
    const { cam } = await poeCamera(p);
    ask(p, cam.proxyCameraId, 'rq-n');
    await until(async () => (await power(cam.id)).lastCycle?.state === 'ok', 5000, 'cycle done');
    await settle();
    expect(sent(p, 'switch.cycle')).toHaveLength(1);
    expect(results(p)).toEqual([]);
  });

  it('a forged or malformed request is refused at the channel (no cycle, nothing to the move job)', async () => {
    // Two proxies: the refusal audit is throttled per proxy.
    const p = await proxy();
    const q = await proxy();
    const { cam } = await poeCamera(p);
    ask(p, cam.proxyCameraId, 'rq-x', { forge: true });
    expect(q.client.emitEvent({ kind: 'camera.power.cycle.request', camera: cam.proxyCameraId, requestId: '' })).toBe(true);
    await until(() => audits('move-event-refused').length === 2, 5000, 'refused');
    expect(audits('move-event-refused').map((a) => [a.actor, a.reason, a.kind])).toEqual([[p.prx, 'bad_signature', 'camera.power.cycle.request'], [q.prx, 'invalid_event', 'camera.power.cycle.request']]);
    await settle();
    expect([...sent(p, 'switch.cycle'), ...sent(q, 'switch.cycle')]).toEqual([]);
    expect([...results(p), ...results(q)]).toEqual([]);
  });

  it('a restart between the switch.cycle and its answer: the cycle is still running after the start, the result is sent once', async () => {
    const own = await proxy();
    const op = await proxy();
    const { cam, a } = await poeCamera(own, op);
    op.client.dropAfterReceived = 1;
    op.client.debugHoldEvents = true;
    op.client.holdReconnect = true;
    ask(own, cam.proxyCameraId, 'rq-r');
    await until(() => sent(op, 'switch.cycle').length === 1 && op.client.state !== 'connected', 5000, 'cycle received, operator away');
    const cmdId = op.client.receivedCommands.find((m) => m.body.command === 'switch.cycle')!.body.cmdId as string;
    expect(s.built.commands.get(op.acc, op.prx, cmdId).state).toBe('received');
    s = await s.restart();
    // The open cycle survives: the camera stays busy and its lastCycle is running.
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'running', force: false, commandIds: expect.arrayContaining([cmdId]) });
    expect((await call('POST', `/cameras/${cam.id}/power/cycle`, {})).body).toMatchObject({ error: 'busy' });
    await until(() => own.client.state === 'connected', 8000, 'own reconnected');
    op.client.release();
    await until(() => results(own).length > 0, 8000, 'result after restart');
    expect(results(own)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-r', ok: true }]);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'ok' });
    await until(() => sent(own, 'camera.power.cycled').length > 0, 5000, 'cycled');
    expect(sent(own, 'camera.power.cycled').at(-1)).toMatchObject({ camera: cam.proxyCameraId, ok: true });
    expect(sent(op, 'switch.cycle').map((x) => x.switch.id)).toEqual([a.id, a.id]); // re-sent once on the new connection
    // Once: another restart sends nothing more, and the finished cycle is still shown.
    s = await s.restart();
    await until(() => own.client.state === 'connected', 8000, 'own reconnected 2');
    await settle();
    expect(results(own)).toHaveLength(1);
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'ok', force: false });
  });
  // Review triage (Task 9 #7): the restore branches that run inside the constructor.
  async function openCycle() {
    const own = await proxy();
    const op = await proxy();
    const { cam, a } = await poeCamera(own, op);
    op.client.dropCommands = 1; // the switch.cycle stays sent
    ask(own, cam.proxyCameraId, 'rq-s');
    await until(() => s.built.db.prepare(`SELECT 1 FROM commands WHERE command = 'switch.cycle' AND state = 'sent'`).get() !== undefined, 5000, 'cycle sent');
    // The own proxy's camera.power.cycling answered before the restart: one still `sent` would hold that proxy's queue
    // (commands go one at a time) until its re-send, which waits on the fake clock, so the result never went out.
    await until(() => s.built.db.prepare(`SELECT 1 FROM commands WHERE command = 'camera.power.cycling' AND state = 'done'`).get() !== undefined, 5000, 'cycling answered');
    const cmdId = (s.built.db.prepare(`SELECT id FROM commands WHERE command = 'switch.cycle'`).get() as { id: string }).id;
    return { own, op, cam, a, cmdId };
  }
  const cycleRow = (camId: string) => s.built.db.prepare('SELECT command_id, request, flow FROM camera_power_cycles WHERE camera_id = ?').get(camId) as { command_id: string | null; request: string | null; flow: string };

  it('restore: the switch.cycle row is already final at the start → the cycle ends at once, the result is sent once, the row is cleaned', async () => {
    const { own, cam, cmdId } = await openCycle();
    // The answer landed in the database, but this run never saw it (as if it crashed right after).
    s.built.db.prepare(`UPDATE commands SET state = 'done', finished_at = ?, result = ? WHERE id = ?`).run(clock.now(), JSON.stringify({ body: { phase: 'done', status: 'ok', result: { verified: true, offAt: 1, onAt: 2 } } }), cmdId);
    s = await s.restart();
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'ok' });
    expect(cycleRow(cam.id)).toMatchObject({ command_id: null, request: null });
    await until(() => own.client.state === 'connected' && results(own).length > 0, 8000, 'result after restart');
    expect(results(own)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-s', ok: true }]);
    s = await s.restart();
    await until(() => own.client.state === 'connected', 8000, 'own reconnected');
    await settle();
    expect(results(own)).toHaveLength(1);
    expect(audits('camera-power-cycle').at(-1)).toMatchObject({ actorType: 'system', outcome: 'ok', step: 'final' });
  });

  it('restore: the switch.cycle row is gone at the start → the cycle fails "cams-admin restarted", the result is sent once, the row is cleaned', async () => {
    const { own, cam, cmdId } = await openCycle();
    s.built.db.prepare('DELETE FROM commands WHERE id = ?').run(cmdId);
    s = await s.restart();
    expect((await power(cam.id)).lastCycle).toMatchObject({ state: 'failed', code: 'restart', reason: 'cams-admin restarted during the power-cycle' });
    expect(cycleRow(cam.id)).toMatchObject({ command_id: null, request: null });
    await until(() => own.client.state === 'connected' && results(own).length > 0, 8000, 'result after restart');
    expect(results(own)).toEqual([{ v: 1, camera: cam.proxyCameraId, requestId: 'rq-s', ok: false, reason: 'cams-admin restarted during the power-cycle' }]);
    s = await s.restart();
    await until(() => own.client.state === 'connected', 8000, 'own reconnected');
    await settle();
    expect(results(own)).toHaveLength(1);
  });
});
