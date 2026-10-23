// Camera move step 4 (plan Task 15): the return move, a copy back after a
// cancel after the switch-over. Created with the cancel's end (the source has
// the camera back), roles swapped (the new proxy sends, the original receives),
// move.return.open to the new proxy, move.return.start with the token to the
// original, the original's `copied` → move.finish {return: true} to the
// original, then to the new proxy → returned. Not cancellable; after a
// cams-admin restart (the token lived in memory only) it re-keys.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomInt } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { readEpoch } from '../server/db/open';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProxyInfo } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';
import { ApiError } from '../server/registry';
import { MoveBusy } from '../server/moves/store';
import { moveView } from '../server/moves/view';
import { requiredEntries } from '../server/commands/service';
import { CANCEL_RETRY_MS } from '../server/moves/service';
import { RETURN_PLAN } from '../server/moves/returns';

const ACTOR = 'admin@example.com';
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rq = () => 'rq_' + Array.from({ length: 20 }, () => CROCK[randomInt(32)]).join('');
const FP = 'SHA256:' + 'CD'.repeat(32);
const PLAN = { transfer: true, kinds: ['clips', 'events', 'checks', 'archive'], space: 'all', targetSettings: null, budgetS: 7200, estimateS: 1800 };
const CHECK = { complete: true, missing: {}, recovered: { clips: 1 }, failed: {}, expired: {} };
const sha = (t: string) => 'sha256:' + createHash('sha256').update(t, 'utf8').digest('hex');

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 120;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string; ip: string; site: string }
async function proxy(): Promise<Px> {
  const name = `rt${n++}`;
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
const got = (c: ProxyClient, command: string, moveId?: string) => c.receivedCommands.filter((m) => m.body.command === command && (!moveId || m.body.args.moveId === moveId));
const move = (id: string) => s.built.moves.store.get(id)!;
const auditFor = (action: string) => (s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string }[])
  .map((a) => ({ ...a, d: JSON.parse(a.detail) as Record<string, any> }));
const cmdRows = (moveId: string, command: string) => (s.built.db.prepare(`SELECT id, state, proxy_id FROM commands WHERE command = ? AND json_extract(args, '$.moveId') = ? ORDER BY rowid`).all(command, moveId) as { id: string; state: string; proxy_id: string }[]);
const settle = () => new Promise((r) => setTimeout(r, 250));
const phase = (p: Px, moveId: string, role: 'source' | 'target', ph: string, extra: Record<string, unknown> = {}) =>
  p.client.emitEvent({ kind: 'move.phase', moveId, role, phase: ph, ok: true, ...extra });
const apiErr = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return { status: (e as ApiError).status, code: (e as ApiError).code };
  }
  throw new Error('no error');
};

