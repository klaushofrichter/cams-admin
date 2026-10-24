// kube-setup's S3 cost requirement (2026-10-06): heartbeats live in memory;
// the database is written only for meaningful changes and a coarse snapshot
// every 10 minutes, so Litestream uploads little. The write counter is
// meta.write_epoch (one per write transaction). The backup heartbeat adds
// at most one write per LITESTREAM_SYNC_INTERVAL_S (1 h), and only when
// nothing else was written in that interval (so Litestream uploads once an
// interval even when idle: replication freshness is read from S3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { readEpoch } from '../server/db/open';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { BackupHeartbeat } from '../server/backup/heartbeat';
import { CamsInstances } from '../server/cams/instances';
import { buildSnapshot, snapshotRevision } from '../server/cams/snapshot';
import { generateKeyPair, fingerprint, privateFromB64 } from '../server/crypto/ed25519';

describe('database write budget', () => {
  const dir = tmpDir();

  it('20 proxies × 4 cameras heartbeating for a simulated hour: ≤ 8 write transactions after the start', () => {
    const r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 });
    const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000, snapshotMs: 600_000 });
    const acc = r.reg.createAccount(ACTOR, { name: 'load', displayName: 'Load' });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = r.reg.createProxy(ACTOR, acc.id, { name: `p${i}`, displayName: `P${i}`, runsOn: 'cloud' });
      r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
      r.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, 'fp', 1, 1)`).run(`key_${i}`, p.id, `pk${i}`);
      ids.push(p.id);
    }
    // Connect everyone and send the first heartbeat (meaningful: online).
    for (const id of ids) {
      store.hello(id, 'v2026.10.06.1', r.clock.now());
      store.heartbeat(id, { summary: makeSummary({ cameras: 4, now: r.clock.now() }), proxy: makeProxyInfo({ now: r.clock.now() }), truncated: false }, r.clock.now());
    }
    store.flush(true);
    const backupHeartbeat = new BackupHeartbeat(r.db, r.clock, 3600_000);
    const start = readEpoch(r.db);
    // An hour of steady heartbeats every 30 s with ticks every 10 s: nothing meaningful changes.
    for (let t = 0; t < 3600; t += 10) {
      r.clock.advance(10_000);
      if (t % 30 === 0) for (const id of ids) store.heartbeat(id, { summary: makeSummary({ cameras: 4, now: r.clock.now() }), proxy: makeProxyInfo({ now: r.clock.now() }), truncated: false }, r.clock.now());
      store.tick();
      if (t % 300 === 0) backupHeartbeat.tick(); // its check: 12 per interval
    }
    const writes = readEpoch(r.db) - start;
    expect(writes).toBeLessThanOrEqual(9); // ~6 coarse snapshots + at most 1 backup heartbeat per hour
    expect(backupHeartbeat.writes).toBe(0); // the snapshots keep Litestream uploading anyway
    expect(writes).toBeGreaterThanOrEqual(5); // the snapshots do happen
    // The live view stayed exact meanwhile.
    expect(store.view(ids[0])).toMatchObject({ state: 'online', ok: true });
    expect(r.clock.now() - store.row(ids[0])!.lastHeartbeatAt!).toBeLessThan(30_000);
  });

  it('P2: 20 proxies whose commands.paused flips every 5 minutes for an hour stay within the same budget', () => {
    const r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 });
    const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000, snapshotMs: 600_000 });
    const acc = r.reg.createAccount(ACTOR, { name: 'p2load', displayName: 'P2' });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = r.reg.createProxy(ACTOR, acc.id, { name: `q${i}`, displayName: `Q${i}`, runsOn: 'cloud' });
      r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
      r.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, 'fp', 1, 1)`).run(`key_q${i}`, p.id, `pk${i}`);
      ids.push(p.id);
    }
    const info = (paused: boolean) => ({ ...makeProxyInfo({ now: r.clock.now() }), commands: { enabled: true, paused, pauseReason: paused ? 'local' : null, allow: ['tokens.apply'], seenWindow: 1000 }, tokens: { revision: 3, client: 1, admin: 0, blocked: [] }, configRevision: 'sha256:' + 'b'.repeat(64) });
    for (const id of ids) {
      store.hello(id, 'v2026.10.06.1', r.clock.now(), ['status', 'commands']);
      store.heartbeat(id, { summary: makeSummary({ cameras: 4, now: r.clock.now() }), proxy: info(false), truncated: false }, r.clock.now());
    }
    store.flush(true);
    const start = readEpoch(r.db);
    for (let t = 0; t < 3600; t += 10) {
      r.clock.advance(10_000);
      const paused = Math.floor(t / 300) % 2 === 1;
      if (t % 30 === 0) for (const id of ids) store.heartbeat(id, { summary: makeSummary({ cameras: 4, now: r.clock.now() }), proxy: info(paused), truncated: false }, r.clock.now());
      store.tick();
    }
    expect(readEpoch(r.db) - start).toBeLessThanOrEqual(9);
    expect(store.view(ids[0]).commands).toMatch(/^(allowed|paused)$/);
  });

  it('an idle database: exactly one backup heartbeat write per sync interval', () => {
    const r = makeRegistry(dir);
    const hb = new BackupHeartbeat(r.db, r.clock, 3600_000);
    const start = readEpoch(r.db);
    for (let t = 0; t < 3 * 3600; t += 300) {
      r.clock.advance(300_000);
      hb.tick();
    }
    expect(readEpoch(r.db) - start).toBe(3); // 3 hours: 3 writes, ≈720 a month
    expect(r.db.prepare(`SELECT last_run_at FROM jobs WHERE name='backup-heartbeat'`).get()).toEqual({ last_run_at: r.clock.now() });
  });

  it('a meaningful change is written at once (a camera goes offline)', () => {
    const r = makeRegistry(dir);
    const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 });
    const store = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000, snapshotMs: 600_000 });
    const acc = r.reg.createAccount(ACTOR, { name: 'mm', displayName: 'M' });
    const p = r.reg.createProxy(ACTOR, acc.id, { name: 'p', displayName: 'P', runsOn: 'cloud' });
    r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    store.hello(p.id, 'v2026.10.06.1', r.clock.now());
    store.heartbeat(p.id, { summary: makeSummary({ cameras: 2, now: r.clock.now() }), truncated: false }, r.clock.now());
    const before = readEpoch(r.db);
    store.heartbeat(p.id, { summary: makeSummary({ cameras: 2, now: r.clock.now() }), truncated: false }, r.clock.now());
    expect(readEpoch(r.db)).toBe(before);
    store.heartbeat(p.id, { summary: makeSummary({ cameras: 2, now: r.clock.now(), offline: ['cam2'] }), truncated: false }, r.clock.now());
    expect(readEpoch(r.db)).toBe(before + 1);
  });

  it('a restart shows the last persisted state, marked stale', () => {
    const r = makeRegistry(dir);
    const mk = () => new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live: new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 }), offlineAfterMs: 90_000, snapshotMs: 600_000 });
    const s1 = mk();
    const acc = r.reg.createAccount(ACTOR, { name: 'rs', displayName: 'RS' });
    const p = r.reg.createProxy(ACTOR, acc.id, { name: 'p', displayName: 'P', runsOn: 'cloud' });
    r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    r.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_x', ?, 'pkx', 'fp', 1, 1)`).run(p.id);
    s1.hello(p.id, 'v2026.10.06.1', r.clock.now());
    s1.heartbeat(p.id, { summary: makeSummary({ cameras: 3, now: r.clock.now() }), truncated: false }, r.clock.now());
    s1.flush(true);
    const s2 = mk();
    expect(s2.view(p.id)).toMatchObject({ state: 'online', stale: true, cameras: [{ ref: 'cam1', online: true }, { ref: 'cam2', online: true }, { ref: 'cam3', online: true }] });
  });

  it('P4: 100 snapshot pulls (200 and 304) and 10 identical reports from a cams instance → 1 write transaction (the first report is stored)', () => {
    const r = makeRegistry(dir);
    const kp = generateKeyPair();
    const fp = fingerprint(kp.publicKeySpkiB64);
    const inst = new CamsInstances({ db: r.db, clock: r.clock, audit: r.audit, registry: r.reg, cfg: { publicUrl: 'https://admin.example.org', enrollCodeDefaultH: 24 }, serverKeys: [kp.publicKeySpkiB64], serverKeyFingerprints: [fp], onRevoke: () => {} });
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    r.reg.createCamera(ACTOR, acc.id, { camsId: 'cam1', name: 'Yard', kind: 'camera' });
    const i = inst.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [acc.id] });
    const d = { db: r.db, clock: r.clock, signingKey: privateFromB64(kp.privateKeyPkcs8B64), signingFingerprint: fp };
    const start = readEpoch(r.db);
    for (let n = 0; n < 100; n++) {
      const rev = snapshotRevision(r.db, i.id, fp);
      if (n % 2 === 0) buildSnapshot(d, i.id);
      inst.touch(i.id, { lastPullAt: r.clock.now(), lastPullStatus: n % 2 === 0 ? 200 : 304 });
      if (n % 10 === 0) inst.report(i.id, { v: 1, mode: 'shadow', appliedRevision: rev, shadow: { accountId: acc.id, differences: 0, items: [] } }, r.clock.now());
      r.clock.advance(60_000);
    }
    expect(readEpoch(r.db)).toBe(start + 1);
  });
});

