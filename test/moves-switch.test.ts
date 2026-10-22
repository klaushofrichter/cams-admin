// Camera move, approval to switch-over (plan Task 5): move.approve from the
// source, move.start to the target, move.go with the target's key and leaf to
// the source, the registry change at `switched`, move.release, resume, offer
// expiry and the automatic cancel when a side fails before the switch-over.
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
import { snapshotRevision } from '../server/cams/snapshot';
import { readEpoch } from '../server/db/open';
import { OFFER_EXPIRY_MS } from '../server/moves/service';

const ACTOR = 'admin@example.com';
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rq = () => 'rq_' + Array.from({ length: 20 }, () => CROCK[randomInt(32)]).join('');
const FP = 'SHA256:' + 'CD'.repeat(32);
// The test client's canned move.start answer.
const PUBLIC_KEY = 'MCowBQYDK2VuAyEA' + 'A'.repeat(43) + '=';
const LEAF = 'SHA256:' + 'AB'.repeat(32);
// An approved plan with host-wide target settings (R9), bytes included: passed through unchanged.
const PLAN = { transfer: true, kinds: ['clips', 'events', 'checks'], space: 'retention', targetSettings: { 'storage.maxBytes': 21474836480, 'storage.maxGB': 20 }, budgetS: 7200, estimateS: 1800 };

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 40;

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
  const name = `sw${n++}`;
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
const auditFor = (action: string) => (s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string; actor_type: string }[])
  .map((a) => ({ ...a, d: JSON.parse(a.detail) as Record<string, any> }));
const cmdRows = (moveId: string, command: string) => (s.built.db.prepare(`SELECT id, state, proxy_id FROM commands WHERE command = ? AND json_extract(args, '$.moveId') = ?`).all(command, moveId) as { id: string; state: string; proxy_id: string }[]);
const settle = () => new Promise((r) => setTimeout(r, 250));

