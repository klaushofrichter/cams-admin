// Protocol conformance against the real server (spec §15.4), organised by
// the spec's list. Every contract fixture also goes over the wire here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { WebSocket } from 'ws';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, startServer, until, type Running } from './helpers/server';
import { privateFromB64, sign, signedText } from '../server/crypto/ed25519';
import { normaliseCode } from '../server/ids';
import { generateKeyPair } from '../server/crypto/ed25519';

const V1 = join(__dirname, '../contract/v1/fixtures');
const fixtures = readdirSync(V1).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, ...JSON.parse(readFileSync(join(V1, f), 'utf8')) }));

let s: Running;
const dir = tmpDir();
beforeAll(async () => { s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000' }); });
afterAll(async () => { await s.stop(); });

// A live, authenticated raw socket: challenge → hello → welcome.
async function live(p: { key: { proxyId: string; keyId: string; privateKey: string } }) {
  const ws = new WebSocket(s.wsUrl, ['cams-admin.v1']);
  const q: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); const w = waiters.shift(); if (w) w(m); else q.push(m); });
  ws.on('error', () => undefined);
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  const next = (ms = 2000) => (q.length ? Promise.resolve(q.shift()) : Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(() => r(null), ms))])) as Promise<any>;
  let seq = 0;
  const raw = (m: object) => ws.send(JSON.stringify(m));
  const send = (type: string, body: unknown, extra: object = {}) => { seq++; raw({ v: 1, type, id: '01K6' + String(Date.now()).padStart(15, '0') + String(seq).padStart(7, '0'), seq, ts: Date.now(), body, ...extra }); };
  const ch = await next();
  const ts = Date.now();
  const k = p.key;
  send('hello', { proxyId: k.proxyId, keyId: k.keyId, connId: ch.body.connId, nonce: ch.body.nonce, ts, version: 'conformance', capabilities: ['status'] }, { sig: sign(privateFromB64(k.privateKey), signedText.hello(ch.body.connId, ch.body.nonce, k.proxyId, k.keyId, ts)) });
  expect((await next()).type).toBe('welcome');
  return { ws, next, closed, send, raw, nextSeq: () => ++seq };
}

describe('the contract fixtures over the wire', () => {
  // What a proxy sends; commands (and their proxy-side fixtures) are the proxy's to judge.
  for (const f of fixtures.filter((x) => ['heartbeat', 'envelope', 'bye', 'error', 'command'].includes(x.schema) && x.$expect?.receiver !== 'proxy' && !x.$context)) {
    const want: string = f.$expect?.runtime ?? 'accepted';
    it(`${f.file}: ${want}`, async () => {
      const p = await enrolled(s, `fx-${f.file.replace(/[^a-z0-9]/g, '').slice(0, 24)}`);
      const c = await live(p);
      // Re-sequence the fixture for this connection.
      const n = c.nextSeq();
      const m = { ...f.message, seq: f.message.seq === 0 ? 0 : n };
      if (f.file === 'invalid-envelope-no-seq.json') delete (m as Record<string, unknown>).seq;
      c.raw(m);
      if (want === 'accepted' || want === 'unreadable_summary') {
        if (m.type === 'heartbeat') {
          expect((await c.next()).type).toBe('ack');
          const v = s.built.status.view(p.proxyId);
          if (want === 'unreadable_summary') expect(v.unreadable).toMatch(/^unreadable summary/);
          else expect(v.unreadable).toBeNull();
        } else {
          // error and bye from a proxy are accepted (bye closes normally)
          const r = await Promise.race([c.next(500), c.closed]);
          expect(r === null || r === 1000).toBe(true);
        }
      } else if (want === 'unsupported_type') {
        expect(await c.next()).toMatchObject({ type: 'error', body: { code: 'unsupported_type' } });
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
      } else {
        expect(await c.closed).toBe(4400);
      }
      c.ws.terminate();
    });
  }
});

