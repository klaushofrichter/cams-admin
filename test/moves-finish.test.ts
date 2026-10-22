// Camera move, the end of the job (plan Task 6): copy progress (memory, at
// most one write a minute, R8), the time budget, `copied` → move.finish to
// both roles (A5) → done, cancel (A17: both roles, A35: also while awaiting
// approval) with the registry back to the source, end transfer (A9: abandoned
// chunks), a failure after the switch-over ending the transfer, and the
// automatic commands that tick derives again until they are queued.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProxyInfo } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';
import { AUDIT_ACTIONS } from '../server/audit';
import { readEpoch } from '../server/db/open';
import { ApiError } from '../server/registry';
import { CANCEL_RETRY_MS, ENDED_RETRY_MS, PROGRESS_SAVE_MS, RELEASE_RETRY_MS, RESUME_GAP_MS } from '../server/moves/service';
import { GIVE_UP_AFTER_MS, RESEND_AFTER_MS } from '../server/commands/service';

const ACTOR = 'admin@example.com';
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rq = () => 'rq_' + Array.from({ length: 20 }, () => CROCK[randomInt(32)]).join('');
const FP = 'SHA256:' + 'CD'.repeat(32);
const LEAF = 'SHA256:' + 'AB'.repeat(32);
const PLAN = { transfer: true, kinds: ['clips', 'events', 'checks'], space: 'retention', targetSettings: { 'storage.maxBytes': 21474836480, 'storage.maxGB': 20 }, budgetS: 7200, estimateS: 1800 };
const DELETED = { stills: { files: 1, bytes: 10 }, clips: { files: 4, bytes: 4000 }, events: { files: 0, bytes: 0 }, checks: { files: 2, bytes: 20 }, archive: { files: 0, bytes: 0 } };

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 60;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string; ip: string; site: string; key: any }
async function proxy(): Promise<Px> {
  const name = `fn${n++}`;
  const p = await enrolled(s, name, 'home');
  const site = `site-${name}`;
  const client = makeClient(p.key, { commands: { allow: ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }) });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'connected');
  const addr = `192.0.2.${ip++}`;
  const cur = s.built.registry.getProxy(p.accountId, p.proxyId);
  s.built.registry.updateProxy(ACTOR, p.accountId, p.proxyId, { url: `http://${addr}:8480`, tlsSite: site, tlsServername: `${name}.${site}.internal`, caFingerprints: [FP], version: cur.version });
  return { ...p, client, name, ip: addr, site };
}
// The proxy goes offline (its client stopped) and comes back (a new client with the same key; cam-proxy's journal: its releases and canned answers).
async function offline(p: Px) {
  await p.client.stop('shutdown');
  clients.splice(clients.indexOf(p.client), 1);
  await until(() => s.built.status.row(p.proxyId)?.connected === false, 5000, 'offline');
}
async function back(p: Px) {
  const c = makeClient(p.key, { commands: { allow: ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site: p.site, caFingerprint: [FP] }) });
  c.releasedMoves = p.client.releasedMoves;
  c.moveResults = p.client.moveResults;
  clients.push(c);
  c.start();
  await until(() => c.state === 'connected' && s.built.status.row(p.proxyId)?.connected === true, 5000, 'back');
  p.client = c;
}
const got = (c: ProxyClient, command: string, moveId?: string) => c.receivedCommands.filter((m) => m.body.command === command && (!moveId || m.body.args.moveId === moveId));
const move = (id: string) => s.built.moves.store.get(id)!;
const auditFor = (action: string) => (s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string; actor_type: string; actor: string }[])
  .map((a) => ({ ...a, d: JSON.parse(a.detail) as Record<string, any> }));
const cmdRows = (moveId: string, command: string) => (s.built.db.prepare(`SELECT id, state, proxy_id FROM commands WHERE command = ? AND json_extract(args, '$.moveId') = ?`).all(command, moveId) as { id: string; state: string; proxy_id: string }[]);
const moveIdOf = (cameraId: string) => (s.built.db.prepare('SELECT move_id FROM cameras WHERE id = ?').get(cameraId) as { move_id: string | null }).move_id;
const settle = () => new Promise((r) => setTimeout(r, 250));