// A move up to awaiting-approval: the source asked, the target accepted.
async function awaiting() {
  const src = await proxy();
  const tgt = await proxy();
  const cam = s.built.registry.createCamera(ACTOR, src.accountId, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
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
async function switching() {
  const a = await awaiting();
  approve(a.src, a.m.id);
  await until(() => got(a.src.client, 'move.go', a.m.id).length === 1 && move(a.m.id).phase === 'switching', 5000, 'move.go');
  return a;
}
async function switched() {
  const a = await switching();
  phase(a.tgt, a.m.id, 'target', 'switched');
  await until(() => got(a.src.client, 'move.release', a.m.id).length === 1, 5000, 'move.release');
  return a;
}

describe('approval', () => {
  it('approve from a proxy that is not the source is refused', async () => {
    const { src, tgt, m } = await awaiting();
    const third = await proxy();
    approve(tgt, m.id);
    approve(third, m.id);
    await until(() => auditFor('move-approve').length >= 1, 5000, 'refused audit');
    await settle();
    expect(move(m.id).phase).toBe('awaiting-approval');
    expect(move(m.id).plan).toBeNull();
    expect(got(tgt.client, 'move.start')).toHaveLength(0);
    expect(auditFor('move-approve').every((a) => a.outcome === 'refused')).toBe(true);
    expect(auditFor('move-approve')[0].d).toMatchObject({ moveId: m.id, reason: 'not_source' });
    // The source still can.
    approve(src, m.id);
    await until(() => move(m.id).phase !== 'awaiting-approval', 5000, 'approved');
  });

  it('approve after 30 minutes is refused and the move fails offer_expired', async () => {
    const { src, tgt, m } = await awaiting();
    clock.advance(OFFER_EXPIRY_MS + 1000);
    approve(src, m.id);
    await until(() => move(m.id).phase === 'failed', 5000, 'failed');
    expect(move(m.id)).toMatchObject({ reason: 'offer_expired', plan: null, approvedAt: null });
    expect(move(m.id).endedAt).not.toBeNull();
    expect(got(tgt.client, 'move.start')).toHaveLength(0);
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    expect(got(src.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'source' });
    expect(got(tgt.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'target', copied: 'delete' });
    expect(auditFor('move-approve').map((a) => [a.outcome, a.d.reason])).toEqual([['refused', 'offer_expired']]);
  });

  it('an offer not approved within 30 minutes expires in tick and both sides are cancelled', async () => {
    const { src, tgt, m } = await awaiting();
    clock.advance(OFFER_EXPIRY_MS - 1000);
    s.built.tick();
    expect(move(m.id).phase).toBe('awaiting-approval');
    clock.advance(2000);
    s.built.tick();
    expect(move(m.id)).toMatchObject({ phase: 'failed', reason: 'offer_expired' });
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    expect(auditFor('move-phase').filter((a) => a.d.moveId === m.id && a.d.phase === 'failed').map((a) => a.d.reason)).toEqual(['offer_expired']);
    // Again: nothing more.
    s.built.tick();
    approve(src, m.id);
    await settle();
    expect(cmdRows(m.id, 'move.cancel')).toHaveLength(2);
    expect(got(tgt.client, 'move.start')).toHaveLength(0);
  });

  it('approval stores the plan unchanged, sets approved_at and sends move.start to the target', async () => {
    const { src, tgt, m } = await awaiting();
    const at = clock.now();
    approve(src, m.id);
    await until(() => got(tgt.client, 'move.start', m.id).length === 1, 5000, 'move.start');
    const mv = move(m.id);
    expect(mv.plan).toEqual(PLAN);
    expect(mv.approvedAt).toBe(at);
    expect(got(tgt.client, 'move.start', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, plan: PLAN, settings: m.settings, done: [] });
    expect(auditFor('move-approve').map((a) => a.outcome)).toEqual(['ok']);
    expect(auditFor('move-approve')[0].d).toMatchObject({ moveId: m.id, camsId: 'cam1', source: src.proxyId, target: tgt.proxyId, phase: 'approved', plan: PLAN });
  });

  it('a repeated approve (same plan) sends nothing new; another plan is refused', async () => {
    const { src, tgt, m } = await switching();
    approve(src, m.id);
    approve(src, m.id, { ...PLAN, budgetS: 9000 });
    await until(() => auditFor('move-approve').some((a) => a.outcome === 'refused'), 5000, 'refused');
    await settle();
    expect(cmdRows(m.id, 'move.start')).toHaveLength(1);
    expect(cmdRows(m.id, 'move.go')).toHaveLength(1);
    expect(move(m.id).plan).toEqual(PLAN);
    expect(auditFor('move-approve').map((a) => [a.outcome, a.d.reason ?? null])).toEqual([['ok', null], ['refused', 'plan_changed']]);
    void tgt;
  });
});

describe('start and go', () => {
  it("start result's key and leaf reach the source in move.go", async () => {
    const { src, tgt, m } = await switching();
    const go = got(src.client, 'move.go', m.id)[0].body.args;
    // The plan is the one the source approved (the source refuses plan_mismatch otherwise).
    expect(go).toEqual({ v: 1, moveId: m.id, plan: PLAN, targetPublicKey: PUBLIC_KEY, expectedLeaf: LEAF });
    expect(move(m.id)).toMatchObject({ phase: 'switching', targetPublicKey: PUBLIC_KEY, leafFingerprint: LEAF });
    // Audits name fingerprints only, never the key.
    const sw = auditFor('move-phase').filter((a) => a.d.moveId === m.id && a.d.phase === 'switching');
    expect(sw).toHaveLength(1);
    expect(sw[0].d).toMatchObject({ leafFingerprint: LEAF, publicKeyFingerprint: expect.stringMatching(/^SHA256:[0-9A-F]{64}$/) });
    for (const a of (s.built.db.prepare(`SELECT detail FROM audit_log`).all() as { detail: string | null }[])) expect(a.detail ?? '').not.toContain(PUBLIC_KEY);
    void tgt;
  });

  it('a move.start that ends other than done fails the move and cancels both sides (no expectedLeaf)', async () => {
    const { src, tgt, m } = await awaiting();
    tgt.client.moveResults['move.start'] = { status: 'failed', code: 'ca_does_not_cover_camera' };
    approve(src, m.id);
    await until(() => move(m.id).phase === 'failed', 5000, 'failed');
    expect(move(m.id).reason).toBe('start:ca_does_not_cover_camera');
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    expect(got(src.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'source' });
    expect(got(tgt.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'target', copied: 'delete' });
    expect(got(src.client, 'move.go')).toHaveLength(0);
  });
});

describe('switch-over', () => {
  it('switched moves the camera in the registry with the new TLS name and sets move_id', async () => {
    const { src, tgt, cam, m } = await switched();
    const c = s.built.registry.getCamera(src.accountId, cam.id);
    expect(c).toMatchObject({ proxyId: tgt.proxyId, proxyCameraId: 'cam1', tlsServername: `cam1.${tgt.site}.internal`, camsId: 'cam1', host: '192.0.2.10' });
    expect(c.version).toBeGreaterThan(cam.version);
    expect((s.built.db.prepare('SELECT move_id FROM cameras WHERE id = ?').get(cam.id) as { move_id: string }).move_id).toBe(m.id);
    // The target copies right after switched: phase copying at once.
    expect(move(m.id).phase).toBe('copying');
    expect(got(src.client, 'move.release', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id });
    const sw = auditFor('move-switch');
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ outcome: 'ok', actor_type: 'system' });
    expect(sw[0].d).toMatchObject({ moveId: m.id, camsId: 'cam1', from: { proxyId: src.proxyId, tlsServername: null }, to: { proxyId: tgt.proxyId, tlsServername: `cam1.${tgt.site}.internal` } });
  });

  it('snapshot revision changes at switch-over', async () => {
    const { src, tgt, m } = await switching();
    const i = s.built.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [src.accountId] });
    const before = snapshotRevision(s.built.db, i.id, FP);
    phase(tgt, m.id, 'target', 'switched');
    await until(() => move(m.id).phase === 'copying', 5000, 'copying');
    expect(snapshotRevision(s.built.db, i.id, FP)).not.toBe(before);
  });

  it('repeated phase events change nothing (no write, no second release or audit)', async () => {
    const { src, tgt, m } = await switched();
    phase(src, m.id, 'source', 'released');
    await until(() => auditFor('move-phase').some((a) => a.d.moveId === m.id && a.d.phase === 'released'), 5000, 'released audit');
    await until(() => cmdRows(m.id, 'move.release').every((r) => r.state === 'done'), 5000, 'release done');
    await settle();
    const epoch = readEpoch(s.built.db);
    for (let k = 0; k < 3; k++) {
      phase(tgt, m.id, 'target', 'switched');
      phase(src, m.id, 'source', 'released');
      phase(src, m.id, 'source', 'switching');
      approve(src, m.id);
    }
    await settle();
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(cmdRows(m.id, 'move.release')).toHaveLength(1);
    expect(auditFor('move-switch')).toHaveLength(1);
    expect(auditFor('move-phase').filter((a) => a.d.moveId === m.id && a.d.phase === 'released')).toHaveLength(1);
  });

  it('a phase event from the wrong proxy or for the wrong role is ignored', async () => {
    const { src, tgt, cam, m } = await switching();
    phase(src, m.id, 'target', 'switched'); // the source claiming the target's role
    phase(tgt, m.id, 'source', 'switched');
    await settle();
    expect(move(m.id).phase).toBe('switching');
    expect(s.built.registry.getCamera(src.accountId, cam.id).proxyId).toBe(src.proxyId);
  });
});

