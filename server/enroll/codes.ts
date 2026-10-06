import type { Clock } from '../clock';
import type { Audit } from '../audit';
import type { Config } from '../config';
import { tx, type Db } from '../db/open';
import { ApiError, type Registry } from '../registry';
import { codeHash, newEnrollmentCode, newId, normaliseCode } from '../ids';
import { fingerprint, publicFromB64, signedText, verify } from '../crypto/ed25519';
import { validateEnroll } from '../contract';
import { Buckets } from '../channel/limits';

export interface EnrollDeps {
  db: Db;
  clock: Clock;
  audit: Audit;
  registry: Registry;
  cfg: Config;
  serverKeys: string[]; // base64 SPKI DER of cams-admin's signing key(s)
  onKeyRevoked: (keyId: string) => void; // closes that key's live connection (4401)
}

export type EnrollAnswer = { status: number; body: Record<string, unknown> };

const LIFETIMES = [1, 24, 168];
const WINDOW = 15 * 60_000;

export class Enrollment {
  private perCode: Buckets;
  private global: Buckets;
  constructor(private d: EnrollDeps) {
    this.perCode = new Buckets({ capacity: d.cfg.limits.enrollPerCode, windowMs: WINDOW });
    this.global = new Buckets({ capacity: d.cfg.limits.enrollGlobal, windowMs: WINDOW });
  }

  command(): string {
    return `docker compose exec cam-proxy node dist/src/cli.js admin-enroll --url ${this.d.cfg.publicUrl}`;
  }