async function awaiting(camsId = 'cam1') {
  const src = await proxy();
  const tgt = await proxy();
  const cam = s.built.registry.createCamera(ACTOR, src.accountId, { camsId, name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
  const { proxyId: _p, connId: _c, ...rest } = fx('valid-event-move-request.json');
  const requestId = rq();
  src.client.emitEvent({ ...rest, requestId, target: tgt.proxyId, camera: { ...rest.camera, proxyCameraId: 'cam1' } });
  await until(() => s.built.moves.store.byRequest(src.proxyId, requestId)?.phase === 'awaiting-approval', 5000, 'awaiting-approval');
  const m = s.built.moves.store.byRequest(src.proxyId, requestId)!;
  return { src, tgt, cam, m };
}
const approve = (p: Px, moveId: string, plan: Record<string, unknown> = PLAN) => p.client.emitEvent({ kind: 'move.approve', moveId, plan });
const phase = (p: Px, moveId: string, role: 'source' | 'target', ph: string, ok = true, code?: string) =>
  p.client.emitEvent({ kind: 'move.phase', moveId, role, phase: ph, ok, ...(code ? { code } : {}) });
async function approved() {
  const a = await awaiting();
  a.tgt.client.dropCommands = 1; // move.start stays open: the move stays approved
  approve(a.src, a.m.id);
  await until(() => got(a.tgt.client, 'move.start', a.m.id).length === 1 && move(a.m.id).phase === 'approved', 5000, 'approved');
  return a;
}
async function switching(camsId?: string) {
  const a = await awaiting(camsId);
  approve(a.src, a.m.id);
  await until(() => got(a.src.client, 'move.go', a.m.id).length === 1 && move(a.m.id).phase === 'switching', 5000, 'move.go');
  return a;
}
async function copying(camsId?: string) {
  const a = await switching(camsId);
  phase(a.tgt, a.m.id, 'target', 'switched');
  await until(() => got(a.src.client, 'move.release', a.m.id).length === 1 && move(a.m.id).phase === 'copying', 5000, 'move.release');
  return a;
}
// A progress event as the target sends it, handed straight to the service (no socket: exact write counts).
const progress = (a: { tgt: Px; m: { id: string } }, chunks: { id: string; state: string }[], bytesDone: number, bytesTotal = 10_000) =>
  s.built.moves.onEvent(a.tgt.proxyId, a.tgt.accountId, { kind: 'move.progress', proxyId: a.tgt.proxyId, connId: 'c', moveId: a.m.id, chunks: chunks as any, bytesDone, bytesTotal, rateBps: 1000, etaS: 9 });
const apiErr = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return { status: (e as ApiError).status, code: (e as ApiError).code };
  }
  throw new Error('no error');
};

describe('progress', () => {
  it('progress updates memory without a DB write each time', async () => {
    const a = await copying();
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 1; k <= 10; k++) {
      clock.advance(1000);
      progress(a, [{ id: `clips:2026-10-0${k % 9 + 1}`, state: 'verified' }], k * 100);
    }
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(s.built.moves.current(a.m.id)).toMatchObject({ bytesDone: 1000, bytesTotal: 10_000, rateBps: 1000, etaS: 9 });
    expect(move(a.m.id).bytesDone).toBeNull();
    expect(s.built.moves.store.chunks(a.m.id)).toEqual([]);
    expect(s.built.moves.chunkStates(a.m.id).length).toBe(9);
  });

  it('chunk states persist at most once a minute', async () => {
    const a = await copying();
    await settle();
    const epoch = readEpoch(s.built.db);
    progress(a, [{ id: 'clips:2026-10-01', state: 'verified' }], 100);
    clock.advance(30_000);
    progress(a, [{ id: 'clips:2026-10-02', state: 'verified' }], 200);
    expect(readEpoch(s.built.db)).toBe(epoch);
    clock.advance(PROGRESS_SAVE_MS - 30_000);
    progress(a, [{ id: 'clips:2026-10-03', state: 'copied' }], 300);
    expect(readEpoch(s.built.db)).toBe(epoch + 1);
    expect(s.built.moves.store.chunks(a.m.id)).toEqual([
      { id: 'clips:2026-10-01', state: 'verified' }, { id: 'clips:2026-10-02', state: 'verified' }, { id: 'clips:2026-10-03', state: 'copied' },
    ]);
    expect(move(a.m.id)).toMatchObject({ bytesDone: 300, rateBps: 1000, etaS: 9 });
    // An hour of progress every 5 s: one write a minute at most.
    const start = readEpoch(s.built.db);
    for (let t = 0; t < 3600; t += 5) {
      clock.advance(5000);
      progress(a, [{ id: 'clips:2026-10-03', state: 'verified' }], 300 + t);
    }
    expect(readEpoch(s.built.db) - start).toBeLessThanOrEqual(60);
    // The last state reaches the DB in tick once its minute is up, without another event.
    progress(a, [{ id: 'events:2026-10-03', state: 'verified' }], 9000);
    clock.advance(PROGRESS_SAVE_MS);
    s.built.moves.tick();
    expect(s.built.moves.store.chunks(a.m.id)).toContainEqual({ id: 'events:2026-10-03', state: 'verified' });
    const e2 = readEpoch(s.built.db);
    clock.advance(PROGRESS_SAVE_MS);
    s.built.moves.tick();
    expect(readEpoch(s.built.db)).toBe(e2); // nothing new: no write
  });

  it('progress from the source, or outside copying, changes nothing', async () => {
    const a = await copying();
    s.built.moves.onEvent(a.src.proxyId, a.src.accountId, { kind: 'move.progress', proxyId: a.src.proxyId, connId: 'c', moveId: a.m.id, chunks: [], bytesDone: 5, bytesTotal: 10, rateBps: 1, etaS: 1 });
    expect(s.built.moves.current(a.m.id)!.bytesDone).toBeNull();
  });

  it('budget exceeded is audited once', async () => {
    const a = await copying();
    clock.advance(PLAN.budgetS * 1000 - 1000);
    progress(a, [], 100);
    expect(auditFor('move-budget-exceeded')).toHaveLength(0);
    clock.advance(2000);
    progress(a, [], 200);
    progress(a, [], 300);
    clock.advance(PROGRESS_SAVE_MS * 3);
    progress(a, [], 400);
    const b = auditFor('move-budget-exceeded');
    expect(b).toHaveLength(1);
    expect(b[0].d).toMatchObject({ moveId: a.m.id, camsId: 'cam1', source: a.src.proxyId, target: a.tgt.proxyId, budgetS: PLAN.budgetS, bytesDone: 200, bytesTotal: 10_000 });
    expect(move(a.m.id).budgetExceededAt).not.toBeNull();
  });

  it('budget passed with everything copied is not exceeded', async () => {
    const a = await copying();
    clock.advance(PLAN.budgetS * 1000 + 1000);
    progress(a, [], 10_000, 10_000);
    expect(auditFor('move-budget-exceeded')).toHaveLength(0);
  });
});