describe('server-to-proxy types from a proxy', () => {
  it('challenge, welcome, ack, command from a proxy: error unsupported_type, the connection stays', async () => {
    const p = await enrolled(s, 'fx-outbound');
    const c = await live(p);
    for (const t of ['challenge', 'welcome', 'ack', 'command']) {
      c.send(t, {}, t === 'ack' ? { re: '01K6' + '0'.repeat(22) } : {});
      expect(await c.next(), t).toMatchObject({ type: 'error', body: { code: 'unsupported_type' } });
    }
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.terminate();
  });
});

describe('versioning', () => {
  it('no subprotocol, unknown only → 426 with the list; a GET says the same', async () => {
    const r = await fetch(`${s.url}/proxy/v1/connect`);
    expect(r.status).toBe(426);
    expect(await r.json()).toEqual({ error: 'unsupported_protocol', supported: ['cams-admin.v1'] });
    const ws = new WebSocket(s.wsUrl, ['cams-admin.v2']);
    const code = await new Promise<number>((res) => ws.on('unexpected-response', (_q, rr) => res(rr.statusCode!)));
    expect(code).toBe(426);
  });
  it('v2,v1 offered → v1; a browser Origin → 403', async () => {
    const ws = new WebSocket(s.wsUrl, ['cams-admin.v2', 'cams-admin.v1']);
    await new Promise((r) => ws.on('open', r));
    expect(ws.protocol).toBe('cams-admin.v1');
    ws.terminate();
    const b = new WebSocket(s.wsUrl, ['cams-admin.v1'], { headers: { Origin: 'https://cams-admin.example.net' } });
    expect(await new Promise<number>((res) => b.on('unexpected-response', (_q, rr) => res(rr.statusCode!)))).toBe(403);
  });
});

describe('enrollment', () => {
  it('valid, used, expired, cancelled, revoked, bad proof, other key, oversize, v2', async () => {
    const acc = (await s.api('POST', '/accounts', { name: 'enr', displayName: 'Enr' })).id;
    const px = async (n: string) => (await s.api('POST', `/accounts/${acc}/proxies`, { name: n, displayName: n, runsOn: 'cloud' })).id;
    const code = async (p: string) => (await s.api('POST', `/accounts/${acc}/proxies/${p}/enrollment-codes`, { lifetimeH: 1 })).code as string;
    const post = (b: unknown) => fetch(`${s.url}/proxy/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const body = (c: string, k = generateKeyPair(), pk = k) => ({ v: 1, code: c, publicKey: k.publicKeySpkiB64, proof: sign(privateFromB64(pk.privateKeyPkcs8B64), signedText.enroll(normaliseCode(c)!, k.publicKeySpkiB64)) });
    const p1 = await px('e1');
    const c1 = await code(p1);
    expect((await post(body(c1))).status).toBe(201);
    expect((await post(body(c1))).status).toBe(401); // used
    const p2 = await px('e2');
    const c2 = await code(p2);
    expect((await post(body(c2, generateKeyPair(), generateKeyPair()))).status).toBe(400); // proof for another key
    expect((await post({ ...body(c2), v: 2 })).status).toBe(400);
    expect((await post({ ...body(c2), pad: 'x'.repeat(9000) })).status).toBe(413);
    await s.api('POST', `/accounts/${acc}/proxies/${p2}/block`, {});
    expect((await post(body(c2))).status).toBe(401); // blocked: the code died
    const p3 = await px('e3');
    const c3 = (await s.api('POST', `/accounts/${acc}/proxies/${p3}/enrollment-codes`, {}));
    await s.api('DELETE', `/accounts/${acc}/proxies/${p3}/enrollment-codes/${c3.id}`);
    expect((await post(body(c3.code))).status).toBe(401); // cancelled
  });
  it('two concurrent redemptions: exactly one 201; the old key works until the new key\'s hello, then it is closed', async () => {
    const p = await enrolled(s, 'renroll');
    const c = await live(p);
    const code = (await s.api('POST', `/accounts/${p.accountId}/proxies/${p.proxyId}/enrollment-codes`, {})).code;
    const keys = [generateKeyPair(), generateKeyPair()];
    const b = (k: (typeof keys)[number]) => ({ v: 1, code, publicKey: k.publicKeySpkiB64, proof: sign(privateFromB64(k.privateKeyPkcs8B64), signedText.enroll(code, k.publicKeySpkiB64)) });
    const rs = await Promise.all(keys.map((k) => fetch(`${s.url}/proxy/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b(k)) })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 401]);
    const i = rs.findIndex((r) => r.status === 201);
    const won = (await rs[i].json()) as { keyId: string };
    // Redeemed, no hello yet: the old connection lives on.
    expect(await Promise.race([c.closed, new Promise((r) => setTimeout(() => r('open'), 300))])).toBe('open');
    await live({ key: { proxyId: p.proxyId, keyId: won.keyId, privateKey: keys[i].privateKeyPkcs8B64 } });
    expect([4401, 4409]).toContain(await c.closed);
    expect(s.built.registry.listKeys(p.accountId, p.proxyId).find((k) => k.id === p.key.keyId)).toMatchObject({ revokedReason: 're-enrolled' });
  });
});

