import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'http';
import { tmpDir } from './helpers/tmp';
import { handshake, opened, rawConnect, startHub } from './helpers/channel';
import { privateFromB64, publicFromB64, sign, signedText, verify } from '../server/crypto/ed25519';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { PENDING_KEY_MS } from '../server/registry';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function hub(dir: string, env: Record<string, string> = {}) {
  const h = await startHub(dir, env);
  stops.push(h.stop);
  return h;
}

function upgradeStatus(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/proxy/v1/connect', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('upgrade', () => resolve({ status: 101, body: '' }));
    req.end();
  });
}

const hbBody = () => ({ summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: makeProxyInfo({ now: Date.now() }), truncated: false });

describe('the proxy channel', () => {
  const dir = tmpDir();

  it('refuses no or unknown subprotocols with 426 and the supported list', async () => {
    const h = await hub(dir);
    for (const headers of [{}, { 'Sec-WebSocket-Protocol': 'cams-admin.v9' }] as Record<string, string>[]) {
      const r = await upgradeStatus(h.port, headers);
      expect(r.status).toBe(426);
      expect(JSON.parse(r.body)).toEqual({ error: 'unsupported_protocol', supported: ['cams-admin.v1'] });
    }
  });

  it('refuses browsers (an Origin header) with 403', async () => {
    const h = await hub(dir);
    expect((await upgradeStatus(h.port, { 'Sec-WebSocket-Protocol': 'cams-admin.v1', Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('picks v1 from a list, signs the challenge, welcomes a valid hello, acks heartbeats', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url, ['cams-admin.v2', 'cams-admin.v1']);
    await opened(r);
    expect(r.ws.protocol).toBe('cams-admin.v1');
    const ch = await handshake(r, p);
    expect(ch).toMatchObject({ v: 1, type: 'challenge', seq: 1 });
    expect(verify(publicFromB64(h.serverKey.publicKeySpkiB64), signedText.challenge(ch.body.connId, ch.body.nonce, ch.body.serverTime), ch.sig)).toBe(true);
    expect(ch.body.serverKeyId).toMatch(/^SHA256:/);
    const w = await r.next();
    expect(w).toMatchObject({ type: 'welcome', seq: 2, body: { heartbeatS: 30, offlineAfterS: 90, maxMessageBytes: 262144 } });
    r.send('heartbeat', hbBody());
    const ack = await r.next();
    expect(ack).toMatchObject({ type: 'ack', seq: 3, body: { nextInS: 30 } });
    expect(h.status.view(p.proxyId)).toMatchObject({ state: 'online', connected: true });
    expect(h.hub.connected(p.proxyId)).toBe(true);
    r.ws.close();
    await r.closed;
    await new Promise((res) => setTimeout(res, 50));
    expect(h.status.view(p.proxyId).connected).toBe(false);
  });

  it('closes 4408 without a hello in time', async () => {
    const h = await hub(dir, { HELLO_TIMEOUT_MS: '200' });
    const r = rawConnect(h.url);
    await r.next();
    expect((await r.closed).code).toBe(4408);
  });

  it.each([
    ['a bad signature', (b: any) => { b.ts = b.ts + 1; }],
    ['a nonce of another connection', (b: any) => { b.nonce = 'A'.repeat(43); }],
    ['another connection id', (b: any) => { b.connId = 'con_' + 'A'.repeat(20); }],
  ])('closes 4401 on %s and audits the reason', async (_n, tamper) => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p, { tamper });
    expect((await r.closed).code).toBe(4401);
    expect(h.audit.list({ action: 'proxy-auth-refused' }).items[0].detail.reason).toBeTruthy();
  });

  it('closes 4401 for a revoked key, another proxy\'s key and an unknown key', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const q = h.enrolled();
    h.db.prepare('UPDATE proxy_keys SET revoked_at = 1 WHERE id = ?').run(p.keyId);
    const r1 = rawConnect(h.url);
    await handshake(r1, p);
    expect((await r1.closed).code).toBe(4401);
    const r2 = rawConnect(h.url);
    await handshake(r2, { ...q, keyId: h.enrolled().keyId });
    expect((await r2.closed).code).toBe(4401);
    const r3 = rawConnect(h.url);
    await handshake(r3, { ...q, keyId: 'key_' + 'Z'.repeat(20) });
    expect((await r3.closed).code).toBe(4401);
    const reasons = h.audit.list({ action: 'proxy-auth-refused' }).items.map((i) => i.detail.reason);
    expect(reasons).toContain('revoked-key');
    expect(reasons).toContain('unknown-key');
  });

  it('a pending key gets in with its first hello: confirmed, the proxy enrolled', async () => {
    const h = await hub(dir);
    const p = h.addKey(h.created().id, { pending: true });
    const r = rawConnect(h.url);
    await handshake(r, p);
    expect(await r.next()).toMatchObject({ type: 'welcome' });
    expect(h.registry.getProxy(h.acc.id, p.proxyId).state).toBe('enrolled');
    expect(h.registry.activeKey(p.proxyId)?.id).toBe(p.keyId);
    expect(h.registry.listKeys(h.acc.id, p.proxyId)[0].confirmedAt).toBeGreaterThan(0);
  });

  it('re-enrolled: the new key\'s hello revokes the old key and closes its connection', async () => {
    const h = await hub(dir);
    const old = h.enrolled();
    const a = rawConnect(h.url);
    await handshake(a, old); await a.next();
    const fresh = h.addKey(old.proxyId, { pending: true });
    const b = rawConnect(h.url);
    await handshake(b, fresh);
    expect(await b.next()).toMatchObject({ type: 'welcome' });
    expect([4401, 4409]).toContain((await a.closed).code);
    expect(h.registry.listKeys(h.acc.id, old.proxyId).find((k) => k.id === old.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
    const c = rawConnect(h.url);
    await handshake(c, old);
    expect((await c.closed).code).toBe(4401);
  });

  it('an expired pending key (an orphan from a lost enroll answer) is refused', async () => {
    const h = await hub(dir);
    const p = h.addKey(h.created().id, { pending: true, createdAt: Date.now() - PENDING_KEY_MS - 1 });
    const r = rawConnect(h.url);
    await handshake(r, p);
    expect((await r.closed).code).toBe(4401);
    expect(h.audit.list({ action: 'proxy-auth-refused' }).items[0].detail.reason).toBe('expired-pending-key');
    expect(h.registry.getProxy(h.acc.id, p.proxyId).state).toBe('pending');
  });

  it('a recorded hello replayed on a new connection fails (4401)', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r1 = rawConnect(h.url);
    const ch = await handshake(r1, p);
    await r1.next(); // welcome
    const r2 = rawConnect(h.url);
    await r2.next();
    // Replay the first connection's hello verbatim.
    const ts = Date.now();
    r2.send('hello', { proxyId: p.proxyId, keyId: p.keyId, connId: ch.body.connId, nonce: ch.body.nonce, ts }, { sig: sign(privateFromB64(p.key.privateKeyPkcs8B64), signedText.hello(ch.body.connId, ch.body.nonce, p.proxyId, p.keyId, ts)) });
    expect((await r2.closed).code).toBe(4401);
  });

  it.each([
    ['seq 0', (r: any) => r.ws.send(JSON.stringify({ v: 1, type: 'bye', id: '0'.repeat(26), seq: 0, ts: 1, body: { reason: 'x' } }))],
    ['a seq gap', (r: any) => { r.seq++; r.send('heartbeat', hbBody()); }],
    ['invalid JSON', (r: any) => r.ws.send('{nope')],
    ['a binary frame', (r: any) => r.ws.send(Buffer.from([1, 2, 3]))],
    ['v 2', (r: any) => r.send('bye', { reason: 'x' }, { v: 2 })],
  ])('closes 4400 on %s', async (_n, act) => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    act(r);
    expect((await r.closed).code).toBe(4400);
  });

  it('a repeated seq closes 4400', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    r.send('heartbeat', hbBody());
    await r.next();
    r.seq--;
    r.send('heartbeat', hbBody());
    expect((await r.closed).code).toBe(4400);
  });

  it('an unknown or reserved type gets error unsupported_type and the connection stays', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    r.send('command', {});
    expect(await r.next()).toMatchObject({ type: 'error', body: { code: 'unsupported_type' } });
    r.send('frobnicate', {});
    expect(await r.next()).toMatchObject({ type: 'error', body: { code: 'unsupported_type' } });
    r.send('heartbeat', hbBody());
    expect(await r.next()).toMatchObject({ type: 'ack' });
  });

  it('a frame over 256 KiB closes 4413', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    r.send('heartbeat', { ...hbBody(), pad: 'x'.repeat(256 * 1024) });
    expect((await r.closed).code).toBe(4413);
  });

  it('too many messages: error with retryAfterS, then 4429', async () => {
    const h = await hub(dir, { LIMIT_MSG_PER_MIN: '5', HEARTBEAT_MIN_GAP_MS: '0' });
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    const msgs: any[] = [];
    for (let i = 0; i < 6; i++) r.send('heartbeat', hbBody());
    const c = await r.closed;
    expect(c.code).toBe(4429);
    let m;
    while ((m = await Promise.race([r.next(), new Promise((res) => setTimeout(() => res(null), 50))]))) msgs.push(m);
    expect(msgs.find((x) => x.type === 'error')).toMatchObject({ body: { code: 'rate_limited', retryAfterS: expect.any(Number) } });
  });

  it('heartbeats faster than the floor are dropped; the third drop in a minute closes 4429', async () => {
    const h = await hub(dir, { HEARTBEAT_MIN_GAP_MS: '10000' });
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p);
    await r.next();
    r.send('heartbeat', hbBody());
    expect(await r.next()).toMatchObject({ type: 'ack' });
    for (let i = 0; i < 3; i++) r.send('heartbeat', hbBody());
    expect((await r.closed).code).toBe(4429);
  });

  it('a second authenticated connection replaces the first (4409); a stranger does not', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const a = rawConnect(h.url);
    await handshake(a, p);
    await a.next();
    const stranger = rawConnect(h.url);
    await handshake(stranger, { ...p, key: h.enrolled().key });
    expect((await stranger.closed).code).toBe(4401);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    const b = rawConnect(h.url);
    await handshake(b, p);
    expect(await b.next()).toMatchObject({ type: 'welcome' });
    expect((await a.closed).code).toBe(4409);
    await new Promise((res) => setTimeout(res, 30));
    expect(h.status.view(p.proxyId).connected).toBe(true);
  });

  it('7 hellos for one proxy in a minute: the 7th closes 4429', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = rawConnect(h.url);
      await handshake(r, p);
      const m = await Promise.race([r.next(), r.closed.then(() => null)]);
      if (m) r.ws.close();
      codes.push((await r.closed).code);
    }
    expect(codes.slice(0, 6).every((c) => c !== 4429)).toBe(true);
    expect(codes[6]).toBe(4429);
  });

  it('pending sockets are capped (503)', async () => {
    const h = await hub(dir, { LIMIT_PENDING_SOCKETS: '3' });
    const rs = [rawConnect(h.url), rawConnect(h.url), rawConnect(h.url)];
    for (const r of rs) await r.next();
    expect(await rawConnect(h.url).unexpected).toBe(503);
    for (const r of rs) r.ws.close();
    await Promise.all(rs.map((r) => r.closed));
  });

  it('DoS: forged hellos naming a victim\'s proxy id do not use up its hello budget', async () => {
    const h = await hub(dir);
    const victim = h.enrolled();
    for (let i = 0; i < 10; i++) {
      const r = rawConnect(h.url);
      await handshake(r, { ...victim, key: h.enrolled().key }); // signed with the wrong key
      expect((await r.closed).code).toBe(4401);
    }
    const ok = rawConnect(h.url);
    await handshake(ok, victim);
    expect(await ok.next()).toMatchObject({ type: 'welcome' });
  });

  it('DoS: past the failed-handshake budget, upgrades are still accepted and a valid hello gets in; idle sockets are cut sooner', async () => {
    const h = await hub(dir, { LIMIT_FAILED_HANDSHAKES: '2', HELLO_TIMEOUT_MS: '6000' });
    const p = h.enrolled();
    for (let i = 0; i < 5; i++) {
      const r = rawConnect(h.url);
      await handshake(r, p, { tamper: (b) => { b.ts++; } });
      await r.closed;
    }
    // Under attack: an idle socket gets a short hello deadline (not 6 s).
    const idle = rawConnect(h.url);
    await idle.next();
    const t0 = Date.now();
    expect((await idle.closed).code).toBe(4408);
    expect(Date.now() - t0).toBeLessThan(3500);
    // The real proxy still connects.
    const ok = rawConnect(h.url);
    await handshake(ok, p);
    expect(await ok.next()).toMatchObject({ type: 'welcome' });
  });

  it('DoS: idle sockets timing out never block the real proxy', async () => {
    const h = await hub(dir, { LIMIT_FAILED_HANDSHAKES: '2', HELLO_TIMEOUT_MS: '150' });
    const p = h.enrolled();
    const idle = Array.from({ length: 6 }, () => rawConnect(h.url));
    await Promise.all(idle.map((r) => r.closed));
    const ok = rawConnect(h.url);
    await handshake(ok, p);
    expect(await ok.next()).toMatchObject({ type: 'welcome' });
  });

  it('closeKey closes 4401, closeProxy 4403, shutdown sends bye then 1001', async () => {
    const h = await hub(dir);
    const p = h.enrolled(), q = h.enrolled(), s = h.enrolled();
    const [a, b, c] = [rawConnect(h.url), rawConnect(h.url), rawConnect(h.url)];
    await handshake(a, p); await a.next();
    await handshake(b, q); await b.next();
    await handshake(c, s); await c.next();
    h.hub.closeKey(p.keyId, 4401);
    expect((await a.closed).code).toBe(4401);
    h.hub.closeProxy(q.proxyId, 4403);
    expect((await b.closed).code).toBe(4403);
    await h.hub.shutdown();
    expect(await c.next()).toMatchObject({ type: 'bye', body: { reason: 'server-shutdown' } });
    expect((await c.closed).code).toBe(1001);
  });

  it('bye restart marks the proxy stopped; bye unenrolled revokes its key', async () => {
    const h = await hub(dir);
    const p = h.enrolled();
    const r = rawConnect(h.url);
    await handshake(r, p); await r.next();
    r.send('heartbeat', hbBody()); await r.next();
    r.send('bye', { reason: 'restart' });
    await r.closed;
    await new Promise((res) => setTimeout(res, 30));
    expect(h.status.view(p.proxyId).state).toBe('stopped');
    const r2 = rawConnect(h.url);
    await handshake(r2, p); await r2.next();
    r2.send('bye', { reason: 'unenrolled' });
    await r2.closed;
    await new Promise((res) => setTimeout(res, 30));
    expect(h.registry.activeKey(p.proxyId)).toBeNull();
    expect(h.audit.list({ action: 'key-revoke' }).items[0]).toMatchObject({ actorType: 'proxy', detail: { reason: 'unenrolled' } });
  });

  it('limits never depend on X-Forwarded-For', async () => {
    const h = await hub(dir, { LIMIT_PENDING_SOCKETS: '2' });
    const rs = [rawConnect(h.url, undefined, { 'X-Forwarded-For': '198.51.100.1' }), rawConnect(h.url, undefined, { 'X-Forwarded-For': '198.51.100.2' })];
    for (const r of rs) await r.next();
    expect(await rawConnect(h.url, undefined, { 'X-Forwarded-For': '203.0.113.9' }).unexpected).toBe(503);
    for (const r of rs) r.ws.close();
  });
});
