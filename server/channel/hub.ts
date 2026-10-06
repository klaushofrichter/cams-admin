import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { KeyObject } from 'crypto';
import { WebSocketServer } from 'ws';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import type { Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { Logger } from '../log';
import { Buckets } from './limits';
import { CLOSE, Connection, type ConnectionHost } from './connection';

export const SUBPROTOCOL = 'cams-admin.v1';
export const CONNECT_PATH = '/proxy/v1/connect';

export interface HubDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  registry: Registry;
  audit: Audit;
  status: StatusStore;
  log: Logger;
  signingKey: KeyObject;
  serverKeyFingerprint: string;
  refused?: (proxyId: string | null, reason: string) => void;
}

function reject(socket: Duplex, status: number, text: string, body?: object): void {
  const payload = body ? JSON.stringify(body) : '';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\n${body ? 'Content-Type: application/json\r\n' : ''}Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  socket.destroy();
}

// The proxies' WebSocket endpoint (spec §8): one connection per proxy, the
// newest authenticated one wins.
export class Hub implements ConnectionHost {
  private wss: WebSocketServer;
  private byProxy = new Map<string, Connection>();
  private all = new Set<Connection>();
  private hellos: Buckets;
  private failures: Buckets;
  private blockedUntil = 0;
  // Recently refused proxy ids (for the dashboard after a restore, §13.5).
  readonly refusedIds = new Map<string, { at: number; reason: string }>();

  constructor(readonly deps: HubDeps) {
    // ws's own cap is set above ours, so an oversize frame gets our 4413
    // (ws would answer 1009); frames over 4× the cap are cut by ws.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: deps.cfg.limits.frameBytes * 4,
      perMessageDeflate: false,
      handleProtocols: (set) => (set.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    this.hellos = new Buckets({ capacity: deps.cfg.limits.helloPerProxyPerMin, windowMs: 60_000 });
    this.failures = new Buckets({ capacity: deps.cfg.limits.failedHandshakesPer10Min, windowMs: 10 * 60_000 });
    const userRefused = deps.refused;
    deps.refused = (proxyId, reason) => {
      if (proxyId) {
        this.refusedIds.set(proxyId.slice(0, 40), { at: deps.clock.now(), reason });
        if (this.refusedIds.size > 100) this.refusedIds.delete(this.refusedIds.keys().next().value!);
      }
      userRefused?.(proxyId, reason);
    };
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    // Browsers send Origin; Node's client doesn't. Refusing it closes off
    // cross-site WebSocket tricks outright.
    if (req.headers.origin !== undefined) return reject(socket, 403, 'Forbidden');
    const now = this.deps.clock.now();
    if (now < this.blockedUntil) return reject(socket, 429, 'Too Many Requests', { error: 'rate_limited', retryAfterS: Math.ceil((this.blockedUntil - now) / 1000) });
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (!offered.includes(SUBPROTOCOL)) return reject(socket, 426, 'Upgrade Required', { error: 'unsupported_protocol', supported: [SUBPROTOCOL] });
    let pending = 0;
    for (const c of this.all) if (c.state === 'challenged') pending++;
    if (pending >= this.deps.cfg.limits.pendingSockets) return reject(socket, 503, 'Service Unavailable', { error: 'busy' });
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const c = new Connection(ws, this);
      this.all.add(c);
    });
  }

  helloBudget(proxyId: string): boolean {
    return this.hellos.take(String(proxyId).slice(0, 40), this.deps.clock.now()).ok;
  }

  failedHandshake(): void {
    const now = this.deps.clock.now();
    if (!this.failures.take('global', now).ok) this.blockedUntil = now + 60_000;
  }

  authenticated(c: Connection): void {
    const old = this.byProxy.get(c.proxyId!);
    this.byProxy.set(c.proxyId!, c);
    if (old && old !== c) {
      old.replaced = true;
      old.close(CLOSE.replaced, 'replaced');
    }
  }

  closed(c: Connection): void {
    this.all.delete(c);
    if (c.proxyId && this.byProxy.get(c.proxyId) === c) this.byProxy.delete(c.proxyId);
  }

  connected(proxyId: string): boolean {
    return this.byProxy.has(proxyId);
  }

  closeProxy(proxyId: string, code: 4401 | 4403, reason = code === 4403 ? 'revoked' : 'unauthorized'): void {
    this.byProxy.get(proxyId)?.close(code, reason);
  }

  closeKey(keyId: string, code: 4401 | 4403 = 4401): void {
    for (const c of this.byProxy.values()) if (c.keyId === keyId) c.close(code, code === 4403 ? 'revoked' : 'unauthorized');
  }

  stats(): { open: number; pending: number; live: number } {
    let pending = 0;
    for (const c of this.all) if (c.state === 'challenged') pending++;
    return { open: this.all.size, pending, live: this.byProxy.size };
  }

  async shutdown(): Promise<void> {
    for (const c of this.all) {
      if (c.state === 'live') c.send('bye', { reason: 'server-shutdown' });
      c.close(CLOSE.going_away, 'going_away');
    }
    await new Promise((r) => setTimeout(r, 50));
    this.wss.close();
  }
}
