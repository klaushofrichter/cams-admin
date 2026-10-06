import { createServer, type Server } from 'http';
import { join } from 'path';
import { WebSocket } from 'ws';
import { openDb } from '../../server/db/open';
import { Audit } from '../../server/audit';
import { Registry } from '../../server/registry';
import { LiveHub } from '../../server/live';
import { StatusStore } from '../../server/status/store';
import { Hub } from '../../server/channel/hub';
import { loadConfig } from '../../server/config';
import { generateKeyPair, privateFromB64, sign, signedText, fingerprint } from '../../server/crypto/ed25519';
import { systemClock } from '../../server/clock';
import { log } from '../../server/log';

let n = 0;
export async function startHub(dir: string, env: Record<string, string> = {}) {
  const db = openDb(join(dir, `h${n++}.db`));
  const clock = systemClock;
  const audit = new Audit(db, clock);
  const registry = new Registry(db, clock, audit);
  const cfg = loadConfig({ PUBLIC_URL: 'http://127.0.0.1:1', ...env });
  const live = new LiveHub({ clock, maxPerSession: 5, keepaliveMs: 0 });
  const status = new StatusStore({ db, clock, registry, live, offlineAfterMs: cfg.offlineAfterS * 1000 });
  const server = generateKeyPair();
  const hub = new Hub({ db, clock, cfg, registry, audit, status, log, signingKey: privateFromB64(server.privateKeyPkcs8B64), serverKeyFingerprint: fingerprint(server.publicKeySpkiB64) });
  const http: Server = createServer((_q, s) => s.writeHead(404).end());
  http.on('upgrade', (req, sock, head) => hub.handleUpgrade(req, sock, head));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const acc = registry.createAccount('a@example.com', { name: 'home', displayName: 'Home' });
  const enrolled = (name = `p${n++}`) => {
    const p = registry.createProxy('a@example.com', acc.id, { name, displayName: name, runsOn: 'cloud' });
    const k = generateKeyPair();
    const keyId = `key_${String(n++).padStart(20, '0')}`;
    db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    db.prepare('INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at) VALUES (?,?,?,?,?)').run(keyId, p.id, k.publicKeySpkiB64, fingerprint(k.publicKeySpkiB64), Date.now());
    return { proxyId: p.id, keyId, key: k };
  };
  return {
    db, audit, registry, status, hub, cfg, serverKey: server, port, acc, enrolled,
    url: `ws://127.0.0.1:${port}/proxy/v1/connect`,
    async stop() { await hub.shutdown(); await new Promise((r) => http.close(r)); },
  };
}

export interface Raw { ws: WebSocket; next(): Promise<Record<string, any>>; closed: Promise<{ code: number; reason: string }>; seq: number; send(type: string, body: unknown, extra?: Record<string, unknown>): void; unexpected: Promise<number> }

export function rawConnect(url: string, protocols: string[] = ['cams-admin.v1'], headers: Record<string, string> = {}): Raw {
  const ws = new WebSocket(url, protocols, { headers });
  const queue: Record<string, any>[] = [];
  const waiters: ((m: Record<string, any>) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  const unexpected = new Promise<number>((r) => ws.on('unexpected-response', (_req, res) => { r(res.statusCode ?? 0); ws.terminate(); }));
  ws.on('error', () => undefined);
  const raw: Raw = {
    ws, closed, unexpected, seq: 0,
    next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))),
    send(type, body, extra = {}) {
      raw.seq++;
      const id = '01K6' + String(Date.now()).padStart(15, '0') + String(raw.seq).padStart(7, '0');
      ws.send(JSON.stringify({ v: 1, type, id, seq: raw.seq, ts: Date.now(), body, ...extra }));
    },
  };
  return raw;
}

export async function opened(r: Raw) {
  if (r.ws.readyState !== WebSocket.OPEN) await new Promise((res) => r.ws.once('open', res));
}

// challenge → hello → welcome, returning the challenge.
export async function handshake(r: Raw, p: { proxyId: string; keyId: string; key: { privateKeyPkcs8B64: string } }, o: { ts?: number; tamper?: (b: any) => void } = {}) {
  const ch = await r.next();
  const ts = o.ts ?? Date.now();
  const body: any = { proxyId: p.proxyId, keyId: p.keyId, connId: ch.body.connId, nonce: ch.body.nonce, ts, version: 'v2026.10.06.1', capabilities: ['status'] };
  o.tamper?.(body);
  const sig = sign(privateFromB64(p.key.privateKeyPkcs8B64), signedText.hello(ch.body.connId, ch.body.nonce, p.proxyId, p.keyId, ts));
  r.send('hello', body, { sig });
  return ch;
}
