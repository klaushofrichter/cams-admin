// Fault injection (spec §15.4): cams-admin down and back, a 1001 mid-run, a
// blackholed link, a slow link, hostile messages, revocation, blocking,
// deleting an account under live proxies, and two proxies sharing a key.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { tcpProxy } from './helpers/tcpProxy';
import { makeSummary } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';

const dir = tmpDir();
const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const server = async (env: Record<string, string> = {}) => {
  resetAccounts();
  const s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '100000', LIMIT_HELLO_PER_PROXY: '1000', ...env });
  cleanup.push(() => s.stop());
  return s;
};
const client = (c: ProxyClient) => { cleanup.push(() => c.stop()); return c; };
const view = (s: Running, id: string) => s.built.status.view(id);

describe('fault injection', () => {
  it('cams-admin down (bye + 1001) and back on the same port: the proxy reconnects by itself', async () => {
    let s = await server();
    const p = await enrolled(s, 'down');
    const byes: unknown[] = [];
    const c = client(makeClient(p.key, { backoffCapMs: 300 }));
    c.on('bye', (b) => byes.push(b));
    c.start();
    await until(() => c.state === 'connected');
    cleanup.pop(); // the restart below owns the server now
    await s.stop();
    await until(() => c.state === 'backoff' || c.state === 'connecting');
    expect(byes).toEqual([{ reason: 'server-shutdown' }]);
    await new Promise((r) => setTimeout(r, 800)); // down for a while: retries fail
    s = await s.restart();
    cleanup.push(() => s.stop());
    await until(() => c.state === 'connected' && view(s, p.proxyId).state === 'online', 5000, 'back online');
  });

  it('a blackholed link: the client reconnects after 3 missing acks; the server reaps the socket and ages the proxy out', async () => {
    const s = await server({ PING_S: '1', OFFLINE_AFTER_S: '2' });
    const p = await enrolled(s, 'blackhole');
    const tp = await tcpProxy(s.port);
    cleanup.push(() => tp.close());
    const c = client(makeClient({ ...p.key, connectUrl: `ws://127.0.0.1:${tp.port}/proxy/v1/connect` }, {
      heartbeatS: 0.2, backoffCapMs: 200,
      // Time-scaled like the rest: an attempt started while the link is still
      // blackholed waits out this timeout (10 s by default) before retrying.
      connectTimeoutMs: 1000,
    }));
    const logs: string[] = [];
    c.on('log', (e) => logs.push(e));
    c.start();
    await until(() => view(s, p.proxyId).state === 'online');
    tp.blackhole(true);
    await until(() => logs.includes('ack_missing'), 3000, 'ack_missing');
    await until(() => !view(s, p.proxyId).connected, 5000, 'server reaped the half-open socket');
    await until(() => view(s, p.proxyId).state === 'offline', 3000, 'offline by age');
    tp.blackhole(false);
    await until(() => view(s, p.proxyId).state === 'online', 8000, 'online again');
  }, 25_000);

  it('a slow link (2 s latency, 32 KiB/s): no heartbeat is lost', async () => {
    const s = await server({ OFFLINE_AFTER_S: '30' });
    const p = await enrolled(s, 'slow');
    const tp = await tcpProxy(s.port);
    cleanup.push(() => tp.close());
    tp.slow(2000, 32 * 1024);
    const c = client(makeClient({ ...p.key, connectUrl: `ws://127.0.0.1:${tp.port}/proxy/v1/connect` }, { summary: () => makeSummary({ cameras: 4, now: Date.now(), site: true }), heartbeatS: 3, connectTimeoutMs: 20_000 }));
    c.start();
    await until(() => c.stats.acked >= 3, 20_000, '3 acks');
    expect(c.stats.reconnects).toBe(0);
    expect(c.stats.sent - c.stats.acked).toBeLessThanOrEqual(1);
    expect(view(s, p.proxyId).state).toBe('online');
  }, 30_000);

  it('hostile summaries: long text clamped, 1000 cameras unreadable, deep nesting cut, HTML kept as text', async () => {
    const s = await server();
    const p = await enrolled(s, 'hostile');
    let summary: any = makeSummary({ cameras: 1, now: Date.now() });
    const c = client(makeClient(p.key, { summary: () => summary, heartbeatS: 1000, minIntervalS: 0 }));
    c.start();
    await until(() => c.stats.acked >= 1);
    const send = async (x: any) => { summary = x; const a = c.stats.acked; c.heartbeatNow(); await until(() => c.stats.acked > a); };
    const big = makeSummary({ cameras: 1, now: Date.now() }) as any;
    big.items[0].text = 'x'.repeat(64 * 1024 - 100);
    big.camera.name = '<img src=x onerror=alert(1)>';
    let deep: any = 1;
    for (let i = 0; i < 1000; i++) deep = { d: deep };
    big.extra = deep;
    await send(big);
    const st = s.built.status.row(p.proxyId)!.summary as any;
    expect(st.items[0].text).toHaveLength(200);
    expect(st.camera.name).toBe('<img src=x onerror=alert(1)>');
    expect(JSON.stringify(st.extra).length).toBeLessThan(200);
    const many = makeSummary({ cameras: 1, now: Date.now() }) as any;
    many.cameras = Array.from({ length: 70 }, () => many.cameras[0]);
    await send(many);
    expect(view(s, p.proxyId)).toMatchObject({ state: 'online', ok: false, unreadable: expect.stringMatching(/^unreadable summary/) });
    // 1000 cameras is over the 256 KiB frame cap: 4413, and the client reconnects.
    const huge = makeSummary({ cameras: 1, now: Date.now() }) as any;
    huge.cameras = Array.from({ length: 1000 }, () => huge.cameras[0]);
    const r0 = c.stats.reconnects;
    summary = huge;
    c.heartbeatNow();
    await until(() => c.stats.reconnects > r0, 3000, '4413 reconnect');
    summary = makeSummary({ cameras: 1, now: Date.now() });
    // Garbage on the wire closes only that socket; the server carries on.
    const ws = new WebSocket(s.wsUrl, ['cams-admin.v1']);
    await new Promise((r) => ws.on('message', r));
    ws.send('{garbage');
    expect(await new Promise((r) => ws.on('close', (code) => r(code)))).toBe(4400);
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
  });

  it('a key revoked while connected, a blocked proxy, an account deleted under live proxies', async () => {
    const s = await server();
    const a = await enrolled(s, 'rev-a');
    const b = await enrolled(s, 'rev-b');
    const x = await enrolled(s, 'del-x', 'doomed');
    const y = await enrolled(s, 'del-y', 'doomed');
    const cs = [a, b, x, y].map((p) => { const c = client(makeClient(p.key)); c.start(); return c; });
    await until(() => cs.every((c) => c.state === 'connected'));
    await s.api('POST', `/accounts/${a.accountId}/proxies/${a.proxyId}/keys/${a.key.keyId}/revoke`, {});
    await until(() => cs[0].state === 'rejected', 3000, 'revoked → rejected');
    await s.api('POST', `/accounts/${b.accountId}/proxies/${b.proxyId}/block`, {});
    await until(() => cs[1].state === 'rejected', 3000, 'blocked → rejected');
    expect(view(s, b.proxyId).state).toBe('revoked');
    await s.api('DELETE', `/accounts/${x.accountId}`, { confirmName: 'doomed' });
    await until(() => cs[2].state === 'rejected' && cs[3].state === 'rejected', 3000, 'deleted → rejected');
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(s.built.db.prepare('SELECT count(*) n FROM proxy_status WHERE proxy_id IN (?, ?)').get(x.proxyId, y.proxyId)).toEqual({ n: 0 });
  });

  it('a mistyped account name on delete disconnects nobody', async () => {
    const s = await server();
    const p = await enrolled(s, 'keep', 'kept');
    const c = client(makeClient(p.key));
    c.start();
    await until(() => c.state === 'connected');
    await expect(s.api('DELETE', `/accounts/${p.accountId}`, { confirmName: 'kpt' })).rejects.toMatchObject({ status: 400 });
    await new Promise((r) => setTimeout(r, 300));
    expect(c.state).toBe('connected');
    expect(c.stats.reconnects).toBe(0);
  });

  it('two proxies with one key: the newest wins, the other waits; bounded flapping, never offline', async () => {
    const s = await server();
    const p = await enrolled(s, 'twins');
    const one = client(makeClient(p.key, { replacedWaitMs: 300, backoffCapMs: 100 }));
    const two = client(makeClient(p.key, { replacedWaitMs: 300, backoffCapMs: 100 }));
    one.start();
    await until(() => one.state === 'connected');
    two.start();
    const states = new Set<string>();
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      states.add(view(s, p.proxyId).state);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect([...states]).toEqual(['online']);
    const connects = (s.built.db.prepare(`SELECT count(*) n FROM status_events WHERE proxy_id = ? AND kind = 'connected'`).get(p.proxyId) as { n: number }).n;
    expect(connects).toBeGreaterThan(1); // they did take turns
    expect(connects).toBeLessThanOrEqual(3000 / 300 + 2); // and waited each time
    expect(s.built.db.prepare(`SELECT count(*) n FROM status_events WHERE proxy_id = ? AND kind = 'offline'`).get(p.proxyId)).toEqual({ n: 0 });
  });
});