async function awaiting() {
  const src = await proxy();
  const tgt = await proxy();
  const cam = s.built.registry.createCamera(ACTOR, src.accountId, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
  const { proxyId: _p, connId: _c, ...rest } = fx('valid-event-move-request.json');
  const requestId = rq();
  src.client.emitEvent({ ...rest, requestId, target: tgt.proxyId, camera: { ...rest.camera, proxyCameraId: 'cam1' } });
  await until(() => s.built.moves.store.byRequest(src.proxyId, requestId)?.phase === 'awaiting-approval', 5000, 'awaiting-approval');
  return { src, tgt, cam, m: s.built.moves.store.byRequest(src.proxyId, requestId)! };
}
async function copying() {
  const a = await awaiting();
  a.src.client.emitEvent({ kind: 'move.approve', moveId: a.m.id, plan: PLAN });
  await until(() => got(a.src.client, 'move.go', a.m.id).length === 1 && move(a.m.id).phase === 'switching', 5000, 'move.go');
  phase(a.tgt, a.m.id, 'target', 'switched');
  await until(() => got(a.src.client, 'move.release', a.m.id).length === 1 && move(a.m.id).phase === 'copying', 5000, 'copying');
  return a;
}
// A cancel in copying, the source back with the camera: the return exists.
async function returning(o: { open?: Record<string, any> } = {}) {
  const a = await copying();
  if (o.open) a.tgt.client.moveResults['move.return.open'] = o.open as any;
  s.built.moves.cancel(ACTOR, a.m.id, 'age-out');
  await until(() => cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
  phase(a.src, a.m.id, 'source', 'cancelled');
  await until(() => move(a.m.id).phase === 'cancelled' && !!s.built.moves.store.returnFor(a.m.id), 5000, 'return');
  return { ...a, r: s.built.moves.store.returnFor(a.m.id)! };
}
const progress = (p: Px, moveId: string, chunks: { id: string; state: string }[], bytesDone: number, bytesTotal = 5000) =>
  s.built.moves.onEvent(p.proxyId, p.accountId, { kind: 'move.progress', proxyId: p.proxyId, connId: 'c', moveId, chunks: chunks as any, bytesDone, bytesTotal, rateBps: 1000, etaS: 3 });

describe('the return is created', () => {
  it('a cancel after the switch-over starts a return when the camera is back', async () => {
    const a = await returning();
    expect(a.r).toMatchObject({
      phase: 'returning', sourceProxyId: a.tgt.proxyId, targetProxyId: a.src.proxyId, returnOf: a.m.id, requestId: a.m.id, cameraId: a.cam.id, targetIp: a.src.ip, plan: RETURN_PLAN, endedAt: null,
    });
    expect(RETURN_PLAN).toEqual({ transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 });
    // The cancel's copied choice is ignored after the switch-over (ruling 18): stored as null.
    expect(move(a.m.id).copiedChoice).toBeNull();
    await until(() => got(a.tgt.client, 'move.return.open', a.r.id).length === 1, 5000, 'return.open');
    const args = got(a.tgt.client, 'move.return.open', a.r.id)[0].body.args;
    expect(args).toMatchObject({ v: 1, moveId: a.r.id, returnOf: a.m.id, targetIp: a.src.ip });
    expect(args.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditFor('move-return').map((x) => x.d.step)).toContain('created');
    expect(auditFor('move-return').find((x) => x.d.step === 'created')!.d).toMatchObject({ moveId: a.r.id, returnOf: a.m.id, source: a.tgt.proxyId, target: a.src.proxyId });
  });

  it('a cancelled switched-over move is never prunable without its return', async () => {
    const a = await returning();
    // Years later the cancelled move still has its (unended) return: not pruned.
    expect(s.built.moves.store.prune(clock.now() + 4000 * 86_400_000, 30)).toEqual([]);
    expect(s.built.moves.store.get(a.m.id)).not.toBeNull();
  });

  it('a return that cannot be created keeps the move cancelling (same transaction)', async () => {
    const a = await copying();
    s.built.moves.cancel(ACTOR, a.m.id, 'delete');
    await until(() => cmdRows(a.m.id, 'move.cancel').length === 2, 5000, 'cancels');
    const store = s.built.moves.store;
    const create = store.create.bind(store);
    store.create = () => {
      throw new MoveBusy();
    };
    phase(a.src, a.m.id, 'source', 'cancelled');
    await settle();
    expect(move(a.m.id).phase).toBe('cancelling');
    expect(move(a.m.id).endedAt).toBeNull();
    expect(store.returnFor(a.m.id)).toBeNull();
    expect(s.built.registry.getCamera(a.src.accountId, a.cam.id).proxyId).toBe(a.tgt.proxyId); // rolled back too
    store.create = create;
    phase(a.src, a.m.id, 'source', 'cancelled');
    await until(() => move(a.m.id).phase === 'cancelled' && !!store.returnFor(a.m.id), 5000, 'return');
  });

  it('a cancel before the switch-over starts no return', async () => {
    const a = await awaiting();
    s.built.moves.cancel(ACTOR, a.m.id, 'age-out');
    expect(move(a.m.id)).toMatchObject({ phase: 'cancelled', copiedChoice: 'age-out' });
    await settle();
    expect(s.built.moves.store.returnFor(a.m.id)).toBeNull();
    expect(got(a.tgt.client, 'move.return.open')).toHaveLength(0);
  });

  it('the return commands need the entries each proxy had in the move (ruling 2)', () => {
    expect(requiredEntries('move.return.open', {})).toEqual(['move.receive']);
    expect(requiredEntries('move.return.start', {})).toEqual(['move.send']);
    expect(requiredEntries('move.finish', { role: 'source', return: true })).toEqual(['move.receive']);
    expect(requiredEntries('move.finish', { role: 'target', return: true })).toEqual(['move.send']);
    expect(requiredEntries('move.finish', { role: 'target' })).toEqual(['move.receive']);
  });
});

describe('the return runs', () => {
  it('return: open, then start with the token, copied, finishes, returned', async () => {
    const a = await returning({ open: { status: 'ok', result: { chunks: 3, bytes: 5000 } } });
    await until(() => got(a.src.client, 'move.return.start', a.r.id).length === 1, 5000, 'return.start');
    expect(move(a.r.id).bytesTotal).toBe(5000);
    const open = got(a.tgt.client, 'move.return.open', a.r.id)[0].body.args;
    const start = got(a.src.client, 'move.return.start', a.r.id)[0].body.args;
    expect(start).toMatchObject({
      v: 1, moveId: a.r.id, returnOf: a.m.id, done: [],
      source: { proxyId: a.tgt.proxyId, name: a.tgt.name, url: `http://${a.tgt.ip}:8480`, caFingerprints: [FP], tlsServername: `${a.tgt.name}.${a.tgt.site}.internal` },
    });
    expect(sha(start.token) === open.tokenHash).toBe(true);
    await until(() => auditFor('move-return').some((x) => x.d.step === 'started'), 5000, 'started');
    // The original reports progress for the return (memory, like any move).
    progress(a.src, a.r.id, [{ id: 'clips:2026-10-20', state: 'verified' }], 2500);
    expect(s.built.moves.current(a.r.id)).toMatchObject({ bytesDone: 2500, bytesTotal: 5000 });
    // The new proxy's `released` (after open) changes nothing.
    phase(a.tgt, a.r.id, 'source', 'released');
    await settle();
    expect(move(a.r.id).phase).toBe('returning');
    phase(a.src, a.r.id, 'target', 'copied', { check: CHECK });
    // The original first (Task 16 order), the new proxy only once that is final.
    await until(() => move(a.r.id).phase === 'returned', 5000, 'returned');
    const fins = cmdRows(a.r.id, 'move.finish');
    expect(fins.map((f) => f.proxy_id)).toEqual([a.src.proxyId, a.tgt.proxyId]);
    expect(got(a.src.client, 'move.finish', a.r.id)[0].body.args).toEqual({ v: 1, moveId: a.r.id, role: 'target', abandoned: false, return: true });
    const finAt = s.built.db.prepare(`SELECT proxy_id, created_at, finished_at FROM commands WHERE command = 'move.finish' AND json_extract(args, '$.moveId') = ? ORDER BY rowid`).all(a.r.id) as { proxy_id: string; created_at: number; finished_at: number }[];
    expect(finAt[1].created_at).toBeGreaterThanOrEqual(finAt[0].finished_at);
    expect(move(a.r.id)).toMatchObject({ phase: 'returned', check: CHECK });
    expect(s.built.moves.store.chunks(a.r.id)).toEqual([{ id: 'clips:2026-10-20', state: 'verified' }]);
    expect(got(a.tgt.client, 'move.finish', a.r.id).at(-1)!.body.args).toEqual({ v: 1, moveId: a.r.id, role: 'source', abandoned: false, return: true });
    expect(move(a.r.id).endedAt).not.toBeNull();
    const steps = auditFor('move-return').filter((x) => x.d.moveId === a.r.id);
    expect(steps.map((x) => x.d.step)).toEqual(['created', 'started', 'returned']);
    expect(steps[2].d).toMatchObject({ phase: 'returned', check: CHECK, returnOf: a.m.id });
    expect(auditFor('move-check').filter((x) => x.d.moveId === a.r.id)).toHaveLength(1);
    // No budget for a return (ruling 8).
    expect(auditFor('move-budget-exceeded')).toHaveLength(0);
  });

  it('start waits for open; open is asked again while the new proxy answers wrong_phase', async () => {
    const a = await returning({ open: { status: 'failed', code: 'wrong_phase' } });
    await until(() => cmdRows(a.r.id, 'move.return.open')[0]?.state === 'failed', 5000, 'open failed');
    await settle();
    expect(got(a.src.client, 'move.return.start')).toHaveLength(0);
    s.built.moves.tick();
    await settle();
    expect(cmdRows(a.r.id, 'move.return.open')).toHaveLength(1);
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => cmdRows(a.r.id, 'move.return.open').length === 2, 5000, 'asked again');
    // Every CANCEL_RETRY_MS while wrong_phase (no doubling).
    await until(() => cmdRows(a.r.id, 'move.return.open')[1].state === 'failed', 5000, 'failed again');
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => cmdRows(a.r.id, 'move.return.open').length === 3, 5000, 'asked a third time');
    await until(() => cmdRows(a.r.id, 'move.return.open')[2].state === 'failed', 5000, 'third answered');
    delete a.tgt.client.moveResults['move.return.open'];
    clock.advance(CANCEL_RETRY_MS);
    s.built.moves.tick();
    await until(() => got(a.src.client, 'move.return.start', a.r.id).length === 1, 5000, 'start after open');
    const opens = got(a.tgt.client, 'move.return.open', a.r.id).map((c) => c.body.args.tokenHash);
    expect(new Set(opens).size).toBe(1); // the same key every time
  });

  it('a return cannot be cancelled or ended early', async () => {
    const a = await returning();
    expect(apiErr(() => s.built.moves.cancel(ACTOR, a.r.id, 'delete'))).toEqual({ status: 409, code: 'wrong_phase' });
    expect(apiErr(() => s.built.moves.endTransfer(ACTOR, a.r.id))).toEqual({ status: 409, code: 'wrong_phase' });
    // Nor from a proxy's page.
    a.tgt.client.emitEvent({ kind: 'move.cancel', moveId: a.r.id, copied: 'delete' });
    await settle();
    expect(move(a.r.id).phase).toBe('returning');
    // A failure a side reports does not end it (it retries until done; Give up is the exit).
    a.src.client.emitEvent({ kind: 'move.phase', moveId: a.r.id, role: 'target', phase: 'failed', ok: false, code: 'internal' });
    await settle();
    expect(move(a.r.id).phase).toBe('returning');
  });

  it('no_space pauses and resumes without failing the return', async () => {
    const a = await returning();
    await until(() => got(a.src.client, 'move.return.start', a.r.id).length === 1, 5000, 'return.start');
    phase(a.src, a.r.id, 'target', 'copying', { code: 'no_space' });
    await until(() => move(a.r.id).reason === 'paused:no_space', 5000, 'paused');
    expect(move(a.r.id).phase).toBe('returning');
    expect(moveView(s.built.db, move(a.r.id))).toMatchObject({ phase: 'returning', reason: 'paused:no_space' });
    phase(a.src, a.r.id, 'target', 'copying');
    await until(() => move(a.r.id).reason === null, 5000, 'resumed');
    phase(a.src, a.r.id, 'target', 'copied', { check: CHECK });
    await until(() => move(a.r.id).phase === 'returned', 5000, 'returned');
    expect(move(a.r.id).reason).toBeNull();
  });

  it('return resumes after restart with a new token', async () => {
    const a = await returning();
    await until(() => cmdRows(a.r.id, 'move.return.start')[0]?.state === 'done', 5000, 'started');
    const hash1 = got(a.tgt.client, 'move.return.open', a.r.id)[0].body.args.tokenHash;
    const token1 = got(a.src.client, 'move.return.start', a.r.id)[0].body.args.token;
    s = await s.restart();
    await until(() => got(a.tgt.client, 'move.return.open', a.r.id).length === 2, 8000, 'open again');
    await until(() => got(a.src.client, 'move.return.start', a.r.id).length === 2, 8000, 'start again');
    const hash2 = got(a.tgt.client, 'move.return.open', a.r.id)[1].body.args.tokenHash;
    const token2 = got(a.src.client, 'move.return.start', a.r.id)[1].body.args.token;
    expect(hash2 === hash1).toBe(false);
    expect(token2 === token1).toBe(false);
    expect(sha(token2) === hash2).toBe(true);
    // The re-key went out before the new start.
    const order = (s.built.db.prepare(`SELECT command FROM commands WHERE json_extract(args, '$.moveId') = ? AND command LIKE 'move.return.%' ORDER BY rowid`).all(a.r.id) as { command: string }[]).map((r) => r.command);
    expect(order).toEqual(['move.return.open', 'move.return.start', 'move.return.open', 'move.return.start']);
    // Nothing more on later ticks.
    s.built.moves.tick();
    await settle();
    expect(got(a.tgt.client, 'move.return.open', a.r.id)).toHaveLength(2);
    phase(a.src, a.r.id, 'target', 'copied', { check: CHECK });
    await until(() => s.built.moves.store.get(a.r.id)!.phase === 'returned', 5000, 'returned');
  });

  it('tick writes nothing while a started return copies', async () => {
    const a = await returning();
    await until(() => cmdRows(a.r.id, 'move.return.start')[0]?.state === 'done', 5000, 'started');
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 5; k++) {
      clock.advance(60_000);
      s.built.moves.tick();
    }
    await settle();
    expect(readEpoch(s.built.db)).toBe(epoch);
  });

  it('no token in any command row, audit row or view', async () => {
    const a = await returning();
    await until(() => cmdRows(a.r.id, 'move.return.start')[0]?.state === 'done', 5000, 'started');
    const hash = got(a.tgt.client, 'move.return.open', a.r.id)[0].body.args.tokenHash as string;
    const token = got(a.src.client, 'move.return.start', a.r.id)[0].body.args.token as string;
    phase(a.src, a.r.id, 'target', 'copied', { check: CHECK });
    await until(() => move(a.r.id).phase === 'returned', 5000, 'returned');
    const hex = hash.slice('sha256:'.length);
    const commands = JSON.stringify(s.built.db.prepare('SELECT args, result FROM commands').all());
    const audits = JSON.stringify(s.built.db.prepare('SELECT detail FROM audit_log').all());
    const view = JSON.stringify([moveView(s.built.db, move(a.r.id)), moveView(s.built.db, move(a.m.id))]);
    for (const text of [commands, audits, view]) {
      expect(text.includes(token)).toBe(false);
      expect(text.includes(hex)).toBe(false);
    }
  });
});