describe('finish', () => {
  it('copied leads to finish then done and keeps move_id', async () => {
    const a = await copying();
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    a.tgt.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: { ...DELETED, clips: { files: 0, bytes: 0 }, stills: { files: 0, bytes: 0 }, checks: { files: 0, bytes: 0 } } } };
    progress(a, [{ id: 'clips:2026-10-01', state: 'verified' }, { id: 'clips:2026-10-02', state: 'skipped' }, { id: 'events:2026-10-01', state: 'failed' }], 9000);
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(got(a.src.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'source', abandoned: false }]);
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: false }]);
    // A16: never cleared.
    expect(moveIdOf(a.cam.id)).toBe(a.m.id);
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    // The chunk states reached the DB at the phase change.
    expect(s.built.moves.store.chunks(a.m.id)).toHaveLength(3);
    expect(auditFor('move-phase').some((x) => x.d.moveId === a.m.id && x.d.phase === 'cleaning')).toBe(true);
    const done = auditFor('move-done');
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe('ok');
    expect(done[0].d).toMatchObject({
      moveId: a.m.id, camsId: 'cam1', source: a.src.proxyId, target: a.tgt.proxyId, phase: 'done', abandoned: false, cleanup: 'done', deleted: DELETED,
      chunks: { copied: 1, skipped: 1, failed: 1, abandoned: 0, pending: 0 },
    });
    expect(typeof done[0].d.durationS).toBe('number');
    // Repeated terminal events (cam-proxy re-emits) change nothing.
    const epoch = readEpoch(s.built.db);
    phase(a.tgt, a.m.id, 'target', 'copied');
    phase(a.tgt, a.m.id, 'target', 'finished');
    phase(a.src, a.m.id, 'source', 'finished');
    await settle();
    s.built.moves.tick();
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(cmdRows(a.m.id, 'move.finish')).toHaveLength(2);
  });

  it('a lost finish is derived again by resume', async () => {
    const a = await copying();
    a.src.client.dropCommands = 1;
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'cleaning' && got(a.src.client, 'move.finish', a.m.id).length === 1, 5000, 'cleaning');
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.finish' AND proxy_id = ?`).run(a.src.proxyId);
    s.built.moves.resume(a.m.id);
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(cmdRows(a.m.id, 'move.finish')).toHaveLength(2);
  });
});

