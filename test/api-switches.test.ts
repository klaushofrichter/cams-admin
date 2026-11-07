// PoE switches: the lifecycle API (design 2026-11-07-poe-switches-design.md, "Switch lifecycle"). A real
// server on a fake clock and the test client with the reference proxy answering the switch commands.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { SWITCH_COMMANDS } from '../contract/build';
import type { CameraPower } from '../server/switches/store';
import { OPS_SCOPES } from '../server/ops/tokens';

const ACTOR = 'admin@example.com';
const ALL = [...SWITCH_COMMANDS];
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000', SWITCH_READ_WAIT_MS: '3000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow: string[] = ALL, account?: string) {
  const p = await enrolled(s, `sw${n++}`, account);
  const client = makeClient(p.key, { commands: { allow } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { client, acc: p.accountId, prx: p.proxyId };
}
type P = Awaited<ReturnType<typeof proxy>>;

// The API's answer: status and body, never a throw.
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
const add = async (p: P, extra: Record<string, unknown> = {}) => {
  const r = await call('POST', `/accounts/${p.acc}/switches`, { name: `GPS-208 ${n++}`, host: '192.168.1.217', proxyId: p.prx, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const get = async (id: string) => (await call('GET', `/switches/${id}`)).body;
const sent = (p: P, command: string) => p.client.receivedCommands.filter((m) => m.body.command === command).map((m) => m.body.args);
const audits = (action: string) => (s.built.db.prepare('SELECT outcome, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string }[])
  .map((x) => ({ outcome: x.outcome, ...JSON.parse(x.detail ?? '{}') }));
const idle = (id: string) => until(async () => (await get(id)).pending.length === 0, 5000, `idle ${id}`);
const readAs = (p: P, sn: string | null) => (p.client.switchResults['switch.read'] = { status: 'ok', result: { sn, firmware: 'V2.1', ports: [] } });
async function activate(p: P, sn = 'GPS208X') {
  const sw = await add(p);
  readAs(p, sn);
  expect((await call('POST', `/switches/${sw.id}/test`)).status).toBe(202);
  await until(async () => (await get(sw.id)).state === 'active', 5000, 'active');
  return get(sw.id);
}

describe('switch lifecycle API', () => {
  it('add → pending with the defaults; the input rules', async () => {
    const p = await proxy();
    const sw = await add(p);
    expect(sw).toMatchObject({ state: 'pending', model: 'sscpoe-web', ports: 8, offSeconds: 10, proxyId: p.prx, sn: null });
    expect(sw.id).toMatch(/^sw_[A-Za-z0-9]{20}$/);
    expect((await call('GET', `/accounts/${p.acc}/switches`)).body.items.map((x: { id: string }) => x.id)).toEqual([sw.id]);
    const other = await proxy(ALL, 'other');
    for (const [body, field] of [
      [{ name: 'x'.repeat(61) }, 'name'],
      [{ name: '' }, 'name'],
      [{ host: 'not a host' }, 'host'],
      [{ host: 'http://192.168.1.2' }, 'host'],
      [{ ports: 0 }, 'ports'],
      [{ ports: 65 }, 'ports'],
      [{ ports: 8.5 }, 'ports'],
      [{ offSeconds: 0 }, 'offSeconds'],
      [{ offSeconds: 121 }, 'offSeconds'],
      [{ model: 'other' }, 'model'],
      [{ proxyId: other.prx }, 'proxyId'],
      [{ extra: 1 }, 'extra'],
    ] as [Record<string, unknown>, string][]) {
      const r = await call('POST', `/accounts/${p.acc}/switches`, { name: 'ok', host: '192.168.1.217', proxyId: p.prx, ...body });
      expect([r.status, r.body.error, r.body.field], JSON.stringify(body)).toEqual([400, 'invalid', field]);
    }
    expect((await call('POST', `/accounts/${p.acc}/switches`, { name: sw.name, host: '192.168.1.3', proxyId: p.prx })).body.error).toBe('duplicate_name');
    expect((await add(p, { ports: 64, offSeconds: 120, host: 'switch.lan:8080' }))).toMatchObject({ ports: 64, offSeconds: 120 });
  });

  it('test: switch.read through the operator → active with sn, firmware and read time; the onActive hook runs', async () => {
    const p = await proxy();
    const active: string[] = [];
    s.built.switches.onActive = (id) => active.push(id);
    const sw = await add(p, { ports: 5 });
    readAs(p, 'GPS208X');
    const r = await call('POST', `/switches/${sw.id}/test`);
    expect(r.status).toBe(202);
    expect(r.body.commandId).toMatch(/^cmd_/);
    await until(async () => (await get(sw.id)).state === 'active', 5000, 'active');
    expect(await get(sw.id)).toMatchObject({ state: 'active', sn: 'GPS208X', firmware: 'V2.1', readAt: expect.any(Number), pending: [], last: { op: 'test', outcome: 'ok' } });
    expect(sent(p, 'switch.read')).toEqual([{ v: 1, switch: { id: sw.id, model: 'sscpoe-web', host: '192.168.1.217', ports: 5, offSeconds: 10 } }]);
    expect(active).toEqual([sw.id]);
    expect(audits('switch-test').at(-1)).toMatchObject({ outcome: 'ok', op: 'test', sn: 'GPS208X' });
  });

  it('test: a failed read changes nothing and is audited', async () => {
    const p = await proxy();
    const sw = await add(p);
    p.client.switchResults['switch.read'] = { status: 'failed', code: 'password_unset' };
    await call('POST', `/switches/${sw.id}/test`);
    await idle(sw.id);
    expect(await get(sw.id)).toMatchObject({ state: 'pending', sn: null, last: { op: 'test', outcome: 'failed', code: 'password_unset' } });
  });

  it('a second switch (any account) answering a known sn → switch_taken, nothing changes', async () => {
    const p = await proxy();
    await activate(p, 'GPS208X');
    const q = await proxy(ALL, 'other');
    const sw2 = await add(q);
    readAs(q, 'GPS208X');
    await call('POST', `/switches/${sw2.id}/test`);
    await idle(sw2.id);
    expect(await get(sw2.id)).toMatchObject({ state: 'pending', sn: null, last: { op: 'test', outcome: 'refused', code: 'switch_taken' } });
    expect(audits('switch-test').at(-1)).toMatchObject({ outcome: 'refused', code: 'switch_taken' });
  });

  it('a proxy without switch.read in its allow list → 409 not_allowed_on_proxy', async () => {
    const p = await proxy(['switch.forget']);
    const sw = await add(p);
    expect((await call('POST', `/switches/${sw.id}/test`)).body).toEqual({ error: 'not_allowed_on_proxy' });
    expect(await get(sw.id)).toMatchObject({ state: 'pending', pending: [] });
  });

  it('update: plain fields at once; an address change is tested first: another sn → switch_mismatch and nothing changes, the same sn → saved', async () => {
    const p = await proxy();
    const sw = await activate(p, 'GPS208X');
    const plain = await call('PATCH', `/switches/${sw.id}`, { name: 'Garage', offSeconds: 20 });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ name: 'Garage', offSeconds: 20, host: '192.168.1.217' });
    expect((await call('PATCH', `/switches/${sw.id}`, { proxyId: p.prx })).body).toMatchObject({ error: 'invalid', field: 'proxyId' });

    readAs(p, 'OTHER-SN');
    const r = await call('PATCH', `/switches/${sw.id}`, { host: '192.168.1.99', offSeconds: 30 });
    expect(r.status).toBe(202);
    await idle(sw.id);
    expect(sent(p, 'switch.read').at(-1)).toMatchObject({ switch: { host: '192.168.1.99', offSeconds: 30 } });
    expect(await get(sw.id)).toMatchObject({ host: '192.168.1.217', offSeconds: 20, sn: 'GPS208X', last: { op: 'update', outcome: 'refused', code: 'switch_mismatch' } });

    readAs(p, 'GPS208X');
    await call('PATCH', `/switches/${sw.id}`, { host: '192.168.1.99', offSeconds: 30 });
    await idle(sw.id);
    expect(await get(sw.id)).toMatchObject({ host: '192.168.1.99', offSeconds: 30, sn: 'GPS208X', last: { op: 'update', outcome: 'ok' } });
  });

  it('update: a name taken now → 409 duplicate_name before any command; taken while the test runs → save_failed, nothing changes', async () => {
    const p = await proxy();
    const sw = await activate(p, 'GPS208X');
    const other = await add(p);
    const reads = sent(p, 'switch.read').length;
    expect((await call('PATCH', `/switches/${sw.id}`, { host: '192.168.1.99', name: other.name })).body).toEqual({ error: 'duplicate_name', field: 'name' });
    expect(sent(p, 'switch.read')).toHaveLength(reads);
    // The proxy answers after another switch took the name.
    p.client.switchResults['switch.read'] = () => {
      s.built.switches.store.updateSwitch(ACTOR, p.acc, other.id, { name: 'Garage' });
      return { status: 'ok', result: { sn: 'GPS208X', firmware: 'V2.1', ports: [] } };
    };
    expect((await call('PATCH', `/switches/${sw.id}`, { host: '192.168.1.99', name: 'Garage' })).status).toBe(202);
    await idle(sw.id);
    expect(await get(sw.id)).toMatchObject({ name: sw.name, host: '192.168.1.217', last: { op: 'update', outcome: 'failed', code: 'save_failed' } });
    expect(audits('switch-test').at(-1)).toMatchObject({ outcome: 'failed', op: 'update', code: 'save_failed', reason: 'duplicate_name' });
  });

  it('a proxy that operates a switch is not deleted: 409 switch_operated naming the switch', async () => {
    const p = await proxy();
    const sw = await add(p);
    const r = await call('DELETE', `/accounts/${p.acc}/proxies/${p.prx}`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'switch_operated', message: expect.stringContaining(`"${sw.name}"`) });
    expect((await get(sw.id)).proxyId).toBe(p.prx);
  });

  it('move: switch.read through the new operator, flip, switch.forget to the old one, audited switch-move, onActive', async () => {
    const p = await proxy();
    const q = await proxy(ALL); // same account ('home')
    const sw = await activate(p, 'GPS208X');
    const active: string[] = [];
    s.built.switches.onActive = (id) => active.push(id);
    readAs(q, 'GPS208X');
    const r = await call('POST', `/switches/${sw.id}/move`, { proxyId: q.prx, host: '10.0.0.5' });
    expect(r.status).toBe(202);
    await until(() => sent(p, 'switch.forget').length === 1, 5000, 'forget on the old operator');
    expect(sent(q, 'switch.read').at(-1)).toMatchObject({ switch: { id: sw.id, host: '10.0.0.5' } });
    expect(sent(p, 'switch.forget')).toEqual([{ v: 1, switchId: sw.id }]);
    expect(await get(sw.id)).toMatchObject({ proxyId: q.prx, host: '10.0.0.5', state: 'active' });
    expect(audits('switch-move').at(-1)).toMatchObject({ outcome: 'ok', from: p.prx, to: q.prx });
    expect(active).toEqual([sw.id]);

    // A move whose test answers another switch changes nothing; another account's proxy is refused.
    readAs(p, 'NOT-IT');
    await call('POST', `/switches/${sw.id}/move`, { proxyId: p.prx });
    await idle(sw.id);
    expect(await get(sw.id)).toMatchObject({ proxyId: q.prx, last: { op: 'move', outcome: 'refused', code: 'switch_mismatch' } });
    const o = await proxy(ALL, 'other');
    expect((await call('POST', `/switches/${sw.id}/move`, { proxyId: o.prx })).body).toMatchObject({ error: 'invalid', field: 'proxyId' });
    expect((await call('POST', `/switches/${sw.id}/move`, { proxyId: q.prx })).body).toMatchObject({ error: 'invalid', field: 'proxyId' });
  });

  it('review triage (Task 7 #1): after a move, the old operator\'s open switch.forget does not keep the switch busy', async () => {
    const p = await proxy();
    const q = await proxy(ALL);
    const sw = await activate(p, 'GPS208Y');
    readAs(q, 'GPS208Y');
    // The old operator is away: its forget stays queued.
    await p.client.stop('shutdown');
    expect((await call('POST', `/switches/${sw.id}/move`, { proxyId: q.prx })).status).toBe(202);
    await until(async () => (await get(sw.id)).proxyId === q.prx, 5000, 'moved');
    await until(() => !!s.built.db.prepare(`SELECT 1 FROM commands WHERE command = 'switch.forget' AND proxy_id = ? AND state = 'queued'`).get(p.prx), 5000, 'forget queued');
    const t = await call('POST', `/switches/${sw.id}/test`);
    expect([t.status, t.body.error]).toEqual([202, undefined]);
    await idle(sw.id);
    // A forget addressed to the current operator still counts.
    q.client.dropCommands = 1;
    s.built.commands.create(ACTOR, q.acc, q.prx, 'switch.forget', { v: 1, switchId: sw.id });
    expect((await call('POST', `/switches/${sw.id}/test`)).body).toEqual({ error: 'switch_busy' });
  });

  it('Review Focus 4: delete while a command for the switch is open → 409 switch_busy', async () => {
    const p = await proxy();
    const sw = await add(p);
    p.client.dropCommands = 1; // the test's read stays open
    expect((await call('POST', `/switches/${sw.id}/test`)).status).toBe(202);
    expect((await call('DELETE', `/switches/${sw.id}`)).body).toEqual({ error: 'switch_busy' });
    expect((await call('POST', `/switches/${sw.id}/test`)).body).toEqual({ error: 'switch_busy' });
    expect((await get(sw.id)).pending).toEqual([{ op: 'test', commandIds: [expect.stringMatching(/^cmd_/)] }]);
    // An open switch command the service didn't make (a survey, a cycle) counts too.
    const sw2 = await add(p);
    s.built.commands.create(ACTOR, p.acc, p.prx, 'switch.read', { v: 1, switch: { id: sw2.id, model: 'sscpoe-web', host: 'h', ports: 8, offSeconds: 10 } });
    expect((await call('DELETE', `/switches/${sw2.id}`)).body).toEqual({ error: 'switch_busy' });
  });

  it('delete: switch.poeOn for each mapped poe port, then switch.forget; cameras unknown; a failed poeOn is audited and does not block', async () => {
    const p = await proxy();
    const sw = await activate(p);
    const reg = s.built.registry;
    const cam = (id: string) => reg.createCamera(ACTOR, p.acc, { camsId: id, name: id, kind: 'camera', host: 'from-proxy' });
    const c1 = cam('c1'), c2 = cam('c2'), c3 = cam('c3');
    const st = s.built.switches.store;
    st.setPower(c1.id, { kind: 'poe', switchId: sw.id, port: 3, watts: 4 } as CameraPower, ACTOR, 'sysadmin', 't');
    st.setPower(c2.id, { kind: 'poe', switchId: sw.id, port: 5, watts: 4 } as CameraPower, ACTOR, 'sysadmin', 't');
    st.setPower(c3.id, { kind: 'data-only', switchId: sw.id, port: 6 } as CameraPower, ACTOR, 'sysadmin', 't');
    p.client.switchResults['switch.poeOn'] = (a) => (a.port === 5 ? { status: 'failed', code: 'switch_unreachable' } : { status: 'ok', result: { port: a.port, poe: true, watts: 0, link: true, tx: 0, rx: 0, wasOn: false } });
    const r = await call('DELETE', `/switches/${sw.id}`);
    expect(r.status).toBe(202);
    expect(r.body.commandIds).toHaveLength(3);
    await until(async () => (await call('GET', `/switches/${sw.id}`)).status === 404, 5000, 'deleted');
    expect(sent(p, 'switch.poeOn').map((a) => a.port)).toEqual([3, 5]);
    expect(sent(p, 'switch.forget')).toEqual([{ v: 1, switchId: sw.id }]);
    // The forget went after the poeOns (one command in flight per proxy, in order).
    const order = p.client.receivedCommands.map((m) => m.body.command).filter((c) => c !== 'switch.read');
    expect(order).toEqual(['switch.poeOn', 'switch.poeOn', 'switch.forget']);
    for (const c of [c1, c2, c3]) expect(reg.getCamera(p.acc, c.id).power).toEqual({ kind: 'unknown' });
    expect(audits('switch-delete').map((x) => x.outcome)).toEqual(['failed', 'ok']);
    expect(audits('switch-delete')[0]).toMatchObject({ step: 'poeOn', port: 5, code: 'switch_unreachable' });
  });

  it('read: the live port table with the mapped cameras per port', async () => {
    const p = await proxy();
    const sw = await activate(p);
    const c1 = s.built.registry.createCamera(ACTOR, p.acc, { camsId: 'c1', name: 'c1', kind: 'camera', host: 'from-proxy' });
    s.built.switches.store.setPower(c1.id, { kind: 'poe', switchId: sw.id, port: 2, watts: 4 } as CameraPower, ACTOR, 'sysadmin', 't');
    p.client.switchResults['switch.read'] = { status: 'ok', result: { sn: 'GPS208X', firmware: 'V2.1', ports: [{ port: 2, poe: true, watts: 4.1, link: true, tx: 1, rx: 2 }] } };
    const r = await call('POST', `/switches/${sw.id}/read`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ commandId: expect.stringMatching(/^cmd_/), state: 'done', live: { sn: 'GPS208X', firmware: 'V2.1' } });
    expect(r.body.ports).toHaveLength(8);
    expect(r.body.ports[1]).toEqual({ port: 2, live: { port: 2, poe: true, watts: 4.1, link: true, tx: 1, rx: 2 }, cameras: [{ id: c1.id, camsId: 'c1', power: expect.objectContaining({ kind: 'poe', port: 2 }) }] });
    expect(r.body.ports[0]).toEqual({ port: 1, live: null, cameras: [] });
  });

  it('switch writes are for a signed-in sysadmin only: an operations token gets 403 scope', async () => {
    const p = await proxy();
    const sw = await add(p);
    const tok = s.built.ops.issue(ACTOR, { name: 'script', scopes: [...OPS_SCOPES], days: 1 });
    for (const [m, path] of [['POST', `/accounts/${p.acc}/switches`], ['PATCH', `/switches/${sw.id}`], ['DELETE', `/switches/${sw.id}`], ['POST', `/switches/${sw.id}/test`], ['POST', `/switches/${sw.id}/move`], ['POST', `/switches/${sw.id}/read`]]) {
      const res = await fetch(`${s.url}/api/v1${path}`, { method: m, headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status, `${m} ${path}`).toBe(403);
    }
  });
});