  // Spec §8.2 step 1: the code is returned this once; only its hash is kept.
  createCode(actor: string, accountId: string, proxyId: string, lifetimeH: unknown): { id: string; code: string; expiresAt: number; command: string } {
    const h = lifetimeH === undefined ? this.d.cfg.enrollCodeDefaultH : lifetimeH;
    if (typeof h !== 'number' || !LIFETIMES.includes(h)) throw new ApiError(400, 'invalid', 'lifetimeH');
    return tx(this.d.db, () => {
      const p = this.d.registry.getProxy(accountId, proxyId);
      if (p.state === 'revoked') throw new ApiError(409, 'proxy_blocked');
      const now = this.d.clock.now();
      this.d.db.prepare('UPDATE enrollment_codes SET cancelled_at = ? WHERE proxy_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, proxyId);
      const code = newEnrollmentCode();
      const id = newId('enr');
      const expiresAt = now + h * 3600_000;
      this.d.db.prepare('INSERT INTO enrollment_codes (id, proxy_id, code_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(id, proxyId, codeHash(code), actor, now, expiresAt);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'enrollment-code-create', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: p.name, outcome: 'ok', detail: { codeId: id, lifetimeH: h } });
      return { id, code, expiresAt, command: this.command() };
    });
  }

  cancelCode(actor: string, accountId: string, proxyId: string, codeId: string): void {
    tx(this.d.db, () => {
      const p = this.d.registry.getProxy(accountId, proxyId);
      const r = this.d.db.prepare('UPDATE enrollment_codes SET cancelled_at = ? WHERE id = ? AND proxy_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(this.d.clock.now(), codeId, proxyId);
      if (r.changes === 0) throw new ApiError(404, 'not_found');
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'enrollment-code-cancel', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: p.name, outcome: 'ok', detail: { codeId } });
    });
  }

  liveCode(proxyId: string): { id: string; expiresAt: number; createdAt: number } | null {
    const r = this.d.db.prepare('SELECT id, expires_at, created_at FROM enrollment_codes WHERE proxy_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?').get(proxyId, this.d.clock.now()) as Record<string, number> | undefined;
    return r ? { id: r.id as unknown as string, expiresAt: r.expires_at, createdAt: r.created_at } : null;
  }

  private refuse(status: number, error: string, reason: string, key: string, extra: Record<string, unknown> = {}): EnrollAnswer {
    this.d.audit.throttled(`enroll:${key}`, { actorType: 'proxy', actor: 'unknown', action: 'enroll-refused', outcome: 'refused', detail: { reason } });
    return { status, body: { error, ...extra } };
  }

  // Spec §8.2 steps 2–4. Every failure about the code answers the same way.
  redeem(raw: unknown): EnrollAnswer {
    const now = this.d.clock.now();
    const g = this.global.take('global', now);
    if (!g.ok) return { status: 429, body: { error: 'rate_limited', retryAfterS: g.retryAfterS } };
    const v = validateEnroll(raw);
    if (!v.ok) return this.refuse(400, v.code, v.code, 'malformed');
    const b = raw as { code: string; publicKey: string; proof: string };
    const code = normaliseCode(b.code);
    if (!code) return this.refuse(401, 'invalid_code', 'unknown', 'unknown');
    const hash = codeHash(code);
    const c = this.perCode.take(hash, now);
    if (!c.ok) return { status: 429, body: { error: 'rate_limited', retryAfterS: c.retryAfterS } };

    const row = this.d.db.prepare(`SELECT e.*, p.state, p.account_id, p.name proxy_name, a.name account_name FROM enrollment_codes e
      JOIN proxies p ON p.id = e.proxy_id JOIN accounts a ON a.id = p.account_id WHERE e.code_hash = ?`).get(hash) as Record<string, string | number | null> | undefined;
    if (!row) return this.refuse(401, 'invalid_code', 'unknown', 'unknown');
    const reason = row.used_at !== null ? 'used' : row.cancelled_at !== null ? 'cancelled' : (row.expires_at as number) <= now ? 'expired' : row.state === 'revoked' ? 'proxy-blocked' : null;
    if (reason) return this.refuse(401, 'invalid_code', reason, row.id as string);

    let ok = false;
    try {
      ok = verify(publicFromB64(b.publicKey), signedText.enroll(code, b.publicKey), b.proof);
    } catch {
      ok = false;
    }
    if (!ok) return this.refuse(400, 'bad_proof', 'bad_proof', row.id as string);
    if (this.d.db.prepare('SELECT 1 FROM proxy_keys WHERE public_key = ?').get(b.publicKey)) return this.refuse(400, 'bad_request', 'key_in_use', row.id as string);

    const proxyId = row.proxy_id as string;
    const accountId = row.account_id as string;
    const fp = fingerprint(b.publicKey);
    const keyId = newId('key');
    let oldKeys: string[] = [];
    tx(this.d.db, () => {
      // Re-check inside the transaction: a parallel redemption may have won.
      const u = this.d.db.prepare('UPDATE enrollment_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, row.id as string);
      if (u.changes === 0) throw new ApiError(401, 'invalid_code');
      oldKeys = (this.d.db.prepare('SELECT id FROM proxy_keys WHERE proxy_id = ? AND revoked_at IS NULL').all(proxyId) as { id: string }[]).map((k) => k.id);
      this.d.db.prepare(`UPDATE proxy_keys SET revoked_at = ?, revoked_reason = 're-enrolled' WHERE proxy_id = ? AND revoked_at IS NULL`).run(now, proxyId);
      this.d.db.prepare('INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, enrollment_id) VALUES (?,?,?,?,?,?)').run(keyId, proxyId, b.publicKey, fp, now, row.id as string);
      this.d.db.prepare(`UPDATE proxies SET state = 'enrolled', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, proxyId);
      this.d.audit.write({ actorType: 'proxy', actor: proxyId, action: 'proxy-enrolled', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: row.proxy_name as string, outcome: 'ok', detail: { keyId, fingerprint: fp, codeId: row.id, replacedKeys: oldKeys } });
    });
    for (const k of oldKeys) this.d.onKeyRevoked(k);
    return {
      status: 201,
      body: { v: 1, proxyId, keyId, account: row.account_name, connectUrl: this.d.cfg.connectUrl, serverKeys: this.d.serverKeys, heartbeatS: this.d.cfg.heartbeatS },
    };
  }
}