describe('cancel', () => {
  it('cancel before switch-over sends the cancel to both roles (A17)', async () => {
    const a = await approved();
    s.built.moves.cancel(ACTOR, a.m.id, 'age-out');
    // The open move.start goes out again (answered now, too late), then the cancel.
    clock.advance(RESEND_AFTER_MS);
    s.built.commands.tick();
    await until(() => got(a.src.client, 'move.cancel', a.m.id).length === 1 && got(a.tgt.client, 'move.cancel', a.m.id).length === 1, 5000, 'cancels');
    expect(got(a.tgt.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'target', copied: 'age-out' });
    // move.go never went out: no expected leaf.
    expect(got(a.src.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'source' });
    expect(move(a.m.id)).toMatchObject({ phase: 'cancelled', copiedChoice: 'age-out' });
    expect(move(a.m.id).endedAt).not.toBeNull();
    const c = auditFor('move-cancel');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ actor_type: 'sysadmin', actor: ACTOR, outcome: 'ok' });
    expect(c[0].d).toMatchObject({ moveId: a.m.id, phase: 'cancelled', from: 'approved', copied: 'age-out' });
  });

  it('cancel in switching names the expected leaf to the source', async () => {
    const a = await switching();
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    await until(() => got(a.src.client, 'move.cancel', a.m.id).length === 1 && got(a.tgt.client, 'move.cancel', a.m.id).length === 1, 5000, 'cancels');
    expect(got(a.src.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'source', expectedLeaf: LEAF });
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.src.proxyId);
  });

  it('cancel while awaiting approval ends the move and cancels both (A35)', async () => {
    const a = await awaiting();
    a.src.client.emitEvent({ kind: 'move.cancel', moveId: a.m.id, copied: 'delete' });
    await until(() => move(a.m.id).phase === 'cancelled', 5000, 'cancelled');
    await until(() => got(a.src.client, 'move.cancel', a.m.id).length === 1 && got(a.tgt.client, 'move.cancel', a.m.id).length === 1, 5000, 'cancels');
    expect(auditFor('move-cancel')[0]).toMatchObject({ actor_type: 'proxy', actor: a.src.proxyId });
  });

  it('a cancel event from the target is ignored', async () => {
    const a = await awaiting();
    a.tgt.client.emitEvent({ kind: 'move.cancel', moveId: a.m.id, copied: 'delete' });
    await settle();
    expect(move(a.m.id).phase).toBe('awaiting-approval');
  });

  it('cancel during release ends with the camera on the source', async () => {
    const src = await switching();
    src.src.client.dropCommands = 1; // move.release is received and never answered: in flight
    phase(src.tgt, src.m.id, 'target', 'switched');
    await until(() => got(src.src.client, 'move.release', src.m.id).length === 1 && move(src.m.id).phase === 'copying', 5000, 'release in flight');
    const a = src;
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    progress(a, [{ id: 'clips:2026-10-01', state: 'verified' }], 100);
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    expect(move(a.m.id).phase).toBe('cancelling');
    expect(s.built.moves.store.chunks(a.m.id)).toEqual([{ id: 'clips:2026-10-01', state: 'verified' }]);
    await until(() => got(a.tgt.client, 'move.cancel', a.m.id).length === 1, 5000, 'target cancel');
    expect(got(a.tgt.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'target', copied: 'delete' });
    // The registry stays on the target until the source reports the camera back.
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    // The release answers late (re-sent after a reconnect): nothing changes.
    phase(a.src, a.m.id, 'source', 'released');
    await settle();
    expect(move(a.m.id).phase).toBe('cancelling');
    phase(a.src, a.m.id, 'source', 'cancelled');
    await until(() => move(a.m.id).phase === 'cancelled', 5000, 'cancelled');
    const c = s.built.registry.getCamera(a.src.accountId, a.cam.id);
    expect(c).toMatchObject({ proxyId: a.src.proxyId, proxyCameraId: 'cam1', tlsServername: `cam1.${a.src.site}.internal` });
    expect(moveIdOf(a.cam.id)).toBe(a.m.id); // A16: never cleared
    expect(auditFor('move-switch')).toHaveLength(2);
    // Again: nothing more.
    const epoch = readEpoch(s.built.db);
    phase(a.src, a.m.id, 'source', 'cancelled');
    await settle();
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(auditFor('move-switch')).toHaveLength(2);
  });

  it('cancel after switch-over with the source offline holds until the source is back (ruling a)', async () => {
    const a = await copying();
    await offline(a.src);
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    expect(move(a.m.id).phase).toBe('cancelling');
    await settle();
    s.built.moves.tick();
    await settle();
    // The camera keeps working on the target: no target cancel yet.
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(0);
    expect(got(a.tgt.client, 'move.cancel', a.m.id)).toHaveLength(0);
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    await back(a.src);
    await until(() => cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
    const rows = s.built.db.prepare(`SELECT proxy_id FROM commands WHERE command = 'move.cancel' AND json_extract(args, '$.moveId') = ? ORDER BY rowid`).all(a.m.id) as { proxy_id: string }[];
    expect(rows.map((r) => r.proxy_id)).toEqual([a.tgt.proxyId, a.src.proxyId]);
    await until(() => got(a.src.client, 'move.cancel', a.m.id).length === 1, 5000, 'source cancel');
    expect(got(a.src.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'source', expectedLeaf: LEAF });
  });

  it('a source cancel answered failed is asked again with a backoff and audited', async () => {
    const a = await copying();
    a.src.client.moveResults['move.cancel'] = { status: 'failed', code: 'camera_unreachable' };
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    await until(() => cmdRows(a.m.id, 'move.cancel').some((r) => r.proxy_id === a.src.proxyId && r.state === 'failed'), 5000, 'source cancel failed');
    await until(() => auditFor('move-cancel').some((x) => x.outcome === 'failed'), 5000, 'failure audited');
    expect(auditFor('move-cancel').find((x) => x.outcome === 'failed')!.d).toMatchObject({ moveId: a.m.id, code: 'camera_unreachable', attempts: 1 });
    const srcCancels = () => cmdRows(a.m.id, 'move.cancel').filter((r) => r.proxy_id === a.src.proxyId);
    s.built.moves.tick();
    await settle();
    expect(srcCancels()).toHaveLength(1);
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => srcCancels().length === 2 && srcCancels()[1].state === 'failed', 5000, 'asked again');
    // The backoff doubles: not again after one more base interval.
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await settle();
    expect(srcCancels()).toHaveLength(2);
    delete a.src.client.moveResults['move.cancel'];
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => srcCancels().length === 3 && srcCancels()[2].state === 'done', 5000, 'taken on');
    phase(a.src, a.m.id, 'source', 'cancelled');
    await until(() => move(a.m.id).phase === 'cancelled', 5000, 'cancelled');
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.src.proxyId);
  });

  it('a target cancel answered failed is asked again after the move is cancelled', async () => {
    const a = await copying();
    a.tgt.client.moveResults['move.cancel'] = { status: 'failed', code: 'camera_active' };
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    const tgtCancels = () => cmdRows(a.m.id, 'move.cancel').filter((r) => r.proxy_id === a.tgt.proxyId);
    await until(() => tgtCancels()[0]?.state === 'failed' && cmdRows(a.m.id, 'move.cancel').some((r) => r.proxy_id === a.src.proxyId && r.state === 'done'), 5000, 'answers');
    phase(a.src, a.m.id, 'source', 'cancelled');
    await until(() => move(a.m.id).phase === 'cancelled', 5000, 'cancelled');
    await until(() => auditFor('move-cancel').some((x) => x.outcome === 'failed' && x.d.role === 'target'), 5000, 'failure audited');
    s.built.moves.tick();
    await settle();
    expect(tgtCancels()).toHaveLength(1);
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => tgtCancels().length === 2 && tgtCancels()[1].state === 'failed', 5000, 'asked again');
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await settle();
    expect(tgtCancels()).toHaveLength(2); // the backoff doubles
    delete a.tgt.client.moveResults['move.cancel'];
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => tgtCancels().length === 3 && tgtCancels()[2].state === 'done', 5000, 'taken on');
    clock.advance(CANCEL_RETRY_MS * 8);
    s.built.moves.tick();
    await settle();
    expect(tgtCancels()).toHaveLength(3);
  });

  it('cancel in done is refused 409', async () => {
    const a = await copying();
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(apiErr(() => s.built.moves.cancel(ACTOR, a.m.id, 'delete'))).toEqual({ status: 409, code: 'wrong_phase' });
    expect(apiErr(() => s.built.moves.endTransfer(ACTOR, a.m.id))).toEqual({ status: 409, code: 'wrong_phase' });
    expect(apiErr(() => s.built.moves.cancel(ACTOR, 'mv_00000000000000000000', 'delete'))).toEqual({ status: 404, code: 'not_found' });
    expect(apiErr(() => s.built.moves.cancel(ACTOR, a.m.id, 'keep' as any))).toEqual({ status: 400, code: 'invalid_copied' });
  });

  it('cancel in cleaning is refused 409', async () => {
    const a = await copying();
    a.src.client.dropCommands = 1;
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'cleaning', 5000, 'cleaning');
    expect(apiErr(() => s.built.moves.cancel(ACTOR, a.m.id, 'delete'))).toEqual({ status: 409, code: 'wrong_phase' });
  });
});

