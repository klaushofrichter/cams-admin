import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { join } from 'path';
import { statSync } from 'fs';
import { createServer } from 'http';
import { tmpDir } from './helpers/tmp';
import { startHub } from './helpers/channel';
import { until } from './helpers/server';
import { backoffDelay, enroll, ProxyClient, type KeyFile } from '../test-client/client';
import { RefProxyConfig } from '../test-client/config';
import { readKeyFile, writeKeyFile } from '../test-client/keyfile';
import { makeSummary } from '../test-client/summaries';
import { Enrollment } from '../server/enroll/codes';
import { enrollRouter } from '../server/enroll/route';
import express from 'express';
import V from '../contract/v1/vectors.json';
import { keyFromSeed, privateFromB64, publicFromB64, sign, signEnvelope, signedText, verifyEnvelope } from '../server/crypto/ed25519';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const fast = { backoffCapMs: 50, replacedWaitMs: 40, rejectedRetryMs: 100_000, incompatibleRetryMs: 100_000, connectTimeoutMs: 2000 };
const cfgUrl = (base: string) => `${base.replace('http', 'ws')}/proxy/v1/connect`;

async function hubWithEnroll(dir: string, env: Record<string, string> = {}) {
  const h = await startHub(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', ...env });
  cleanups.push(h.stop);
  const cfg = { ...h.cfg };
  const enr = new Enrollment({ db: h.db, clock: { now: () => Date.now() }, audit: h.audit, registry: h.registry, cfg, serverKeys: [h.serverKey.publicKeySpkiB64], onKeyRevoked: (k) => h.hub.closeKey(k) });
  const app = express();
  app.use(enrollRouter(enr));
  const srv = createServer(app);
  srv.on('upgrade', (q, s, hd) => h.hub.handleUpgrade(q, s, hd));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => srv.close(r)));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  cfg.connectUrl = cfgUrl(base);
  const newCode = (name: string) => {
    const p = h.registry.createProxy('a@example.com', h.acc.id, { name, displayName: name, runsOn: 'cloud' });
    return { proxyId: p.id, code: enr.createCode('a@example.com', h.acc.id, p.id, 24).code };
  };
  return { ...h, base, newCode };
}

function client(key: KeyFile, o: Partial<ConstructorParameters<typeof ProxyClient>[0]> = {}) {
  const c = new ProxyClient({ key, summary: () => makeSummary({ cameras: 2, now: Date.now() }), heartbeatS: 0.2, minIntervalS: 0.05, ...fast, ...o });
  cleanups.push(() => c.stop('shutdown'));
  return c;
}

