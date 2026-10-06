import { randomBytes } from 'crypto';
import type { WebSocket, RawData } from 'ws';
import type { HubDeps } from './hub';
import { newId, ulid } from '../ids';
import { publicFromB64, sign, signedText, verify } from '../crypto/ed25519';
import { validateMessage, type Envelope } from '../contract';
import { Buckets } from './limits';
import type { HeartbeatBody } from '../status/store';

// One proxy socket: challenge → hello → live (spec §8.3–§8.7).

export const CLOSE = {
  bad_message: 4400, unauthorized: 4401, revoked: 4403, timeout: 4408, replaced: 4409, too_large: 4413, rate_limited: 4429, going_away: 1001, internal_error: 1011,
} as const;

export interface ConnectionHost {
  deps: HubDeps;
  // A hello verified: the hub closes an older connection of this proxy (4409).
  authenticated(c: Connection): void;
  closed(c: Connection): void;
  failedHandshake(): void;
  helloBudget(proxyId: string): boolean;
}

export class Connection {
  readonly connId = newId('con');
  readonly nonce = randomBytes(32).toString('base64url');
  state: 'challenged' | 'live' | 'closed' = 'challenged';
  proxyId: string | null = null;
  keyId: string | null = null;
  replaced = false;
  private challengeAt: number;
  private seqOut = 0;
  private seqIn = 0;
  private helloTimer: NodeJS.Timeout;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private msgs: Buckets;
  private bytes = { start: 0, n: 0 };
  private lastHeartbeat = 0;
  private drops: number[] = [];