describe('end transfer', () => {
  it('end transfer with the source offline completes with cleanup not-done', async () => {
    const a = await copying();
    progress(a, [{ id: 'clips:2026-10-01', state: 'verified' }, { id: 'clips:2026-10-02', state: 'copied' }, { id: 'clips:2026-10-03', state: 'pending' }, { id: 'events:2026-10-01', state: 'skipped' }], 500);
    await a.src.client.stop('shutdown');
    clients.splice(clients.indexOf(a.src.client), 1);
    await until(() => s.built.status.row(a.src.proxyId)?.connected === false, 5000, 'source offline');
    const before = got(a.src.client, 'move.finish').length;
    s.built.moves.endTransfer(ACTOR, a.m.id);
    expect(move(a.m.id).phase).toBe('cleaning');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: true }]);
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.src.proxyId)).toHaveLength(0);
    expect(got(a.src.client, 'move.finish').length).toBe(before);
    // A9: the non-final chunks are stored abandoned, apart from skipped.
    expect(s.built.moves.store.chunks(a.m.id)).toEqual([
      { id: 'clips:2026-10-01', state: 'verified' }, { id: 'clips:2026-10-02', state: 'abandoned' }, { id: 'clips:2026-10-03', state: 'abandoned' }, { id: 'events:2026-10-01', state: 'skipped' },
    ]);
    const e = auditFor('move-end-transfer');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ actor_type: 'sysadmin', actor: ACTOR });
    expect(e[0].d).toMatchObject({ moveId: a.m.id, abandoned: 2, sourceOnline: false });
    const done = auditFor('move-done');
    expect(done).toHaveLength(1);
    expect(done[0].d).toMatchObject({ abandoned: true, cleanup: 'pending', chunks: { copied: 1, skipped: 1, failed: 0, abandoned: 2, pending: 0 } });
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    // Ruling (b): the source's cleanup stays pending; tick writes nothing while the source is away.
    expect(move(a.m.id).cleanupPending).toBe(true);
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 3; k++) {
      clock.advance(60_000);
      s.built.moves.tick();
    }
    expect(readEpoch(s.built.db)).toBe(epoch);
    // The source comes back: its finish goes out, the cleanup lands and is audited.
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    await back(a.src);
    await until(() => move(a.m.id).cleanupPending === false, 5000, 'cleanup landed');
    expect(got(a.src.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'source', abandoned: true }]);
    const all = auditFor('move-done');
    expect(all).toHaveLength(2);
    expect(all[1].d).toMatchObject({ moveId: a.m.id, cleanup: 'done', followUp: true, deleted: DELETED, cleanupAt: expect.any(Number) });
    expect(move(a.m.id).phase).toBe('done');
  });

  it('a source finish that goes unanswered (the source dropped) leaves the cleanup pending and is sent again', async () => {
    const a = await copying();
    a.src.client.dropCommands = 1; // the source finish is received, never answered
    s.built.moves.endTransfer(ACTOR, a.m.id);
    await until(() => got(a.src.client, 'move.finish', a.m.id).length === 1 && cmdRows(a.m.id, 'move.finish').some((r) => r.proxy_id === a.tgt.proxyId && r.state === 'done'), 5000, 'finishes');
    await offline(a.src);
    clock.advance(GIVE_UP_AFTER_MS);
    s.built.commands.tick();
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(cmdRows(a.m.id, 'move.finish').find((r) => r.proxy_id === a.src.proxyId)!.state).toBe('unknown');
    expect(move(a.m.id).cleanupPending).toBe(true);
    expect(auditFor('move-done')[0].d).toMatchObject({ cleanup: 'pending' });
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    await back(a.src);
    await until(() => move(a.m.id).cleanupPending === false, 5000, 'cleanup landed');
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.src.proxyId).map((r) => r.state)).toEqual(['unknown', 'done']);
    expect(auditFor('move-done')[1].d).toMatchObject({ followUp: true, cleanup: 'done', deleted: DELETED });
  });

  it('a post-switch failure with the source offline leaves the cleanup pending', async () => {
    const a = await copying();
    await offline(a.src);
    phase(a.tgt, a.m.id, 'target', 'failed', false, 'disk_full');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(move(a.m.id).cleanupPending).toBe(true);
    expect(auditFor('move-done')[0].d).toMatchObject({ failure: 'target:disk_full', cleanup: 'pending' });
  });

  it('end transfer with the source online sends move.finish abandoned to both roles', async () => {
    const a = await copying();
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    s.built.moves.endTransfer(ACTOR, a.m.id);
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(got(a.src.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'source', abandoned: true }]);
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: true }]);
    expect(auditFor('move-done')[0].d).toMatchObject({ abandoned: true, cleanup: 'done', deleted: DELETED });
  });

  it('end transfer with the target offline 15+ min: done with the target cleanup pending; the returning target gets its finish again', async () => {
    const a = await copying();
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    await offline(a.tgt);
    s.built.moves.endTransfer(ACTOR, a.m.id);
    await until(() => cmdRows(a.m.id, 'move.finish').some((r) => r.proxy_id === a.src.proxyId && r.state === 'done'), 5000, 'source finish');
    await settle();
    expect(move(a.m.id).phase).toBe('cleaning');
    // The target finish expires unsent: an unanswered target finish never counts as final.
    clock.advance(GIVE_UP_AFTER_MS);
    s.built.commands.tick();
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(cmdRows(a.m.id, 'move.finish').find((r) => r.proxy_id === a.tgt.proxyId)!.state).toBe('expired');
    expect(move(a.m.id)).toMatchObject({ cleanupPending: false, targetCleanupPending: true });
    expect(auditFor('move-done')[0].d).toMatchObject({ abandoned: true, cleanup: 'done', targetCleanup: 'pending' });
    // Nothing is queued to the absent target, and idle ticks write nothing.
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 3; k++) {
      clock.advance(60_000);
      s.built.moves.tick();
    }
    expect(readEpoch(s.built.db)).toBe(epoch);
    await back(a.tgt);
    await until(() => move(a.m.id).targetCleanupPending === false, 5000, 'target cleanup landed');
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.tgt.proxyId).map((r) => r.state)).toEqual(['expired', 'done']);
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: true }]);
    const all = auditFor('move-done');
    expect(all).toHaveLength(2);
    expect(all[1].d).toMatchObject({ moveId: a.m.id, followUp: true, role: 'target', targetCleanup: 'done', cleanupAt: expect.any(Number) });
    expect(all[1].actor).toBe(a.tgt.proxyId);
    // Landed: nothing more.
    clock.advance(60_000);
    s.built.moves.tick();
    await settle();
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.tgt.proxyId)).toHaveLength(2);
  });

  it('end transfer outside copying is refused', async () => {
    const a = await switching();
    expect(apiErr(() => s.built.moves.endTransfer(ACTOR, a.m.id))).toEqual({ status: 409, code: 'wrong_phase' });
  });
});

