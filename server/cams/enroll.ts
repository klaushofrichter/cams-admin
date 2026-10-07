import type { Clock } from '../clock';
import type { Audit } from '../audit';
import type { Config } from '../config';
import { tx, type Db } from '../db/open';
import { codeHash, newId, normaliseCamsCode } from '../ids';
import { ApiError } from '../registry';
import { fingerprint, publicFromB64, signedText, verify } from '../crypto/ed25519';
import { validateCams } from '../contract';
import { Buckets } from '../channel/limits';
import type { CamsInstances } from './instances';

// POST /cams/v1/enroll (contract cams-v1, migration spec §9.1): a cams
// instance redeems its one-time CAC1 code with a fresh key. Like the proxy's
// enrollment (P1 §8.2): every failure about the code answers the same way,
// limits key on the code hash and globally (never the address), and the new
// key is pending until its first verified signed request (CamsAuth).

export interface CamsEnrollDeps {
  db: Db; clock: Clock; audit: Audit; instances: CamsInstances; cfg: Pick<Config, 'publicUrl' | 'publicOrigin' | 'connectOrigins' | 'limits'>;
  serverKeys: string[]; serverKeyFingerprints: string[];
}
export type CamsEnrollAnswer = { status: number; body: Record<string, unknown> };

const WINDOW = 15 * 60_000;
const limited = (retryAfterS: number): CamsEnrollAnswer => ({ status: 429, body: { error: 'rate_limited', retryAfterS } });

// The origin the request came in on when allow-listed (INTERNAL_URLS), else PUBLIC_URL.
export function apiUrlFor(cfg: Pick<Config, 'publicUrl' | 'publicOrigin' | 'connectOrigins'>, requestOrigin: string | null): string {
  if (!requestOrigin || requestOrigin === cfg.publicOrigin || !cfg.connectOrigins.includes(requestOrigin)) return cfg.publicUrl;
  return requestOrigin;
}

export class CamsEnrollment {
  private perCode: Buckets;
  private global: Buckets;
  constructor(private d: CamsEnrollDeps) {
    this.perCode = new Buckets({ capacity: d.cfg.limits.enrollPerCode, windowMs: WINDOW });
    this.global = new Buckets({ capacity: d.cfg.limits.enrollGlobal, windowMs: WINDOW });
  }

  private refuse(status: number, error: string, reason: string, key: string): CamsEnrollAnswer {
    this.d.audit.throttled(`cams-enroll:${key}`, { actorType: 'cams', actor: 'unknown', action: 'cams-enroll-refused', outcome: 'refused', detail: { reason } });
    return { status, body: { error } };
  }

  redeem(raw: unknown, requestOrigin: string | null = null): CamsEnrollAnswer {
    const now = this.d.clock.now();
    const g = this.global.take('global', now);
    if (!g.ok) return limited(g.retryAfterS);
    if (!validateCams('enroll-request', raw).ok) return this.refuse(400, 'bad_request', 'malformed', 'malformed');
    const b = raw as { code: string; publicKey: string; proof: string };
    const code = normaliseCamsCode(b.code);
    if (!code) return this.refuse(401, 'invalid_code', 'unknown', 'unknown');
    const hash = codeHash(code);
    const c = this.perCode.take(hash, now);
    if (!c.ok) return limited(c.retryAfterS);

    const row = this.d.db.prepare(`SELECT e.*, i.state, i.name instance_name FROM cams_enrollment_codes e JOIN cams_instances i ON i.id = e.instance_id WHERE e.code_hash = ?`)
      .get(hash) as Record<string, string | number | null> | undefined;
    if (!row) return this.refuse(401, 'invalid_code', 'unknown', 'unknown');
    const reason = row.used_at !== null ? 'used' : row.cancelled_at !== null ? 'cancelled' : (row.expires_at as number) <= now ? 'expired' : row.state === 'revoked' ? 'instance-blocked' : null;
    if (reason) return this.refuse(401, 'invalid_code', reason, row.id as string);

    let ok: boolean;
    try {
      ok = verify(publicFromB64(b.publicKey), signedText.camsEnroll(code, b.publicKey), b.proof);
    } catch {
      ok = false;
    }
    if (!ok) return this.refuse(400, 'bad_proof', 'bad_proof', row.id as string);
    // A proxy's key can never become a cams key (and no key serves two instances).
    if (this.d.db.prepare('SELECT 1 FROM proxy_keys WHERE public_key = ? UNION ALL SELECT 1 FROM cams_instance_keys WHERE public_key = ?').get(b.publicKey, b.publicKey)) {
      return this.refuse(400, 'bad_request', 'key_in_use', row.id as string);
    }

    const instanceId = row.instance_id as string;
    const fp = fingerprint(b.publicKey);
    const keyId = newId('key');
    const apiUrl = apiUrlFor(this.d.cfg, requestOrigin);
    try {
      tx(this.d.db, () => {
        const u = this.d.db.prepare('UPDATE cams_enrollment_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, row.id as string);
        if (u.changes === 0) throw new ApiError(401, 'invalid_code');
        // An earlier redemption whose key never signed a request is retired.
        const orphans = this.d.instances.revokeKeys(instanceId, 're-enrolled', now, 'pending');
        this.d.db.prepare('INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, enrollment_id) VALUES (?,?,?,?,?,?)').run(keyId, instanceId, b.publicKey, fp, now, row.id as string);
        this.d.audit.write({ actorType: 'cams', actor: instanceId, action: 'cams-enrolled', targetType: 'cams-instance', targetId: instanceId, targetLabel: row.instance_name as string, outcome: 'ok', detail: { keyId, fingerprint: fp, codeId: row.id, retiredPendingKeys: orphans, apiUrl } });
      });
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: e.code } };
      throw e;
    }
    const accounts = (this.d.db.prepare('SELECT a.name FROM cams_instance_accounts s JOIN accounts a ON a.id = s.account_id WHERE s.instance_id = ? ORDER BY a.name').all(instanceId) as { name: string }[]).map((r) => r.name);
    return {
      status: 201,
      body: { v: 1, instanceId, instanceName: row.instance_name, keyId, accounts, serverKeys: this.d.serverKeys, serverKeyFingerprints: this.d.serverKeyFingerprints, apiUrl },
    };
  }
}