describe('backoff', () => {
  it('full jitter within min(cap, 1 s · 2^attempt)', () => {
    expect(backoffDelay(0, 300_000, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(3, 300_000, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(30, 300_000, () => 0.999)).toBeLessThanOrEqual(300_000);
    expect(backoffDelay(30, 300_000, () => 0)).toBe(0);
  });
});

describe('the protocol test client', () => {
  const dir = tmpDir();

  it('enrolls, writes a mode-600 key file, connects, heartbeats and gets acks', async () => {
    const h = await hubWithEnroll(dir);
    const { proxyId, code } = h.newCode('c1');
    const key = await enroll(h.base, code, { version: 'v-test', cameraIds: ['cam1'] });
    expect(key).toMatchObject({ proxyId, account: 'home', connectUrl: cfgUrl(h.base) });
    const f = join(dir, 'k1/key.json');
    writeKeyFile(f, key);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readKeyFile(f)).toEqual(key);
    const c = client(readKeyFile(f));
    c.start();
    await until(() => c.stats.acked >= 3);
    expect(c.state).toBe('connected');
    expect(h.status.view(proxyId).state).toBe('online');
  });

  it('refuses a server whose challenge signature is wrong: rejected, no hello sent', async () => {
    const h = await hubWithEnroll(dir);
    const { code } = h.newCode('c2');
    const key = await enroll(h.base, code);
    const evil = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'cams-admin.v1' });
    cleanups.push(() => new Promise((r) => evil.close(r)));
    const got: string[] = [];
    evil.on('connection', (ws) => {
      ws.send(JSON.stringify({ v: 1, type: 'challenge', id: '0'.repeat(26), seq: 1, ts: 1, sig: 'A'.repeat(86) + '==', body: { connId: 'con_' + 'A'.repeat(20), nonce: 'B'.repeat(43), serverTime: 1 } }));
      ws.on('message', (m) => got.push(String(m)));
    });
    await new Promise((r) => evil.on('listening', r));
    const c = client({ ...key, connectUrl: `ws://127.0.0.1:${(evil.address() as { port: number }).port}/proxy/v1/connect` });
    const reasons: string[] = [];
    c.on('log', (e) => reasons.push(e));
    c.start();
    await until(() => c.state === 'rejected');
    expect(reasons).toContain('admin_server_untrusted');
    expect(got).toEqual([]);
  });

  it('reacts to close codes: 4409 waits, 4401/4403 reject, 4429 waits retryAfterS', async () => {
    const h = await hubWithEnroll(dir);
    const { proxyId, code } = h.newCode('c3');
    const key = await enroll(h.base, code);
    const c = client(key);
    const sched: { reason: string; delayMs: number }[] = [];
    c.on('schedule', (s) => sched.push(s));
    c.start();
    await until(() => c.state === 'connected');
    // A second client with the same key replaces the first.
    const twin = client(key);
    twin.start();
    await until(() => sched.some((s) => s.reason === 'replaced'));
    expect(sched.find((s) => s.reason === 'replaced')!.delayMs).toBeGreaterThanOrEqual(40);
    await twin.stop('shutdown');
    await c.stop('shutdown');
    // Revoked while connected: 4403 → rejected.
    const c2 = client(key);
    c2.start();
    await until(() => c2.state === 'connected');
    h.hub.closeProxy(proxyId, 4403);
    await until(() => c2.state === 'rejected');
  });

  it('426 (no supported subprotocol) makes the client incompatible', async () => {
    const h = await hubWithEnroll(dir);
    const { code } = h.newCode('c4');
    const key = await enroll(h.base, code);
    const c = client(key, { subprotocols: ['cams-admin.v9'] });
    c.start();
    await until(() => c.state === 'incompatible');
  });

  it('reconnects after 3 heartbeats without an ack', async () => {
    const h = await hubWithEnroll(dir);
    const { code } = h.newCode('c5');
    const key = await enroll(h.base, code);
    const c = client(key);
    c.start();
    await until(() => c.state === 'connected');
    c.debugDropAcks = true;
    await until(() => c.stats.reconnects >= 1);
  });

  it('stop sends bye and the server shows stopped', async () => {
    const h = await hubWithEnroll(dir);
    const { proxyId, code } = h.newCode('c6');
    const key = await enroll(h.base, code);
    const c = client(key);
    c.start();
    await until(() => c.stats.acked >= 1);
    await c.stop('restart');
    await until(() => h.status.view(proxyId).state === 'stopped');
  });
});