describe('resume', () => {
  it('resumes after reconnect', async () => {
    const { src, tgt, m } = await awaiting();
    tgt.client.dropAfterReceived = 1; // move.start runs, `received` goes out, the socket drops before `done`
    approve(src, m.id);
    await until(() => got(src.client, 'move.go', m.id).length === 1, 10_000, 'move.go after the reconnect');
    const starts = got(tgt.client, 'move.start', m.id);
    expect(starts.length).toBe(2);
    expect(new Set(starts.map((x) => x.body.cmdId)).size).toBe(1); // re-sent with the same cmdId
    expect(cmdRows(m.id, 'move.start')).toHaveLength(1);
    s.built.moves.resume(m.id);
    s.built.tick();
    await settle();
    expect(cmdRows(m.id, 'move.start')).toHaveLength(1);
    expect(cmdRows(m.id, 'move.go')).toHaveLength(1);
    expect(got(src.client, 'move.go', m.id)).toHaveLength(1);
    expect(move(m.id).phase).toBe('switching');
  });

  it('resume re-sends a step whose command is missing, and only once', async () => {
    const { src, tgt, m } = await awaiting();
    tgt.client.dropCommands = 100;
    approve(src, m.id);
    await until(() => got(tgt.client, 'move.start', m.id).length === 1, 5000, 'start sent');
    // What a crash between the phase write and the command would leave: the phase without its command.
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.start'`).run();
    tgt.client.dropCommands = 0;
    s.built.moves.resume(m.id);
    s.built.moves.resume(m.id);
    await until(() => got(src.client, 'move.go', m.id).length === 1, 5000, 'move.go');
    expect(cmdRows(m.id, 'move.start')).toHaveLength(1);
  });

  it('switched with move.release missing: resume sends move.release', async () => {
    const { src, m } = await switched();
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.release'`).run();
    const before = got(src.client, 'move.release', m.id).length;
    s.built.moves.resume(m.id);
    await until(() => got(src.client, 'move.release', m.id).length === before + 1, 5000, 'release again');
    expect(cmdRows(m.id, 'move.release')).toHaveLength(1);
  });

  it('a reconnecting proxy resumes its move (the hub live hook)', async () => {
    const { src, tgt, m } = await awaiting();
    approve(src, m.id);
    await until(() => got(src.client, 'move.go', m.id).length === 1, 5000, 'move.go');
    s.built.db.prepare(`DELETE FROM commands WHERE command = 'move.go'`).run();
    src.client.dropAfterReceived = 0;
    // Drop and reconnect the source: the live hook re-derives move.go.
    (src.client as unknown as { closeSocket: () => void }).closeSocket();
    await until(() => got(src.client, 'move.go', m.id).length === 2, 10_000, 'move.go on reconnect');
    expect(cmdRows(m.id, 'move.go')).toHaveLength(1);
    void tgt;
  });
});

