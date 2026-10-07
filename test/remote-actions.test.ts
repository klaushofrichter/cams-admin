// RemoteActions (migration spec §8.6, P3 plan Task 5, R3-18): camera
// actions, camera renames and proxy restarts as signed commands; the
// disruptive ones need a typed confirmation. A real server on a fake clock
// and the test client with the reference proxy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { RefProxyConfig } from '../test-client/config';
import type { ProxyClient } from '../test-client/client';
import { DISRUPTIVE_ACTIONS, REMOTE_ACTIONS } from '../contract/build';

const ACTOR = 'admin@example.com';
const ACTOR2 = 'other@example.com';
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow: string[], account?: string) {
  const p = await enrolled(s, `act${n++}`, account);
  const ref = new RefProxyConfig({ cameras: ['cam1', 'cam2'] });
  const client = makeClient(p.key, { commands: { allow, config: ref } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands && !!s.built.status.row(p.proxyId)?.reported?.cameras.length, 5000, 'commands report');
  return { ...p, client, ref, acc: p.accountId, prx: p.proxyId };
}
const A = () => s.built.actions;
const cmds = () => s.built.commands;
const final = async (acc: string, prx: string, id: string) => {
  await until(() => !['queued', 'sent', 'received'].includes(cmds().get(acc, prx, id).state), 5000, `final ${id}`);
  return cmds().get(acc, prx, id);
};
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return [(e as { status: number }).status, (e as { code: string }).code, (e as { field?: string }).field]; }
  return 'no error';
};
const countCommands = () => (s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n;

describe('RemoteActions', () => {
  it('camera-test with the entry → done, the result shown', async () => {
    const p = await proxy(['camera.action:camera-test']);
    const r = A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-test' });
    expect(await final(p.acc, p.prx, r.commandId)).toMatchObject({ state: 'done', command: 'camera.action', args: { camera: 'cam1', action: 'camera-test' }, result: { action: 'camera-test', httpStatus: 200 } });
    expect(p.ref.actions.calls).toEqual([{ action: 'camera-test', camera: 'cam1' }]);
  });

  it('camera-reboot: without confirm → 400 confirm_required; with it and the entry → done; without the entry → 409 not_allowed_on_proxy', async () => {
    const p = await proxy(['camera.action:camera-reboot']);
    expect(code(() => A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot' }))).toEqual([400, 'confirm_required', 'confirm']);
    expect(code(() => A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'yes' }))).toEqual([400, 'confirm_required', 'confirm']);
    const r = A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' });
    expect((await final(p.acc, p.prx, r.commandId)).state).toBe('done');
    const q = await proxy(['camera.action:camera-test']);
    expect(code(() => A().cameraAction(ACTOR, q.acc, q.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' }))).toEqual([409, 'not_allowed_on_proxy', undefined]);
  });

  it('body rules: a never-remote or unknown action, a missing or null camera, input outside inventory, unknown fields → 400, no command', async () => {
    const p = await proxy(REMOTE_ACTIONS.map((a) => `camera.action:${a}`));
    const before = countCommands();
    for (const [body, field] of [
      [{ camera: 'cam1', action: 'find-camera' }, 'action'],
      [{ camera: 'cam1', action: 'camera-ftp-off', confirm: 'camera-ftp-off' }, 'action'], // never remote (cam-proxy #196)
      [{ camera: 'cam1', action: 'frobnicate' }, 'action'],
      [{ camera: null, action: 'restart', confirm: 'restart' }, 'camera'],
      [{ action: 'camera-test' }, 'camera'],
      [{ camera: 'Cam 1', action: 'camera-test' }, 'camera'],
      [{ camera: 'cam1', action: 'retention-run' }, 'camera'],
      [{ camera: 'cam1', action: 'camera-test', input: { kind: 'clips' } }, 'input'],
      [{ camera: 'cam1', action: 'inventory', input: { kind: '' } }, 'input'],
      [{ camera: 'cam1', action: 'camera-test', extra: 1 }, 'body'],
      [null, 'body'],
    ] as [unknown, string][]) expect(code(() => A().cameraAction(ACTOR, p.acc, p.prx, body)), JSON.stringify(body)).toEqual([400, 'invalid', field]);
    expect(countCommands()).toBe(before);
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: null, action: 'retention-run' }).commandId).toMatch(/^cmd_/);
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'inventory', input: { kind: 'clips', camera: true } }).commandId).toMatch(/^cmd_/);
  });

  it('Review Focus 4: a disruptive action clicked twice → one command, the second 409 busy while it is open; the proxy\'s rate_limited shows retryAfterS', async () => {
    const p = await proxy(['camera.action:camera-reboot', 'camera.action:camera-powercycle']);
    p.client.dropCommands = 1; // the first stays open
    const r1 = A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' });
    expect(code(() => A().cameraAction(ACTOR2, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' }))).toEqual([409, 'busy', undefined]);
    // another camera or action is not the same click
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam2', action: 'camera-reboot', confirm: 'camera-reboot' }).commandId).not.toBe(r1.commandId);
    expect(countCommands()).toBe(2);
    // after 10 s the click is a new request again (the proxy's budgets bound it)
    clock.advance(10_001);
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' }).commandId).toMatch(/^cmd_/);
  });

  it('Review Focus 4: the proxy\'s journal budget (rate_limited, retryAfterS) is stored on the row, not a cams-admin failure', async () => {
    const p = await proxy(['camera.action:camera-reboot']);
    p.client.refuseNext = { code: 'rate_limited', retryAfterS: 3000 };
    const r = A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' });
    expect(await final(p.acc, p.prx, r.commandId)).toMatchObject({ state: 'refused', outcomeCode: 'rate_limited', retryAfterS: 3000 });
  });

  it('rename → done with verified; a bad name → 400; restart needs confirm proxy.restart → done', async () => {
    const p = await proxy(['camera.name.set', 'proxy.restart']);
    const r = A().rename(ACTOR, p.acc, p.prx, 'cam2', { name: 'Back yard' });
    expect(await final(p.acc, p.prx, r.commandId)).toMatchObject({ state: 'done', result: { camera: 'cam2', name: 'Back yard', verified: true } });
    for (const body of [{ name: '' }, { name: 'a\nb' }, { name: 'x'.repeat(65) }, {}, { name: 'ok', extra: 1 }]) expect(code(() => A().rename(ACTOR, p.acc, p.prx, 'cam2', body))[1], JSON.stringify(body)).toBe('invalid');
    expect(code(() => A().rename(ACTOR, p.acc, p.prx, 'Bad Cam', { name: 'x' }))).toEqual([400, 'invalid', 'camera']);
    expect(code(() => A().restart(ACTOR, p.acc, p.prx, {}))).toEqual([400, 'confirm_required', 'confirm']);
    expect(code(() => A().restart(ACTOR, p.acc, p.prx, { confirm: 'restart' }))).toEqual([400, 'confirm_required', 'confirm']);
    const rs = A().restart(ACTOR, p.acc, p.prx, { confirm: 'proxy.restart' });
    expect(await final(p.acc, p.prx, rs.commandId)).toMatchObject({ state: 'done', command: 'proxy.restart', result: { restartAt: expect.any(Number) } });
  });

  it('I3: the fleet budget: one proxy at a time, at most 3 disruptive actions per 10 min across the fleet, persisted', async () => {
    const p = await proxy(['camera.action:camera-reboot', 'proxy.restart', 'camera.action:camera-test']);
    const q = await proxy(['camera.action:camera-reboot', 'proxy.restart'], 'other');
    p.client.dropCommands = 1; // p's first disruptive action stays open
    A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' });
    expect(code(() => A().cameraAction(ACTOR, q.acc, q.prx, { camera: 'cam1', action: 'camera-reboot', confirm: 'camera-reboot' }))).toEqual([409, 'fleet_busy', undefined]);
    expect(code(() => A().restart(ACTOR, q.acc, q.prx, { confirm: 'proxy.restart' }))).toEqual([409, 'fleet_busy', undefined]);
    // non-disruptive actions are not held
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam1', action: 'camera-test' }).commandId).toMatch(/^cmd_/);
    // the same proxy may go on (its own budget applies on the proxy)
    clock.advance(10_001);
    expect(A().cameraAction(ACTOR, p.acc, p.prx, { camera: 'cam2', action: 'camera-reboot', confirm: 'camera-reboot' }).commandId).toMatch(/^cmd_/);
    expect(A().restart(ACTOR, p.acc, p.prx, { confirm: 'proxy.restart' }).commandId).toMatch(/^cmd_/);
    // a fourth within 10 minutes: refused fleet-wide, with when to retry, and audited
    let err: any;
    try { A().restart(ACTOR, p.acc, p.prx, { confirm: 'proxy.restart' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 429, code: 'fleet_limit' });
    const refusals = (s.built.db.prepare(`SELECT detail, outcome FROM audit_log WHERE action = 'command-create' AND outcome = 'refused'`).all() as { detail: string }[]).map((x) => JSON.parse(x.detail).reason);
    expect(refusals).toEqual(['fleet_busy', 'fleet_busy', 'fleet_limit']);
    // persisted: a restart of cams-admin keeps the count (it comes from the commands table)
    s = await s.restart();
    expect(code(() => s.built.actions.restart(ACTOR, p.acc, p.prx, { confirm: 'proxy.restart' }))[1]).toMatch(/fleet_limit|fleet_busy/);
    clock.advance(10 * 60_000 + 1);
    // after 10 minutes the oldest leave the window (the open one gives up after 15 min)
    clock.advance(5 * 60_000);
    s.built.commands.tick();
    expect(code(() => s.built.actions.restart(ACTOR, q.acc, q.prx, { confirm: 'proxy.restart' }))).not.toEqual([429, 'fleet_limit', undefined]);
  });

  it('M3: a rename with a bidi override or zero-width character is 400', async () => {
    const p = await proxy(['camera.name.set']);
    for (const name of ['evil\u202Egnp', 'a\u200Bb', 'a\u2028b', 'evil\u061Cname', 'tag\u{E0041}x', 'lone\uD800x']) expect(code(() => A().rename(ACTOR, p.acc, p.prx, 'cam1', { name }))).toEqual([400, 'invalid', 'name']);
  });

  it('available(): every remote action with its disruptive mark and the reported allow-list; the cameras', async () => {
    const p = await proxy(['camera.action:camera-test', 'camera.action:camera-reboot', 'camera.name.set']);
    const av = A().available(p.acc, p.prx);
    expect(av.actions.map((a) => a.action)).toEqual([...REMOTE_ACTIONS]);
    expect(av.actions.map((a) => a.action)).not.toContain('camera-ftp-off');
    for (const a of av.actions) expect(a.disruptive, a.action).toBe((DISRUPTIVE_ACTIONS as readonly string[]).includes(a.action));
    expect(av.actions.filter((a) => a.allowed).map((a) => a.action)).toEqual(['camera-test', 'camera-reboot']);
    expect(av).toMatchObject({ rename: true, restart: false, cameras: ['cam1', 'cam2'] });
  });

  it('another account\'s proxy → 404 on every call', async () => {
    const p = await proxy(['camera.action:camera-test', 'camera.name.set', 'proxy.restart']);
    const q = await proxy(['camera.action:camera-test'], 'other');
    for (const fn of [
      () => A().cameraAction(ACTOR, q.acc, p.prx, { camera: 'cam1', action: 'camera-test' }),
      () => A().rename(ACTOR, q.acc, p.prx, 'cam1', { name: 'x' }),
      () => A().restart(ACTOR, q.acc, p.prx, { confirm: 'proxy.restart' }),
      () => A().available(q.acc, p.prx),
    ]) expect(code(fn)).toEqual([404, 'not_found', undefined]);
  });
});
