import type express from 'express';
import type { KeyObject } from 'crypto';
import type { Clock } from '../clock';
import type { Audit } from '../audit';
import type { Db } from '../db/open';
import type { Limits } from '../config';
import type { Logger } from '../log';
import { camsRequestText, camsResponseText, publicFromB64, sign, verify } from '../crypto/ed25519';
import { Buckets } from '../channel/limits';
import type { CamsInstances } from './instances';

// The request check of contract cams-v1 (normative order, steps 1–8; the
// route does step 9) and the answer signature. Limits never key on the
// client address: failed signatures are one global budget, requests one
// budget per instance. Nonces live in memory (10 min); after a restart a
// replay within the 300 s window is possible and harmless by design
// (GET config and report change nothing; POST tokens is idempotent by hash).

export interface CamsRequest { instanceId: string; keyId: string; nonce: string; body: Buffer; json: unknown }
export const NONCE_TTL_MS = 600_000, SKEW_MS = 300_000;
const MAX_NONCES = 100_000;
const ID_RE = (p: string) => new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{20}$`);
const CMS_RE = ID_RE('cms'), KEY_RE = ID_RE('key');
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

// Serialises once, signs status + request nonce + the exact bytes, sends those bytes.
export function sendSigned(res: express.Response, signingKey: KeyObject, nonce: string, status: number, body: unknown | null, headers: Record<string, string> = {}): void {
  const bytes = status === 304 || body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.status(status).set({ 'Cache-Control': 'no-store', ...headers, 'X-Cams-Admin-Sig': sign(signingKey, camsResponseText(status, nonce, bytes)) });
  if (bytes.length) res.type('application/json').end(bytes);
  else res.end();
}

export interface CamsAuthDeps { db: Db; clock: Clock; audit: Audit; instances: CamsInstances; signingKey: KeyObject; limits: Pick<Limits, 'camsPerInstancePerMin' | 'camsFailedSigPer10Min'>; log: Logger }

export class CamsAuth {
  private seen = new Map<string, number>();
  private failed: Buckets;
  private perInstance: Buckets;
  constructor(private d: CamsAuthDeps) {
    this.failed = new Buckets({ capacity: d.limits.camsFailedSigPer10Min, windowMs: 600_000 });
    this.perInstance = new Buckets({ capacity: d.limits.camsPerInstancePerMin, windowMs: 60_000 });
  }

  nonces(): number {
    return this.seen.size;
  }

  sweep(): void {
    const cut = this.d.clock.now() - NONCE_TTL_MS;
    for (const [n, at] of this.seen) {
      if (at >= cut) break; // insertion order = time order
      this.seen.delete(n);
    }
  }

  private remember(nonce: string, now: number): void {
    this.seen.set(nonce, now);
    if (this.seen.size > MAX_NONCES) {
      this.d.log.warn({ nonces: this.seen.size }, 'cams_nonce_cache_full');
      for (const n of this.seen.keys()) {
        this.seen.delete(n);
        if (this.seen.size <= MAX_NONCES) break;
      }
    }
  }

  private refused(instanceId: string, reason: string): void {
    this.d.audit.throttled(`cams-auth:${instanceId}:${reason}`, { actorType: 'cams', actor: instanceId, action: 'cams-auth-refused', targetType: 'cams-instance', targetId: instanceId, outcome: 'refused', detail: { reason } });
  }

  // The key if it may sign for this instance: not revoked, or revoked only
  // because the instance was blocked (step 7 then answers revoked, signed).
  private keyRow(instanceId: string, keyId: string): { publicKey: string; confirmedAt: number | null; revoked: boolean } | null {
    const r = this.d.db.prepare('SELECT public_key, confirmed_at, revoked_at, revoked_reason FROM cams_instance_keys WHERE id = ? AND instance_id = ?').get(keyId, instanceId) as Record<string, unknown> | undefined;
    if (!r) return null;
    if (r.revoked_at !== null && r.revoked_reason !== 'blocked') return null;
    return { publicKey: r.public_key as string, confirmedAt: r.confirmed_at as number | null, revoked: r.revoked_at !== null };
  }

  // A body-parser failure (over 64 KiB, unreadable) is a step-1 failure.
  errorHandler(): express.ErrorRequestHandler {
    return (err, req, res, next) => {
      const status = (err as { status?: number }).status;
      if (status !== 413 && status !== 400) return next(err);
      const nonce = typeof req.headers['x-cams-nonce'] === 'string' ? req.headers['x-cams-nonce'] : '';
      if (NONCE_RE.test(nonce)) return sendSigned(res, this.d.signingKey, nonce, 400, { error: 'bad_request' });
      res.status(400).set('Cache-Control', 'no-store').json({ error: 'bad_request' });
    };
  }

  middleware(): express.RequestHandler {
    return (req, res, next) => {
      const now = this.d.clock.now();
      const h = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n] as string) : '');
      const instanceId = h('x-cams-instance'), keyId = h('x-cams-key'), tsRaw = h('x-cams-ts'), nonce = h('x-cams-nonce'), sig = h('x-cams-sig');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const okNonce = NONCE_RE.test(nonce);
      const answer = (status: number, b: Record<string, unknown>) =>
        okNonce ? sendSigned(res, this.d.signingKey, nonce, status, b) : void res.status(status).set('Cache-Control', 'no-store').json(b);
      // 1. headers
      if (!CMS_RE.test(instanceId) || !KEY_RE.test(keyId) || !/^\d{1,16}$/.test(tsRaw) || !okNonce || !SIG_RE.test(sig)) return answer(400, { error: 'bad_request' });
      // 2. the global failed-signature budget
      if (this.failed.full('global', now)) return answer(429, { error: 'rate_limited', retryAfterS: 60 });
      const fail = (reason: 'unknown_key' | 'bad_signature') => {
        this.failed.take('global', now);
        this.refused(instanceId, reason);
        answer(401, { error: reason });
      };
      // 3. the key, 4. the signature
      const key = this.keyRow(instanceId, keyId);
      if (!key) return fail('unknown_key');
      let ok = false;
      try {
        ok = verify(publicFromB64(key.publicKey), camsRequestText(req.method, req.originalUrl, Number(tsRaw), nonce, body), sig);
      } catch {
        ok = false;
      }
      if (!ok) return fail('bad_signature');
      // 5. the clock
      if (Math.abs(Number(tsRaw) - now) > SKEW_MS) {
        this.refused(instanceId, 'clock_skew');
        return answer(401, { error: 'clock_skew', serverTime: now });
      }
      // 6. the nonce
      if (this.seen.has(nonce)) {
        this.refused(instanceId, 'replayed');
        return answer(401, { error: 'replayed' });
      }
      this.remember(nonce, now);
      // 7. the instance's state (a pending key's first request confirms it)
      const inst = this.d.instances.getRaw(instanceId);
      if (!inst || key.revoked || inst.state === 'revoked') {
        this.refused(instanceId, 'revoked');
        return answer(403, { error: 'revoked' });
      }
      if (key.confirmedAt === null && !this.d.instances.confirmKey(instanceId, keyId)) {
        this.refused(instanceId, 'revoked');
        return answer(403, { error: 'revoked' });
      }
      // 8. the instance's budget
      const t = this.perInstance.take(instanceId, now);
      if (!t.ok) return answer(429, { error: 'rate_limited', retryAfterS: t.retryAfterS });
      this.d.instances.touch(instanceId, { lastSeenAt: now });
      let json: unknown = null;
      if (body.length) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          return answer(400, { error: 'invalid', field: 'body' });
        }
      }
      res.locals.cams = { instanceId, keyId, nonce, body, json } satisfies CamsRequest;
      next();
    };
  }
}