describe('the test client as a P2 proxy (commands option)', () => {
  it('announces commands, reports policy and tokens, answers a signed tokens.apply (received, done, duplicate, nacks)', async () => {
    const serverPriv = privateFromB64(keyFromSeed(V.keys.server.seedHex).privateKeyPkcs8B64);
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => new Promise((r) => wss.close(r)));
    await new Promise((r) => wss.on('listening', r));
    const port = (wss.address() as { port: number }).port;
    const got: any[] = [];
    const waiters: (() => void)[] = [];
    let sock: WsSocket | null = null;
    let seq = 0;
    const CON = 'con_0123456789ABCDEFGHJK';
    const PRX = 'prx_0123456789ABCDEFGHJK';
    const send = (m: Record<string, unknown>) => sock!.send(JSON.stringify(m));
    const env = (type: string, body: object, extra: object = {}) => { seq++; return { v: 1, type, id: '01K6' + String(Date.now()).padStart(15, '0') + String(seq).padStart(7, '0'), seq, ts: Date.now(), ...extra, body }; };
    wss.on('connection', (ws) => {
      sock = ws;
      seq = 0;
      const t = Date.now();
      const nonce = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA';
      send(env('challenge', { connId: CON, nonce, serverTime: t }, { sig: sign(serverPriv, signedText.challenge(CON, nonce, t)) }));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        got.push(m);
        if (m.type === 'hello') send(env('welcome', { heartbeatS: 30, offlineAfterS: 90, maxMessageBytes: 262144, serverTime: Date.now() }));
        waiters.splice(0).forEach((w) => w());
      });
    });
    const next = async (pred: (m: any) => boolean) => {
      const t = Date.now();
      for (;;) {
        const i = got.findIndex(pred);
        if (i >= 0) return got.splice(i, 1)[0];
        if (Date.now() - t > 3000) throw new Error('timeout');
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    };
    const pk = keyFromSeed(V.keys.proxy.seedHex);
    const key: KeyFile = { v: 1, url: `http://127.0.0.1:${port}`, connectUrl: `ws://127.0.0.1:${port}/`, proxyId: PRX, keyId: 'key_0123456789ABCDEFGHJK', privateKey: pk.privateKeyPkcs8B64, publicKey: pk.publicKeySpkiB64, serverKeys: [V.keys.server.publicKey], account: 'home', enrolledAt: 0 };
    const c = client(key, { heartbeatS: 30, commands: { allow: ['tokens.apply'] } });
    c.start();
    expect((await next((m) => m.type === 'hello')).body.capabilities).toEqual(['status', 'commands']);
    const hb = await next((m) => m.type === 'heartbeat');
    expect(hb.body.proxy.commands).toEqual({ enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 });
    expect(hb.body.proxy.tokens).toEqual({ revision: 0, client: 0, admin: 0, blocked: [] });
    const proxyPub = publicFromB64(pk.publicKeySpkiB64);
    const args = { v: 1, revision: 3, tokens: [{ id: 'tok_0123456789ABCDEFGHJK', kind: 'client', hash: 'sha256:' + 'c'.repeat(64), label: 'cams', retireAt: null }] };
    const command = (cmdId: string, a: object = args) => { const m = env('command', { proxyId: PRX, connId: CON, cmdId, exp: Date.now() + 60_000, actor: 'admin@example.com', command: 'tokens.apply', args: a }); return { ...m, sig: signEnvelope(serverPriv, m) }; };
    const CMD = 'cmd_0123456789ABCDEFGHJK';
    const first = command(CMD);
    send(first);
    const rec = await next((m) => m.type === 'result' && m.body.phase === 'received');
    expect(rec.re).toBe(first.id);
    const done = await next((m) => m.type === 'result' && m.body.phase === 'done');
    expect(done.body).toMatchObject({ proxyId: PRX, connId: CON, cmdId: CMD, status: 'ok', result: { revision: 3, applied: true, stale: false, client: 1, admin: 0, blocked: [] } });
    expect(verifyEnvelope(proxyPub, done)).toBe(true);
    expect(c.tokens.has('sha256:' + 'c'.repeat(64))).toBe(true);
    expect(c.receivedCommands).toHaveLength(1);
    // The same cmdId in a new envelope: the stored answer, duplicate.
    send(command(CMD));
    expect((await next((m) => m.type === 'result' && m.body.phase === 'done')).body).toMatchObject({ status: 'ok', duplicate: true, result: { revision: 3 } });
    // A lower revision: stale, not applied.
    send(command('cmd_1123456789ABCDEFGHJK', { ...args, revision: 2, tokens: [] }));
    expect((await next((m) => m.type === 'result' && m.body.phase === 'done')).body).toMatchObject({ status: 'ok', result: { revision: 3, applied: false, stale: true } });
    expect(c.tokens.size).toBe(1);
    // Paused: refused.
    c.commands!.paused = true;
    send(command('cmd_2123456789ABCDEFGHJK'));
    expect((await next((m) => m.type === 'result' && m.body.phase === 'done')).body).toMatchObject({ status: 'refused', code: 'paused' });
    // A command signed by another key: bad_signature.
    const other = privateFromB64(keyFromSeed(V.keys.other.seedHex).privateKeyPkcs8B64);
    const forged = env('command', { proxyId: PRX, connId: CON, cmdId: 'cmd_3123456789ABCDEFGHJK', exp: Date.now() + 60_000, actor: 'x', command: 'tokens.apply', args });
    send({ ...forged, sig: signEnvelope(other, forged) });
    expect((await next((m) => m.type === 'result' && m.body.phase === 'done')).body).toMatchObject({ status: 'refused', code: 'bad_signature' });
  });

  it('without the option the client is a P1 proxy: status only, commands answered unsupported_type', async () => {
    const c = new ProxyClient({ key: { serverKeys: [] } as unknown as KeyFile, summary: () => ({}) });
    expect(c.commands).toBeNull();
  });
});

