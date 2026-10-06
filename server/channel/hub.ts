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
import type { Commands } from '../commands/service';

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
  commands?: Commands;
}

function reject(socket: Duplex, status: number, text: string, body?: object): void {
  const payload = body ? JSON.stringify(body) : '';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\n${body ? 'Content-Type: application/json\r\n' : ''}Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  socket.destroy();
}

const closeReason = (code: 4401 | 4403) => (code === 4403 ? 'revoked' : 'unauthorized');

// The proxies' WebSocket endpoint (spec §8): one connection per proxy, the
// newest authenticated one wins.
export class Hub implements ConnectionHost {
  private wss: WebSocketServer;
  private byProxy = new Map<string, Connection>();
  private all = new Set<Connection>();
  private hellos: Buckets;
  private failures: Buckets;
  // Past the failed-handshake budget: upgrades are still accepted (up to the
  // pending cap) and a valid hello still gets in, but new sockets get a short
  // hello deadline. An attacker can't lock real proxies out this way.
  private attackUntil = 0;
  // Recently refused proxy ids (for the dashboard after a restore, §13.5).
  readonly refusedIds = new Map<string, { at: number; reason: string }>();
  closing = false;

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
    // Shutting down: an upgrade now would outlive the HTTP server's close().
    if (this.closing) return reject(socket, 503, 'Service Unavailable', { error: 'shutting_down' });
    // Browsers send Origin; Node's client doesn't. Refusing it closes off
    // cross-site WebSocket tricks outright.
    if (req.headers.origin !== undefined) return reject(socket, 403, 'Forbidden');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (!offered.includes(SUBPROTOCOL)) return reject(socket, 426, 'Upgrade Required', { error: 'unsupported_protocol', supported: [SUBPROTOCOL] });
    if (this.pending() >= this.deps.cfg.limits.pendingSockets) return reject(socket, 503, 'Service Unavailable', { error: 'busy' });
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const c = new Connection(ws, this);
      this.all.add(c);
    });
  }

  // Charged only after the hello's signature verified (a forged hello naming a
  // victim's id must not use up its budget).
  helloBudget(proxyId: string): boolean {
    return this.hellos.take(proxyId, this.deps.clock.now()).ok;
  }

  // Bad hellos only (signature, key, nonce); idle timeouts are bounded by the
  // pending-socket cap and don't count.
  failedHandshake(): void {
    const now = this.deps.clock.now();
    if (!this.failures.take('global', now).ok) this.attackUntil = now + 10 * 60_000;
  }

  helloTimeoutMs(): number {
    const t = this.deps.cfg.helloTimeoutMs;
    return this.deps.clock.now() < this.attackUntil ? Math.min(t, 2000) : t;
  }

  authenticated(c: Connection): void {
    const old = this.byProxy.get(c.proxyId!);
    this.byProxy.set(c.proxyId!, c);
    if (old && old !== c) {
      old.replaced = true;
      old.close(CLOSE.replaced, 'replaced');
    }
  }

  isClosing(): boolean {
    return this.closing;
  }

  closed(c: Connection): void {
    this.all.delete(c);
    if (c.proxyId && this.byProxy.get(c.proxyId) === c) this.byProxy.delete(c.proxyId);
  }

  connected(proxyId: string): boolean {
    return this.byProxy.has(proxyId);
  }

  // The proxy's live (authenticated) connection, if any.
  live(proxyId: string): Connection | null {
    const c = this.byProxy.get(proxyId);
    return c && c.state === 'live' ? c : null;
  }

  closeProxy(proxyId: string, code: 4401 | 4403): void {
    this.byProxy.get(proxyId)?.close(code, closeReason(code));
  }

  closeKey(keyId: string, code: 4401 | 4403 = 4401): void {
    for (const c of this.byProxy.values()) if (c.keyId === keyId) c.close(code, closeReason(code));
  }

  // Sockets without a completed hello.
  private pending(): number {
    let n = 0;
    for (const c of this.all) if (c.state === 'challenged') n++;
    return n;
  }

  stats(): { open: number; pending: number; live: number } {
    return { open: this.all.size, pending: this.pending(), live: this.byProxy.size };
  }

  // bye + 1001 to everyone; waits (≤ 1 s) for the sockets to close. Close
  // events after this point no longer touch the status store (its database
  // is about to close); the proxies show stale after the restart anyway.
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const c of this.all) {
      if (c.state === 'live') c.send('bye', { reason: 'server-shutdown' });
      c.close(CLOSE.going_away, 'going_away');
    }
    const t0 = Date.now();
    while (this.all.size > 0 && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 20));
    // Whatever didn't finish its close handshake is cut.
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