describe('failures before the switch-over', () => {
  it('target fails before switched → automatic cancel', async () => {
    const { src, tgt, cam, m } = await switching();
    phase(tgt, m.id, 'target', 'failed', false, 'camera_failed');
    await until(() => move(m.id).phase === 'failed', 5000, 'failed');
    expect(move(m.id).reason).toBe('target:camera_failed');
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    // move.go was sent: the camera may serve the target's leaf.
    expect(got(src.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'source', expectedLeaf: LEAF });
    expect(got(tgt.client, 'move.cancel', m.id)[0].body.args).toEqual({ v: 1, moveId: m.id, role: 'target', copied: 'delete' });
    // X15: terminal. A re-emitted failure or a later ok phase changes nothing.
    phase(tgt, m.id, 'target', 'failed', false, 'camera_failed');
    phase(tgt, m.id, 'target', 'switched');
    await settle();
    expect(move(m.id)).toMatchObject({ phase: 'failed', reason: 'target:camera_failed' });
    expect(cmdRows(m.id, 'move.cancel')).toHaveLength(2);
    expect(got(src.client, 'move.release')).toHaveLength(0);
    expect(s.built.registry.getCamera(src.accountId, cam.id).proxyId).toBe(src.proxyId);
    expect((s.built.db.prepare('SELECT move_id FROM cameras WHERE id = ?').get(cam.id) as { move_id: string | null }).move_id).toBeNull();
  });

  it('a source failure during the switch-over is terminal and cancels both', async () => {
    const { src, tgt, m } = await switching();
    phase(src, m.id, 'source', 'failed', false, 'token_address');
    await until(() => move(m.id).phase === 'failed', 5000, 'failed');
    expect(move(m.id).reason).toBe('source:token_address');
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
  });

  it('a move.go the source refuses fails the move and cancels both', async () => {
    const { src, tgt, m } = await awaiting();
    src.client.moveResults['move.go'] = { status: 'failed', code: 'plan_mismatch' };
    approve(src, m.id);
    await until(() => move(m.id).phase === 'failed', 5000, 'failed');
    expect(move(m.id).reason).toBe('go:plan_mismatch');
    await until(() => got(src.client, 'move.cancel', m.id).length === 1 && got(tgt.client, 'move.cancel', m.id).length === 1, 5000, 'cancels');
    expect(got(src.client, 'move.cancel', m.id)[0].body.args.expectedLeaf).toBe(LEAF);
  });
});

it('lists the switch-over audit actions', () => {
  for (const a of ['move-approve', 'move-switch']) expect(AUDIT_ACTIONS).toContain(a);
});