  constructor(private ws: WebSocket, private host: ConnectionHost) {
    const d = host.deps;
    this.challengeAt = d.clock.now();
    this.msgs = new Buckets({ capacity: d.cfg.limits.msgPerMin, windowMs: 60_000 });
    ws.on('message', (data, isBinary) => this.safe(() => this.onMessage(data, isBinary)));
    ws.on('close', (code, reason) => this.onClose(code, String(reason)));
    ws.on('error', () => undefined);
    ws.on('pong', () => (this.alive = true));
    this.helloTimer = setTimeout(() => {
      host.failedHandshake();
      this.close(CLOSE.timeout, 'timeout');
    }, d.cfg.helloTimeoutMs);
    const serverTime = this.challengeAt;
    this.send('challenge', { connId: this.connId, nonce: this.nonce, serverTime, serverKeyId: d.serverKeyFingerprint }, {
      sig: sign(d.signingKey, signedText.challenge(this.connId, this.nonce, serverTime)),
    });
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.host.deps.log.error({ err: e, proxyId: this.proxyId }, 'channel_error');
      this.close(CLOSE.internal_error, 'internal_error');
    }
  }

  send(type: string, body: unknown, extra: Record<string, unknown> = {}): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.seqOut++;
    const now = this.host.deps.clock.now();
    this.ws.send(JSON.stringify({ v: 1, type, id: ulid(now), seq: this.seqOut, ts: now, ...extra, body }));
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
    // A peer that never answers the close handshake is cut after 2 s.
    setTimeout(() => this.ws.terminate(), 2000).unref();
  }

  private rateLimited(retryAfterS: number): void {
    this.send('error', { code: 'rate_limited', message: 'too many messages', retryAfterS });
    this.close(CLOSE.rate_limited, 'rate_limited');
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    const d = this.host.deps;
    const now = d.clock.now();
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).byteLength;
    if (size > d.cfg.limits.frameBytes) return this.close(CLOSE.too_large, 'too_large');
    if (now - this.bytes.start >= 60_000) this.bytes = { start: now, n: 0 };
    this.bytes.n += size;
    if (this.bytes.n > d.cfg.limits.bytesPerMin) return this.rateLimited(Math.ceil((this.bytes.start + 60_000 - now) / 1000));
    if (isBinary) return this.close(CLOSE.bad_message, 'bad_message');
    let m: unknown;
    try {
      m = JSON.parse(String(data));
    } catch {
      return this.close(CLOSE.bad_message, 'bad_message');
    }
    // seq first: per connection and direction, from 1, exactly +1.
    const seq = (m as { seq?: unknown } | null)?.seq;
    if (seq !== this.seqIn + 1) return this.close(CLOSE.bad_message, 'bad_message');
    this.seqIn++;
    const t = this.msgs.take('m', now);
    if (!t.ok) return this.rateLimited(t.retryAfterS);
    const v = validateMessage(m);
    if (!v.ok) {
      if (v.code === 'unsupported_type' && this.state === 'live') {
        this.send('error', { code: 'unsupported_type', message: `type ${String(v.type).slice(0, 32)} is not supported` }, v.id ? { re: v.id } : {});
        return;
      }
      if (v.code === 'unsupported_type') return this.close(CLOSE.bad_message, 'bad_message');
      return this.close(CLOSE.bad_message, 'bad_message');
    }
    if (this.state === 'challenged') return v.msg.type === 'hello' ? this.onHello(v.msg) : this.close(CLOSE.bad_message, 'bad_message');
    switch (v.msg.type) {
      case 'heartbeat':
        return this.onHeartbeat(v.msg);
      case 'bye':
        return this.onBye(v.msg);
      case 'error':
        d.log.info({ proxyId: this.proxyId, code: String(v.msg.body.code).slice(0, 64) }, 'proxy_error');
        return;
      default:
        return this.close(CLOSE.bad_message, 'bad_message');
    }
  }

  private refuse(reason: string, proxyId: string | null): void {
    const d = this.host.deps;
    this.host.failedHandshake();
    d.audit.throttled(`auth:${proxyId ?? 'unknown'}`, {
      actorType: 'proxy', actor: proxyId ?? 'unknown', action: 'proxy-auth-refused', outcome: 'refused',
      targetType: proxyId ? 'proxy' : null, targetId: proxyId, detail: { reason },
    });
    this.host.deps.refused?.(proxyId, reason);
    this.close(CLOSE.unauthorized, 'unauthorized');
  }

  private onHello(m: Envelope): void {
    const d = this.host.deps;
    const b = m.body as { proxyId: string; keyId: string; connId: string; nonce: string; ts: number; version?: string };
    if (!this.host.helloBudget(b.proxyId)) {
      this.send('error', { code: 'rate_limited', message: 'too many hellos', retryAfterS: 60 });
      return this.close(CLOSE.rate_limited, 'rate_limited');
    }
    // The nonce must be this connection's, under helloTimeout old: a recorded
    // hello is useless on any other connection (the replay protection).
    if (b.connId !== this.connId || b.nonce !== this.nonce || d.clock.now() - this.challengeAt >= d.cfg.helloTimeoutMs) return this.refuse('nonce', b.proxyId);
    const key = d.db.prepare(`SELECT k.public_key, k.revoked_at, p.state FROM proxy_keys k JOIN proxies p ON p.id = k.proxy_id WHERE k.id = ? AND k.proxy_id = ?`).get(b.keyId, b.proxyId) as { public_key: string; revoked_at: number | null; state: string } | undefined;
    if (!key) return this.refuse('unknown-key', b.proxyId);
    if (key.revoked_at !== null) return this.refuse('revoked-key', b.proxyId);
    if (key.state !== 'enrolled') return this.refuse('proxy-not-enrolled', b.proxyId);
    if (!verify(publicFromB64(key.public_key), signedText.hello(this.connId, this.nonce, b.proxyId, b.keyId, b.ts), m.sig)) return this.refuse('bad-signature', b.proxyId);
    clearTimeout(this.helloTimer);
    this.proxyId = b.proxyId;
    this.keyId = b.keyId;
    this.state = 'live';
    this.host.authenticated(this);
    d.status.hello(b.proxyId, typeof b.version === 'string' ? b.version : null, b.ts);
    this.send('welcome', { heartbeatS: d.cfg.heartbeatS, offlineAfterS: d.cfg.offlineAfterS, maxMessageBytes: d.cfg.limits.frameBytes, serverTime: d.clock.now() });
    this.pingTimer = setInterval(() => {
      if (!this.alive) return this.ws.terminate();
      this.alive = false;
      this.ws.ping();
    }, d.cfg.pingS * 1000);
    this.pingTimer.unref();
  }

  private onHeartbeat(m: Envelope): void {
    const d = this.host.deps;
    const now = d.clock.now();
    if (this.lastHeartbeat && now - this.lastHeartbeat < d.cfg.limits.heartbeatMinGapMs) {
      this.drops = this.drops.filter((t) => now - t < 60_000);
      this.drops.push(now);
      if (this.drops.length >= d.cfg.limits.dropsBeforeClose) this.rateLimited(60);
      return;
    }
    this.lastHeartbeat = now;
    d.status.heartbeat(this.proxyId!, m.body as unknown as HeartbeatBody, m.ts);
    this.send('ack', { nextInS: d.cfg.heartbeatS }, { re: m.id });
  }

  private onBye(m: Envelope): void {
    const d = this.host.deps;
    const reason = String((m.body as { reason: string }).reason);
    d.status.bye(this.proxyId!, reason);
    if (reason === 'unenrolled' && this.keyId) {
      const p = d.registry.proxyById(this.proxyId!);
      if (p) {
        try {
          d.registry.revokeKey({ type: 'proxy', id: p.id }, p.accountId, p.id, this.keyId, 'unenrolled');
        } catch {
          /* already revoked */
        }
      }
    }
    this.closeReason = `bye:${reason.slice(0, 32)}`;
    this.close(1000, 'bye');
  }

  closeReason: string | null = null;

  private onClose(code: number, reason: string): void {
    this.state = 'closed';
    clearTimeout(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.host.closed(this);
    if (this.proxyId && !this.replaced) this.host.deps.status.disconnected(this.proxyId, this.closeReason ?? `${code}${reason ? ' ' + reason : ''}`);
  }
}