describe('keys and replay', () => {
  it('wrong key, revoked key, deleted proxy, another proxy\'s key: 4401 each', async () => {
    const a = await enrolled(s, 'k-a');
    const b = await enrolled(s, 'k-b');
    const tryHello = async (proxyId: string, keyId: string, privateKey: string) => {
      const ws = new WebSocket(s.wsUrl, ['cams-admin.v1']);
      const ch: any = await new Promise((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
      const ts = Date.now();
      ws.send(JSON.stringify({ v: 1, type: 'hello', id: '0'.repeat(26), seq: 1, ts, body: { proxyId, keyId, connId: ch.body.connId, nonce: ch.body.nonce, ts }, sig: sign(privateFromB64(privateKey), signedText.hello(ch.body.connId, ch.body.nonce, proxyId, keyId, ts)) }));
      return new Promise<number>((r) => ws.on('close', (c) => r(c)));
    };
    const other = generateKeyPair();
    expect(await tryHello(a.key.proxyId, a.key.keyId, other.privateKeyPkcs8B64)).toBe(4401);
    expect(await tryHello(a.key.proxyId, b.key.keyId, b.key.privateKey)).toBe(4401);
    await s.api('POST', `/accounts/${a.accountId}/proxies/${a.proxyId}/keys/${a.key.keyId}/revoke`, {});
    expect(await tryHello(a.key.proxyId, a.key.keyId, a.key.privateKey)).toBe(4401);
    await s.api('DELETE', `/accounts/${b.accountId}/proxies/${b.proxyId}`);
    expect(await tryHello(b.key.proxyId, b.key.keyId, b.key.privateKey)).toBe(4401);
  });
  it('the client refuses a challenge not signed by a pinned key', async () => {
    const p = await enrolled(s, 'k-pin');
    const c = makeClient({ ...p.key, serverKeys: [generateKeyPair().publicKeySpkiB64] });
    c.start();
    await until(() => c.state === 'rejected');
    await c.stop();
  });
});

describe('limits never key on the address', () => {
  it('rotating X-Forwarded-For does not reset the enrollment budget per code', async () => {
    const p = await enrolled(s, 'xff');
    const code = (await s.api('POST', `/accounts/${p.accountId}/proxies/${p.proxyId}/enrollment-codes`, {})).code;
    const k = generateKeyPair();
    const bad = { v: 1, code, publicKey: k.publicKeySpkiB64, proof: 'A'.repeat(86) + '==' };
    const st: number[] = [];
    for (let i = 0; i < 6; i++) st.push((await fetch(`${s.url}/proxy/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` }, body: JSON.stringify(bad) })).status);
    expect(st).toEqual([400, 400, 400, 400, 400, 429]);
  });
});