describe('failures after the switch-over', () => {
  it('a target failure in copying ends the transfer instead of cancelling', async () => {
    const a = await copying();
    phase(a.tgt, a.m.id, 'target', 'failed', false, 'disk_full');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(got(a.src.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'source', abandoned: true }]);
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: true }]);
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(0);
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId);
    const done = auditFor('move-done');
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe('failed');
    expect(done[0].d).toMatchObject({ failure: 'target:disk_full', abandoned: true });
  });

  it('a failing move.release ends the transfer; the release is derived again before the source finish', async () => {
    const a = await switching();
    a.src.client.moveResults['move.release'] = { status: 'failed', code: 'camera_active' };
    phase(a.tgt, a.m.id, 'target', 'switched');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(auditFor('move-done')[0].d).toMatchObject({ failure: 'release:camera_active', cleanup: 'pending' });
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(0);
    // No source finish while the source has not released (cam-proxy refuses it: wrong_phase).
    expect(got(a.src.client, 'move.finish', a.m.id)).toHaveLength(0);
    expect(move(a.m.id).cleanupPending).toBe(true);
    // Backoff: not again at once.
    s.built.moves.tick();
    await settle();
    expect(cmdRows(a.m.id, 'move.release')).toHaveLength(1);
    delete a.src.client.moveResults['move.release'];
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    clock.advance(RELEASE_RETRY_MS);
    s.built.moves.tick();
    await until(() => move(a.m.id).cleanupPending === false, 5000, 'cleanup landed');
    expect(cmdRows(a.m.id, 'move.release')).toHaveLength(2);
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.src.proxyId).map((r) => r.state)).toEqual(['done']);
    expect(auditFor('move-done')[1].d).toMatchObject({ cleanup: 'done', followUp: true, deleted: DELETED });
  });

  it('a move.release that expires while the source is away is sent again once it is back; the copy completes', async () => {
    const a = await switching();
    await offline(a.src);
    phase(a.tgt, a.m.id, 'target', 'switched');
    await until(() => move(a.m.id).phase === 'copying' && cmdRows(a.m.id, 'move.release').length === 1, 5000, 'copying');
    clock.advance(GIVE_UP_AFTER_MS);
    s.built.commands.tick();
    await until(() => cmdRows(a.m.id, 'move.release')[0].state === 'expired', 5000, 'release expired');
    await settle();
    // Only an answered failed/refused release ends the transfer.
    expect(move(a.m.id)).toMatchObject({ phase: 'copying', reason: null });
    expect(auditFor('move-end-transfer')).toHaveLength(0);
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 3; k++) {
      clock.advance(RESUME_GAP_MS);
      s.built.moves.tick();
    }
    expect(readEpoch(s.built.db)).toBe(epoch);
    await back(a.src);
    await until(() => cmdRows(a.m.id, 'move.release').map((r) => r.state).join() === 'expired,done', 5000, 'release re-sent');
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(move(a.m.id)).toMatchObject({ reason: null, cleanupPending: false });
    expect(auditFor('move-end-transfer')).toHaveLength(0);
    expect(auditFor('move-done')[0].d).toMatchObject({ abandoned: false, cleanup: 'done' });
    expect(got(a.tgt.client, 'move.finish', a.m.id).map((c) => c.body.args)).toEqual([{ v: 1, moveId: a.m.id, role: 'target', abandoned: false }]);
  });

  it('copied while move.release is still open: the source finish waits for a released source', async () => {
    const a = await switching();
    a.src.client.dropCommands = 1; // move.release in flight
    phase(a.tgt, a.m.id, 'target', 'switched');
    await until(() => got(a.src.client, 'move.release', a.m.id).length === 1, 5000, 'release in flight');
    phase(a.tgt, a.m.id, 'target', 'copied');
    await until(() => move(a.m.id).phase === 'cleaning', 5000, 'cleaning');
    // The re-sent release fails.
    a.src.client.moveResults['move.release'] = { status: 'failed', code: 'camera_active' };
    clock.advance(RESEND_AFTER_MS);
    s.built.commands.tick();
    await until(() => cmdRows(a.m.id, 'move.release')[0].state === 'failed', 5000, 'release failed');
    await settle();
    expect(move(a.m.id).phase).toBe('cleaning');
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.src.proxyId)).toHaveLength(0);
    // It is derived again (after the backoff) and the source finish follows.
    delete a.src.client.moveResults['move.release'];
    a.src.client.moveResults['move.finish'] = { status: 'ok', result: { deleted: DELETED } };
    clock.advance(RELEASE_RETRY_MS);
    s.built.moves.tick();
    await until(() => move(a.m.id).phase === 'done', 5000, 'done');
    expect(cmdRows(a.m.id, 'move.finish').filter((r) => r.proxy_id === a.src.proxyId).map((r) => r.state)).toEqual(['done']);
    expect(auditFor('move-done')[0].d).toMatchObject({ abandoned: false, cleanup: 'done', deleted: DELETED });
    expect(move(a.m.id).cleanupPending).toBe(false);
  });
});