// Camera moves (step 4): a return that copies, one waiting for a proxy's cam-proxy update and a given-up one write
// nothing per tick over a simulated day (the commands' own expiry is not part of moves.tick).
describe('database write budget: returns', () => {
  const dir = tmpDir();
  const clients: ProxyClient[] = [];
  let s: Running;
  let clock: FakeClock;
  let n = 0;
  let ip = 200;
  const FP = 'SHA256:' + 'CD'.repeat(32);
  const fx = JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures/valid-event-move-request.json'), 'utf8')).message.body as Record<string, any>;
  beforeEach(async () => {
    resetAccounts();
    clock = fakeClock(Date.now());
    s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.stop('shutdown');
    await s.stop();
  });
  const cmds = (moveId: string, command: string) => s.built.db.prepare(`SELECT state FROM commands WHERE command = ? AND json_extract(args, '$.moveId') = ?`).all(command, moveId) as { state: string }[];
  async function proxy() {
    const name = `wb${n++}`;
    const p = await enrolled(s, name, 'home');
    const site = `site-${name}`;
    const client = makeClient(p.key, { commands: { allow: ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }) });
    clients.push(client);
    client.start();
    await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'connected');
    const cur = s.built.registry.getProxy(p.accountId, p.proxyId);
    s.built.registry.updateProxy(ACTOR, p.accountId, p.proxyId, { url: `http://192.0.2.${ip++}:8480`, tlsSite: site, tlsServername: `${name}.${site}.internal`, caFingerprints: [FP], version: cur.version });
    return { ...p, client };
  }
  // A move cancelled after the switch-over: its return id.
  async function returnMove(camsId: string, open?: Record<string, unknown>) {
    const src = await proxy();
    const tgt = await proxy();
    if (open) tgt.client.moveResults['move.return.open'] = open as any;
    const cam = s.built.registry.createCamera(ACTOR, src.accountId, { camsId, name: camsId, kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
    const { proxyId: _p, connId: _c, ...rest } = fx;
    const requestId = 'rq_' + camsId.toUpperCase().padEnd(20, '0');
    src.client.emitEvent({ ...rest, requestId, target: tgt.proxyId, camera: { ...rest.camera, proxyCameraId: 'cam1' } });
    await until(() => s.built.moves.store.byRequest(src.proxyId, requestId)?.phase === 'awaiting-approval', 5000, 'awaiting');
    const m = s.built.moves.store.byRequest(src.proxyId, requestId)!;
    src.client.emitEvent({ kind: 'move.approve', moveId: m.id, plan: { transfer: true, kinds: ['clips'], space: 'all', targetSettings: null, budgetS: 600, estimateS: 60 } });
    await until(() => s.built.moves.store.get(m.id)!.phase === 'switching', 5000, 'switching');
    tgt.client.emitEvent({ kind: 'move.phase', moveId: m.id, role: 'target', phase: 'switched', ok: true });
    await until(() => s.built.moves.store.get(m.id)!.phase === 'copying', 5000, 'copying');
    s.built.moves.cancel(ACTOR, m.id, 'age-out');
    await until(() => cmds(m.id, 'move.cancel').filter((c) => c.state === 'done').length === 2, 5000, 'cancels');
    src.client.emitEvent({ kind: 'move.phase', moveId: m.id, role: 'source', phase: 'cancelled', ok: true });
    await until(() => !!s.built.moves.store.returnFor(m.id), 5000, 'return');
    void cam;
    return s.built.moves.store.returnFor(m.id)!.id;
  }

  it('a copying, a waiting and a given-up return: a simulated day of ticks writes nothing', async () => {
    const copyingId = await returnMove('wba');
    const waitingId = await returnMove('wbb', { status: 'refused', code: 'not_allowed' });
    const givenUpId = await returnMove('wbc');
    await until(() => cmds(copyingId, 'move.return.start')[0]?.state === 'done' && cmds(givenUpId, 'move.return.start')[0]?.state === 'done', 5000, 'started');
    await until(() => s.built.moves.store.get(waitingId)!.reason === 'paused:proxy_update:source', 5000, 'waiting');
    s.built.moves.giveUp(ACTOR, givenUpId);
    await until(() => cmds(givenUpId, 'move.finish').length === 2 && cmds(givenUpId, 'move.finish').every((c) => c.state === 'done'), 5000, 'given up');
    await new Promise((r) => setTimeout(r, 250));
    const start = readEpoch(s.built.db);
    for (let t = 0; t < 86_400; t += 10) {
      clock.advance(10_000);
      s.built.moves.tick();
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(readEpoch(s.built.db) - start).toBe(0);
    expect(s.built.moves.store.get(copyingId)!.phase).toBe('returning');
    expect(cmds(waitingId, 'move.return.open')).toHaveLength(1);
  });
});
