import { EventEmitter } from 'events';
import { generateKeyPair, privateFromB64, publicFromB64, sign, signEnvelope, signedText, verify } from '../server/crypto/ed25519';
import { refCheck, type JournalEntry } from './commands';
import type { RefProxyConfig } from './config';
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
  clockOffsetMs?: number; // a proxy clock that is off (tests)
  // P2: answer commands (the reference check of ./commands.ts), apply
  // tokens.apply to an in-memory set, announce the commands capability.
  // Without it the client is a P1 proxy.
  // P3: config answers the P3 commands through the reference proxy
  // (test-client/config.ts) and reports its configRevision; without it a P3
  // command that passes the check is answered failed not_implemented.
  commands?: { allow: string[]; paused?: boolean; enabled?: boolean; config?: RefProxyConfig };
}

export interface ManagedToken { id: string; kind: 'client' | 'admin'; label: string; retireAt: number | null }
type DoneBody = { status: string; code?: string; result?: Record<string, unknown> };

export class ProxyClient extends EventEmitter {
  state: ClientState = 'idle';
  stats = { sent: 0, acked: 0, reconnects: 0, connects: 0, ackLatencyMs: [] as number[], errors: 0 };
  debugDropAcks = false;
  // P2 (with the commands option): what the proxy holds and saw.
  commands: { allow: string[]; paused?: boolean; enabled?: boolean; config?: RefProxyConfig } | null;
  tokens = new Map<string, ManagedToken>(); // hash → token
  tokensRevision = 0;
  receivedCommands: { id: string; ts: number; body: Record<string, any>; [k: string]: unknown }[] = [];
  refuseNext: { code: string; retryAfterS?: number } | null = null; // tests: the proxy's own refusal (e.g. its rate limit)
  dropCommands = 0; // ignore the next n commands entirely (tests: a lost command)
  dropAfterReceived = 0; // run the next n commands, send received, then cut the socket before done (tests)
  connId: string | null = null;
  debugHoldEvents = false; // never send command.done events (tests: only the re-sent cmdId can finalise)
  executed: string[] = []; // cmdIds that ran (once each, whatever was re-sent)
  overrideConfigGetResult: Record<string, unknown> | null = null; // tests: a hostile or newer proxy's view
  journalEntries: JournalEntry[] = []; // what ran, for the P3 journal budget
  private journal = new Map<string, DoneBody>();
  private undelivered: string[] = []; // cmdIds whose done never went out (sent as events after the next welcome)
  private seen = new Set<string>();
  private serverOffset = 0;
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
    this.commands = o.commands ? { paused: false, ...o.commands } : null;
    // A configRevision change makes an early heartbeat (the 10 s floor applies).
    if (o.commands?.config) o.commands.config.onChange = () => this.heartbeatNow();
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

  // Tests: no reconnect until release() (a proxy that stays away for a while).
  holdReconnect = false;
  private held: (() => void) | null = null;
  release(): void {
    this.holdReconnect = false;
    const h = this.held;
    this.held = null;
    h?.();
  }

  private schedule(reason: string, delayMs: number): void {
    if (this.stopping) return;
    if (this.holdReconnect) {
      this.held = () => this.schedule(reason, delayMs);
      return;
    }
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
      if (this.state === 'connecting' && this.ws === ws) {
        this.log('connect_timeout');
        this.closeSocket();
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
      if (this.ws === ws) void this.afterClose(ev.code);
    };
  }

  private send(type: string, body: unknown, extra: Record<string, unknown> = {}): string {
    const id = ulid(Date.now());
    this.seqOut++;
    this.ws?.send(JSON.stringify({ v: 1, type, id, seq: this.seqOut, ts: this.now(), ...extra, body }));
    return id;
  }

  private onMessage(m: { v: number; type: string; seq: number; id: string; ts: number; re?: string; sig?: string; body: Record<string, unknown> }): void {
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
          this.closeSocket();
          return;
        }
        const ts = this.now();
        const k = this.o.key;
        this.connId = b.connId;
        this.seen = new Set();
        this.serverOffset = b.serverTime - this.now();
        this.send('hello', { proxyId: k.proxyId, keyId: k.keyId, connId: b.connId, nonce: b.nonce, ts, version: this.o.version ?? 'test-client', capabilities: this.commands ? ['status', 'commands'] : ['status'] }, {
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
        // A done that never went out on its own connection: an event now.
        for (const cmdId of this.debugHoldEvents ? [] : this.undelivered.splice(0)) {
          const d = this.journal.get(cmdId);
          if (d) this.sendSigned('event', { proxyId: this.o.key.proxyId, connId: this.connId, kind: 'command.done', cmdId, phase: 'done', ...d });
        }
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
      case 'command':
        if (this.commands) return this.onCommand(m);
        break;
    }
    this.send('error', { code: 'unsupported_type', message: `type ${m.type} is not supported` }, { re: m.id });
  }

  private sendSigned(type: 'result' | 'event', body: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    this.seqOut++;
    const m: Record<string, unknown> = { v: 1, type, id: ulid(Date.now()), seq: this.seqOut, ts: this.now(), ...extra, body };
    m.sig = signEnvelope(privateFromB64(this.o.key.privateKey), m);
    this.ws?.send(JSON.stringify(m));
  }

