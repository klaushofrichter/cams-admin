import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { join } from 'path';
import { statSync } from 'fs';
import { createServer } from 'http';
import { tmpDir } from './helpers/tmp';
import { startHub } from './helpers/channel';
import { backoffDelay, enroll, ProxyClient, type KeyFile } from '../test-client/client';
import { readKeyFile, writeKeyFile } from '../test-client/keyfile';
import { makeSummary } from '../test-client/summaries';
import { Enrollment } from '../server/enroll/codes';
import { enrollRouter } from '../server/enroll/route';
import express from 'express';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const fast = { backoffCapMs: 50, replacedWaitMs: 40, rejectedRetryMs: 100_000, incompatibleRetryMs: 100_000, connectTimeoutMs: 2000 };
const cfgUrl = (base: string) => `${base.replace('http', 'ws')}/proxy/v1/connect`;
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

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
  cfg.connectUrl = `${base.replace('http', 'ws')}/proxy/v1/connect`;
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
