import { EventEmitter } from 'events';
import { generateKeyPair, privateFromB64, publicFromB64, sign, signedText, verify } from '../server/crypto/ed25519';
import { normaliseCode, ulid } from '../server/ids';
import { makeProxyInfo } from './summaries';

// An independent client of the cams-admin proxy protocol v1, written
// against contract/ (spec §8, §15.5): the engine of the integration tests,
// the e2e, the load test, the local stack bridge and the release
// WebSocket check. Node's global WebSocket, like cam-proxy will use.

export interface KeyFile {
  v: 1; url: string; connectUrl: string; proxyId: string; keyId: string; privateKey: string; publicKey: string; serverKeys: string[]; account: string; enrolledAt: number;
}

export async function enroll(url: string, code: string, proxy: { version: string; cameraIds: string[] } = { version: 'test-client', cameraIds: [] }): Promise<KeyFile> {
  const canonical = normaliseCode(code);
  if (!canonical) throw new Error('enroll: not an enrollment code');
  const k = generateKeyPair();
  const proof = sign(privateFromB64(k.privateKeyPkcs8B64), signedText.enroll(canonical, k.publicKeySpkiB64));
  const r = await fetch(`${url.replace(/\/+$/, '')}/proxy/v1/enroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ v: 1, code: canonical, publicKey: k.publicKeySpkiB64, proof, proxy }),
  });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status !== 201) throw new Error(`enroll: ${r.status} ${String(body.error ?? '')}`);
  return {
    v: 1, url, connectUrl: body.connectUrl as string, proxyId: body.proxyId as string, keyId: body.keyId as string,
    privateKey: k.privateKeyPkcs8B64, publicKey: k.publicKeySpkiB64, serverKeys: body.serverKeys as string[], account: body.account as string, enrolledAt: Date.now(),
  };
}

// Full jitter: random(0, min(cap, 1 s · 2^attempt)).
export function backoffDelay(attempt: number, capMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(capMs, 1000 * 2 ** Math.min(attempt, 30)));
}

export type ClientState = 'idle' | 'connecting' | 'connected' | 'backoff' | 'rejected' | 'incompatible' | 'stopped';

export interface ClientOptions {
  key: KeyFile;
  summary: () => unknown | Promise<unknown>;
  proxyInfo?: () => unknown;
  heartbeatS?: number; // overrides the server's welcome (tests)
  minIntervalS?: number; // the floor under ack.nextInS (10 s by spec)
  jitterS?: number; // ±2 s by spec
  backoffCapMs?: number; // 5 min
  replacedWaitMs?: number; // 30 s after 4409
  rejectedRetryMs?: number; // 15 min after 4401/4403/untrusted
  incompatibleRetryMs?: number; // 6 h after 426
  connectTimeoutMs?: number; // 10 s
  subprotocols?: string[];
  random?: () => number;
  version?: string;
}

export class ProxyClient extends EventEmitter {
  state: ClientState = 'idle';
  stats = { sent: 0, acked: 0, reconnects: 0, connects: 0, ackLatencyMs: [] as number[], errors: 0 };
  debugDropAcks = false;
  private ws: WebSocket | null = null;
  private seqOut = 0;
  private seqIn = 0;
  private attempt = 0;
  private connectedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private unacked = new Map<string, number>();
  private nextInS: number | null = null;
  private retryAfterS: number | null = null;
  private lastHeartbeatAt = 0;
  private opened = false;
  private stopping = false;
  private closeHandled = false;

  constructor(private o: ClientOptions) {
    super();
  }

  private log(event: string, detail?: object): void {
    this.emit('log', event, detail);
  }

  private setState(s: ClientState): void {
    if (this.state !== s) {
      this.state = s;
      this.emit('state', s);
    }
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  private schedule(reason: string, delayMs: number): void {
    if (this.stopping) return;
    this.emit('schedule', { reason, delayMs });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delayMs);
  }

  private connect(): void {
    if (this.stopping) return;
    this.setState('connecting');
    this.seqOut = 0;
    this.seqIn = 0;
    this.opened = false;
    this.closeHandled = false;
    this.unacked.clear();
    this.retryAfterS = null;
    this.stats.connects++;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.key.connectUrl, this.o.subprotocols ?? ['cams-admin.v1']);
    } catch (e) {
      this.log('admin_client_error', { error: (e as Error).message });
      void this.afterClose(1006);
      return;
    }
    this.ws = ws;
    const timeout = setTimeout(() => {
      if (this.state === 'connecting') {
        this.log('connect_timeout');
        ws.close();
      }
    }, this.o.connectTimeoutMs ?? 10_000);
    ws.onopen = () => (this.opened = true);
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)));
      } catch (e) {
        this.stats.errors++;
        this.log('admin_client_error', { error: (e as Error).message });
        ws.close(1000);
      }
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      clearTimeout(timeout);
      if (this.ws === ws) this.afterClose(ev.code);
    };
  }

  private send(type: string, body: unknown, extra: Record<string, unknown> = {}): string {
    const id = ulid(Date.now());
    this.seqOut++;
    this.ws?.send(JSON.stringify({ v: 1, type, id, seq: this.seqOut, ts: Date.now(), ...extra, body }));
    return id;
  }

  private onMessage(m: { v: number; type: string; seq: number; id: string; re?: string; sig?: string; body: Record<string, unknown> }): void {
    if (m.v !== 1) throw new Error(`envelope v${m.v}`);
    if (m.seq !== this.seqIn + 1) throw new Error('seq');
    this.seqIn = m.seq;
    switch (m.type) {
      case 'challenge': {
        const b = m.body as { connId: string; nonce: string; serverTime: number };
        const text = signedText.challenge(b.connId, b.nonce, b.serverTime);
        const trusted = this.o.key.serverKeys.some((k) => {
          try {
            return verify(publicFromB64(k), text, m.sig);
          } catch {
            return false;
          }
        });
        if (!trusted) {
          this.log('admin_server_untrusted');
          this.rejectNext = true;
          this.ws?.close(1000);
          return;
        }
        const ts = Date.now();
        const k = this.o.key;
        this.send('hello', { proxyId: k.proxyId, keyId: k.keyId, connId: b.connId, nonce: b.nonce, ts, version: this.o.version ?? 'test-client', capabilities: ['status'] }, {
          sig: sign(privateFromB64(k.privateKey), signedText.hello(b.connId, b.nonce, k.proxyId, k.keyId, ts)),
        });
        return;
      }
      case 'welcome':
        this.connectedAt = Date.now();
        this.setState('connected');
        this.log('admin_connected');
        this.nextInS = (m.body.heartbeatS as number) ?? 30;
        void this.heartbeat();
        return;
      case 'ack': {
        if (this.debugDropAcks) return;
        const sent = m.re ? this.unacked.get(m.re) : undefined;
        if (sent !== undefined) this.stats.ackLatencyMs.push(Date.now() - sent);
        this.unacked.clear();
        this.stats.acked++;
        this.nextInS = m.body.nextInS as number;
        this.emit('ack', m);
        return;
      }
      case 'error':
        if (typeof m.body.retryAfterS === 'number') this.retryAfterS = m.body.retryAfterS;
        this.emit('server-error', m.body);
        return;
      case 'bye':
        this.emit('bye', m.body);
        return;
      default:
        // P3 commands and anything unknown: not supported here.
        this.send('error', { code: 'unsupported_type', message: `type ${m.type} is not supported` }, { re: m.id });
    }
  }

  private rejectNext = false;

  // Sends one heartbeat and plans the next.
  private async heartbeat(): Promise<void> {
    if (this.state !== 'connected' || !this.ws) return;
    if (this.unacked.size >= 3) {
      // Three heartbeats without an ack: a half-open connection.
      this.log('ack_missing');
      this.ws.close(1000);
      return;
    }
    try {
      const summary = await this.o.summary();
      const body = { summary, proxy: this.o.proxyInfo ? this.o.proxyInfo() : makeProxyInfo({ now: Date.now() }), truncated: false };
      const id = this.send('heartbeat', body);
      this.unacked.set(id, Date.now());
      this.stats.sent++;
      this.lastHeartbeatAt = Date.now();
    } catch (e) {
      this.log('admin_client_error', { error: (e as Error).message });
    }
    const base = this.o.heartbeatS ?? Math.max(this.nextInS ?? 30, this.o.minIntervalS ?? 10);
    const jitter = (this.o.jitterS ?? (this.o.heartbeatS !== undefined ? 0 : 2)) * ((this.o.random ?? Math.random)() * 2 - 1);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => void this.heartbeat(), Math.max(0, (base + jitter) * 1000));
  }

  // An early heartbeat on a state change, at most one per minIntervalS.
  heartbeatNow(): void {
    if (this.state !== 'connected') return;
    const floor = (this.o.minIntervalS ?? 10) * 1000;
    const wait = Math.max(0, this.lastHeartbeatAt + floor - Date.now());
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => void this.heartbeat(), wait);
  }

  private async afterClose(code: number): Promise<void> {
    if (this.closeHandled) return;
    this.closeHandled = true;
    if (this.hbTimer) clearTimeout(this.hbTimer);
    const wasConnected = this.state === 'connected';
    this.ws = null;
    if (wasConnected) this.log('admin_disconnected', { code });
    if (this.stopping) return this.setState('stopped');
    this.stats.reconnects++;
    if (this.connectedAt && Date.now() - this.connectedAt >= 60_000) this.attempt = 0;
    this.connectedAt = 0;
    const cap = this.o.backoffCapMs ?? 300_000;
    const normal = () => backoffDelay(this.attempt++, cap, this.o.random);
    if (this.rejectNext || code === 4401 || code === 4403) {
      this.rejectNext = false;
      this.setState('rejected');
      this.log('admin_rejected', { code });
      return this.schedule('rejected', this.o.rejectedRetryMs ?? 15 * 60_000);
    }
    if (code === 4409) {
      this.setState('backoff');
      this.log('admin_replaced');
      return this.schedule('replaced', (this.o.replacedWaitMs ?? 30_000) + normal());
    }
    if (code === 4429) {
      this.setState('backoff');
      return this.schedule('rate_limited', (this.retryAfterS ?? 60) * 1000 + normal());
    }
    if (!this.opened && (await this.incompatible())) {
      this.setState('incompatible');
      this.log('admin_incompatible');
      return this.schedule('incompatible', this.o.incompatibleRetryMs ?? 6 * 3600_000);
    }
    this.setState('backoff');
    this.schedule('backoff', normal());
  }

  // Node's WebSocket can't show the upgrade's HTTP status: a plain GET on the
  // channel path answers 426 with the supported list.
  private async incompatible(): Promise<boolean> {
    try {
      const u = new URL(this.o.key.connectUrl);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
      if (r.status !== 426) return false;
      const b = (await r.json()) as { supported?: string[] };
      return !(this.o.subprotocols ?? ['cams-admin.v1']).some((p) => b.supported?.includes(p));
    } catch {
      return false;
    }
  }

  async stop(reason: 'shutdown' | 'restart' | 'unenrolled' = 'shutdown'): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    const ws = this.ws;
    if (!ws) return this.setState('stopped');
    if (this.state === 'connected') this.send('bye', { reason });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      ws.addEventListener('close', () => { clearTimeout(t); resolve(); });
      ws.close(1000);
    });
    this.ws = null;
    this.setState('stopped');
  }
}