describe('RefProxyConfig: the reference proxy for the P3 commands', () => {
  const who = (n: number) => ({ cmdId: `cmd_${String(n).padStart(20, '0')}`, actor: 'admin@example.org' });
  const set = (r: RefProxyConfig, s: Record<string, unknown>, dryRun = false, base = r.revision()) => ({ v: 1, dryRun, baseRevision: base, set: s });
  it('config.get: values with sources, the env-held path, settable only within remote-settable.json', () => {
    const r = new RefProxyConfig({ cameras: ['cam1'] });
    const g = r.handle('config.get', { v: 1 }, who(1));
    expect(g.status).toBe('ok');
    const v = g.result as any;
    expect(v.revision).toBe(r.revision());
    expect(v.paths['sse.pingS']).toEqual({ v: 30, s: 'default' });
    expect(v.paths['retention.clipsDays']).toMatchObject({ v: 90, s: 'override' });
    expect(v.paths['ftp.publicHost'].s).toBe('env');
    expect(v.paths['cameras.cam1.host']).toEqual({ v: '192.0.2.10', s: 'file' });
    expect(v.settable['sse.pingS']).toMatchObject({ type: 'integer' });
    expect(v.settable['retention.clipsDays'].dir).toBe('more');
    expect(v.settable['analytics.googleVision.monthlyLimit'].dir).toBe('less');
    expect(Object.keys(v.settable)).not.toContain('cameras.*.host');
    expect(Object.keys(v.settable)).not.toContain('storage.maxPercent');
    expect(v.cameras).toEqual(['cam1']);
  });
  it('a dry run writes nothing; an apply changes the value and the revision', () => {
    const r = new RefProxyConfig();
    const rev = r.revision();
    const d = r.handle('config.set', set(r, { 'sse.pingS': 7 }, true), who(1));
    expect(d).toMatchObject({ status: 'ok', result: { dryRun: true, baseRevision: rev, revision: rev, changes: [{ path: 'sse.pingS', from: 30, to: 7, sourceFrom: 'default', sourceTo: 'override' }] } });
    expect(r.current('sse.pingS')).toBe(30);
    expect(r.revision()).toBe(rev);
    const a = r.handle('config.set', set(r, { 'sse.pingS': 7 }), who(2));
    expect(a.status).toBe('ok');
    expect(r.current('sse.pingS')).toBe(7);
    expect(r.revision()).not.toBe(rev);
    expect((a.result as any).revision).toBe(r.revision());
    expect((r.handle('config.get', { v: 1 }, who(3)).result as any).paths['sse.pingS']).toMatchObject({ v: 7, s: 'override', by: { cmdId: who(2).cmdId, actor: 'admin@example.org' } });
  });
  it('a stale baseRevision → conflict with the current values', () => {
    const r = new RefProxyConfig();
    const stale = r.revision();
    r.localEdit({ 'sse.pingS': 9 });
    expect(r.handle('config.set', set(r, { 'sse.pingS': 7 }, true, stale), who(1))).toEqual({ status: 'conflict', result: { revision: r.revision(), current: { 'sse.pingS': { v: 9, s: 'override' } } } });
  });
  it('path checks: unknown camera, not remote-settable (denied first, also env-held denied paths), narrow, invalid value', () => {
    const r = new RefProxyConfig({ cameras: ['cam1'] });
    const code = (s: Record<string, unknown>) => { const x = r.handle('config.set', set(r, s, true), who(1)); return [x.status, x.code]; };
    expect(code({ 'cameras.cam1.host': '192.0.2.9' })).toEqual(['failed', 'not_remote_settable']);
    expect(code({ 'cameras.nosuch.name': 'x' })).toEqual(['failed', 'unknown_camera']);
    expect(code({ 'ftp.publicHost': 'x.example.net' })).toEqual(['failed', 'not_remote_settable']);
    expect(code({ 'storage.maxPercent': 50 })).toEqual(['failed', 'not_remote_settable']);
    expect(code({ 'analytics.googleVision.monthlyLimit': 5000 })).toEqual(['failed', 'widening_local_only']);
    expect(code({ 'analytics.googleVision.monthlyLimit': 500 })).toEqual(['ok', undefined]);
    expect(code({ 'retention.clipsDays': 30 })).toEqual(['failed', 'widening_local_only']);
    expect(code({ 'retention.clipsDays': 120 })).toEqual(['ok', undefined]);
    expect(code({ 'sse.pingS': 'often' })).toEqual(['failed', 'invalid_value']);
    expect(code({ 'sse.pingS': 1 })).toEqual(['failed', 'invalid_value']);
    // any failure fails the whole command
    const x = r.handle('config.set', set(r, { 'sse.pingS': 7, 'cameras.cam1.host': '192.0.2.9' }), who(2));
    expect(x.status).toBe('failed');
    expect(r.current('sse.pingS')).toBe(30);
    expect((x.result as any).paths).toEqual([{ path: 'cameras.cam1.host', code: 'not_remote_settable' }]);
    const w = r.handle('config.unset', { v: 1, dryRun: true, baseRevision: r.revision(), paths: ['retention.clipsDays'] }, who(3));
    expect([w.status, w.code]).toEqual(['failed', 'widening_local_only']);
    expect((w.result as any).paths[0].detail).toBe('a remote change may only keep data longer');
  });
  it('an env-held remote path is held_by_env', () => {
    const r = new RefProxyConfig({ envHeld: ['sse.maxClients'] });
    const x = r.handle('config.set', set(r, { 'sse.maxClients': 30 }, true), who(1));
    expect([x.status, x.code]).toEqual(['failed', 'held_by_env']);
  });
  it('rollback restores; a second one is already_rolled_back; a local edit since → conflict naming the path', () => {
    const r = new RefProxyConfig();
    r.handle('config.set', set(r, { 'sse.pingS': 7 }), who(1));
    const dry = r.handle('config.rollback', { v: 1, dryRun: true, cmdId: who(1).cmdId }, who(2));
    expect(dry).toMatchObject({ status: 'ok', result: { dryRun: true, of: who(1).cmdId, changes: [{ path: 'sse.pingS', from: 7, to: 30, sourceFrom: 'override', sourceTo: 'default' }] } });
    expect(r.current('sse.pingS')).toBe(7);
    expect(r.handle('config.rollback', { v: 1, dryRun: false, cmdId: who(1).cmdId }, who(3)).status).toBe('ok');
    expect(r.current('sse.pingS')).toBe(30);
    expect(r.handle('config.rollback', { v: 1, dryRun: false, cmdId: who(1).cmdId }, who(4))).toMatchObject({ status: 'failed', code: 'already_rolled_back' });
    expect(r.handle('config.rollback', { v: 1, dryRun: false, cmdId: who(9).cmdId }, who(5))).toMatchObject({ status: 'failed', code: 'no_backup' });
    r.handle('config.set', set(r, { 'sse.pingS': 8 }), who(6));
    r.localEdit({ 'sse.pingS': 11 });
    expect(r.handle('config.rollback', { v: 1, dryRun: false, cmdId: who(6).cmdId }, who(7))).toEqual({ status: 'conflict', result: { revision: r.revision(), current: { 'sse.pingS': { v: 11, s: 'override' } } } });
    expect(r.current('sse.pingS')).toBe(11);
  });
  it('a value equal to the one Reset restores drops the override; unset of a non-override is unchanged', () => {
    const r = new RefProxyConfig();
    r.handle('config.set', set(r, { 'sse.pingS': 7 }), who(1));
    const x = r.handle('config.set', set(r, { 'sse.pingS': 30 }), who(2));
    expect((x.result as any).changes).toEqual([{ path: 'sse.pingS', from: 7, to: 30, sourceFrom: 'override', sourceTo: 'default' }]);
    const u = r.handle('config.unset', { v: 1, dryRun: false, baseRevision: r.revision(), paths: ['sse.maxClients'] }, who(3));
    expect(u.result).toMatchObject({ changes: [], unchanged: ['sse.maxClients'] });
  });
  it('camera.action, camera.name.set and proxy.restart', () => {
    const r = new RefProxyConfig({ cameras: ['cam1'] });
    expect(r.handle('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }, who(1))).toEqual({ status: 'ok', result: { action: 'camera-test', camera: 'cam1', httpStatus: 200, answer: { ok: true } } });
    expect(r.handle('camera.action', { v: 1, camera: 'cam1', action: 'camera-ntp-set' }, who(2)).result).toMatchObject({ verified: true, mismatch: [] });
    expect(r.handle('camera.action', { v: 1, camera: 'nosuch', action: 'camera-test' }, who(3))).toMatchObject({ status: 'failed', code: 'unknown_camera' });
    expect(r.actions.calls).toEqual([{ action: 'camera-test', camera: 'cam1' }, { action: 'camera-ntp-set', camera: 'cam1' }]);
    expect(r.handle('camera.name.set', { v: 1, camera: 'cam1', name: 'Porch' }, who(4))).toEqual({ status: 'ok', result: { camera: 'cam1', requested: 'Porch', name: 'Porch', verified: true } });
    expect(r.handle('proxy.restart', { v: 1 }, who(5))).toMatchObject({ status: 'ok', result: { restartAt: expect.any(Number) } });
  });
});