describe('automatic commands are retried until queued', () => {
  it('a lost auto-cancel of a failed move is derived again in tick', async () => {
    const a = await switching();
    phase(a.tgt, a.m.id, 'target', 'failed', false, 'camera_failed');
    await until(() => cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.cancel' AND proxy_id = ?`).run(a.src.proxyId);
    clock.advance(60_000);
    s.built.moves.tick();
    await until(() => got(a.src.client, 'move.cancel', a.m.id).length === 2, 5000, 'cancel again');
    expect(got(a.src.client, 'move.cancel', a.m.id)[1].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'source', expectedLeaf: LEAF });
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(2);
    clock.advance(60_000);
    s.built.moves.tick();
    await settle();
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(2);
  });

  it('a target back after more than a day still gets the cancel of a failed move', async () => {
    const a = await switching();
    await offline(a.tgt);
    phase(a.src, a.m.id, 'source', 'failed', false, 'camera_failed');
    await until(() => move(a.m.id).phase === 'failed' && cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
    const tgtCancels = () => cmdRows(a.m.id, 'move.cancel').filter((r) => r.proxy_id === a.tgt.proxyId);
    clock.advance(ENDED_RETRY_MS + 3600_000);
    s.built.commands.tick();
    await until(() => tgtCancels()[0]?.state === 'expired', 5000, 'target cancel expired');
    s.built.moves.tick(); // the ended sweep no longer covers it
    await settle();
    expect(tgtCancels()).toHaveLength(1);
    await back(a.tgt);
    await until(() => got(a.tgt.client, 'move.cancel', a.m.id).length === 1, 5000, 'cancel on return');
    expect(got(a.tgt.client, 'move.cancel', a.m.id)[0].body.args).toEqual({ v: 1, moveId: a.m.id, role: 'target', copied: 'delete' });
    await until(() => tgtCancels().map((r) => r.state).join() === 'expired,done', 5000, 'taken on');
    // Done: another return asks nothing.
    await offline(a.tgt);
    await back(a.tgt);
    await settle();
    expect(tgtCancels()).toHaveLength(2);
  });

  it('a lost cancel while cancelling is derived again by resume', async () => {
    const a = await copying();
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    await until(() => cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.cancel' AND proxy_id = ?`).run(a.tgt.proxyId);
    s.built.moves.resume(a.m.id);
    await until(() => got(a.tgt.client, 'move.cancel', a.m.id).length === 2, 5000, 'cancel again');
    expect(cmdRows(a.m.id, 'move.cancel')).toHaveLength(2);
  });

  it('an open that fails sends the cancel to both roles', async () => {
    const src = await proxy();
    const tgt = await proxy();
    s.built.registry.createCamera(ACTOR, src.accountId, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
    src.client.moveResults['move.open'] = { status: 'failed', code: 'internal' };
    const { proxyId: _p, connId: _c, ...rest } = fx('valid-event-move-request.json');
    const requestId = rq();
    src.client.emitEvent({ ...rest, requestId, target: tgt.proxyId, camera: { ...rest.camera, proxyCameraId: 'cam1' } });
    await until(() => s.built.moves.store.byRequest(src.proxyId, requestId)?.phase === 'failed', 5000, 'failed');
    const m = s.built.moves.store.byRequest(src.proxyId, requestId)!;
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    expect(got(tgt.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'target', copied: 'delete' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });
});

describe('write budget', () => {
  it('tick writes nothing for moves that are cleaning, cancelling or ended with their commands queued', async () => {
    const a = await copying();
    a.src.client.dropCommands = 1;
    phase(a.tgt, a.m.id, 'target', 'copied'); // cleaning, the source's finish open
    const b = await copying('cam2');
    s.built.moves.cancel(ACTOR, b.m.id, 'delete'); // cancelling
    const c = await switching('cam3');
    phase(c.tgt, c.m.id, 'target', 'failed', false, 'camera_failed'); // failed, both cancels queued
    await until(() => move(a.m.id).phase === 'cleaning' && cmdRows(c.m.id, 'move.cancel').length === 2 && cmdRows(b.m.id, 'move.cancel').length === 2, 5000, 'set up');
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 5; k++) {
      clock.advance(60_000);
      s.built.moves.tick();
    }
    expect(readEpoch(s.built.db)).toBe(epoch);
  });
});

describe('approval details (Task 6 rulings)', () => {
  it('a repeated approve with the kinds in another order is the same plan', async () => {
    const a = await switching();
    approve(a.src, a.m.id, { ...PLAN, kinds: [...PLAN.kinds].reverse() });
    await settle();
    expect(auditFor('move-approve').map((x) => x.outcome)).toEqual(['ok']);
  });

  it('the move-approve audit logs the setting paths, not their values', async () => {
    const a = await switching();
    const d = auditFor('move-approve')[0].d;
    expect(d.plan).toEqual({ transfer: true, kinds: PLAN.kinds, space: 'retention', targetSettings: ['storage.maxBytes', 'storage.maxGB'], budgetS: 7200, estimateS: 1800 });
    expect(JSON.stringify(d)).not.toContain('21474836480');
    void a;
  });
});

it('lists the end-of-move audit actions', () => {
  for (const a of ['move-budget-exceeded', 'move-cancel', 'move-done', 'move-end-transfer']) expect(AUDIT_ACTIONS).toContain(a);
});