  // The proxy side of a command (P2 contract, check order 1–12).
  private onCommand(m: { id: string; ts: number; body: Record<string, any> }): void {
    this.receivedCommands.push(m);
    if (this.dropCommands > 0) {
      this.dropCommands--;
      return;
    }
    const k = this.o.key;
    const b = m.body;
    const verdict = refCheck(m, {
      now: this.now() + this.serverOffset, proxyId: k.proxyId, connId: this.connId ?? '', serverKeys: k.serverKeys,
      allow: this.commands!.allow, paused: this.commands!.paused === true, seen: this.seen, answered: this.journal, journal: this.journalEntries,
      enabled: this.commands!.enabled !== false, tokens: [...this.tokens].map(([hash, t]) => ({ ...t, hash })),
    });
    const head = { proxyId: k.proxyId, connId: this.connId, cmdId: b.cmdId };
    const done = (d: DoneBody, extra: object = {}) => this.sendSigned('result', { ...head, phase: 'done', ...d, ...extra }, { re: m.id });
    switch (verdict.kind) {
      case 'bad_message':
        this.send('error', { code: 'bad_message', message: 'no readable cmdId' }, { re: m.id });
        return;
      case 'nack':
        return done({ status: 'refused', code: verdict.code }, verdict.retryAfterS !== undefined ? { retryAfterS: verdict.retryAfterS } : {});
      case 'duplicate':
        return done(this.journal.get(b.cmdId)!, { duplicate: true });
    }
    if (this.refuseNext) {
      const r = this.refuseNext;
      this.refuseNext = null;
      return done({ status: 'refused', code: r.code }, r.retryAfterS !== undefined ? { retryAfterS: r.retryAfterS } : {});
    }
    this.sendSigned('result', { ...head, phase: 'received' }, { re: m.id });
    this.executed.push(b.cmdId);
    this.journalEntries.push({ cmdId: b.cmdId, command: b.command, at: this.now() + this.serverOffset, ...(b.command === 'camera.action' ? { action: b.args.action } : {}) });
    const d: DoneBody = b.command === 'tokens.apply' ? this.applyTokens(b.args) : this.runP3(b);
    this.journal.set(b.cmdId, d);
    if (this.dropAfterReceived > 0) {
      this.dropAfterReceived--;
      this.undelivered.push(b.cmdId);
      this.closeSocket();
      return;
    }
    done(d);
  }

  private applyTokens(args: { revision: number; tokens: (ManagedToken & { hash: string })[] }): DoneBody {
    const stale = args.revision <= this.tokensRevision;
    if (!stale) {
      this.tokens = new Map(args.tokens.map((t) => [t.hash, { id: t.id, kind: t.kind, label: t.label, retireAt: t.retireAt }]));
      this.tokensRevision = args.revision;
    }
    return { status: 'ok', result: { revision: this.tokensRevision, applied: !stale, stale, ...this.tokenCounts() } };
  }

  private runP3(b: Record<string, any>): DoneBody {
    const cfg = this.commands?.config;
    if (!cfg) return { status: 'failed', code: 'not_implemented' };
    if (b.command === 'config.get' && this.overrideConfigGetResult) return { status: 'ok', result: this.overrideConfigGetResult };
    const r = cfg.handle(b.command, b.args, { cmdId: b.cmdId, actor: b.actor });
    return { status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.result ? { result: r.result } : {}) };
  }

  private tokenCounts(): { client: number; admin: number; blocked: string[] } {
    const now = this.now() + this.serverOffset;
    const live = [...this.tokens.values()].filter((t) => t.retireAt === null || t.retireAt > now);
    return { client: live.filter((t) => t.kind === 'client').length, admin: live.filter((t) => t.kind === 'admin').length, blocked: [] };
  }

  // Would this proxy accept the token now (a managed token, not past retireAt)?
  accepts(hash: string): boolean {
    const t = this.tokens.get(hash);
    return !!t && (t.retireAt === null || t.retireAt > this.now() + this.serverOffset);
  }

  private rejectNext = false;

  private now(): number {
    return Date.now() + (this.o.clockOffsetMs ?? 0);
  }

  // Closes, and if the peer never answers the close handshake (a dead or
  // blackholed link), treats the socket as closed after 2 s.
  private closeSocket(code = 1000): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(code);
    } catch {
      /* already closing */
    }
    setTimeout(() => {
      if (this.ws === ws) void this.afterClose(1006);
    }, 2000).unref?.();
  }

  // Gone without a bye (a crash, a pulled cable): no reconnect.
  abort(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* closing */
    }
    this.setState('stopped');
  }

  // Sends one heartbeat and plans the next.
  private async heartbeat(): Promise<void> {
    if (this.state !== 'connected' || !this.ws) return;
    if (this.unacked.size >= 3) {
      // Three heartbeats without an ack: a half-open connection.
      this.log('ack_missing');
      this.closeSocket();
      return;
    }
    try {
      const summary = await this.o.summary();
      const info = (this.o.proxyInfo ? this.o.proxyInfo() : makeProxyInfo({ now: Date.now() })) as Record<string, unknown>;
      const proxy = this.commands ? {
        ...info,
        commands: { enabled: this.commands.enabled !== false, paused: this.commands.paused === true, pauseReason: null, allow: [...this.commands.allow], seenWindow: 1000 },
        tokens: { revision: this.tokensRevision, ...this.tokenCounts() },
        ...(this.commands.config ? { configRevision: this.commands.config.revision() } : {}),
      } : info;
      const body = { summary, proxy, truncated: false };
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
