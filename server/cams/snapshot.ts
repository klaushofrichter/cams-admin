import type { KeyObject } from 'crypto';
import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { jcs } from '../crypto/jcs';
import { sha256hex, signEnvelope } from '../crypto/ed25519';
import { ApiError } from '../registry';

// The signed per-instance configuration snapshot (contract cams-v1, M §9.3,
// rulings R4-1, R4-3). Every field is mapped one by one from an explicit
// column list: a new column can never leak into a snapshot. No password,
// token, hash, enrollment code or key, ever.

export interface SnapUser { email: string; role: 'admin' | 'viewer'; disabled: boolean }
export interface SnapToken { id: string; kind: 'client' | 'admin'; state: 'pending' | 'active' | 'retiring' | 'revoked'; retireAt: number | null }
export interface SnapProxy { id: string; name: string; displayName: string; url: string | null; adminUiUrl: string | null; tlsServername: string | null; caFingerprints: string[]; tokens: SnapToken[] }
export interface SnapCamera {
  id: string; camsId: string; name: string; proxyId: string | null; proxyCameraId: string | null; host: string | null; protocol: 'https' | 'http' | null;
  tlsServername: string | null; cameraUser: string | null; webUiUrl: string | null; webUiNote: string | null;
}
export interface SnapAccount { id: string; name: string; displayName: string; revision: number; users: SnapUser[]; proxies: SnapProxy[]; cameras: SnapCamera[] }
export interface Snapshot { v: 1; type: 'cams-config'; instance: { id: string; name: string; rotateBefore: number | null }; revision: string; generatedAt: number; accounts: SnapAccount[]; sig: string }
export interface SnapshotDeps { db: Db; clock: Clock; signingKey: KeyObject; signingFingerprint: string }

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const REVOKED_KEEP_MS = 7 * 86400_000;
type Row = Record<string, unknown>;

// "r:" + 16 hex over the instance, its version, its served accounts' revisions and the signing key (R4-1).
export function snapshotRevision(db: Db, instanceId: string, keyFp: string): string {
  const inst = db.prepare('SELECT version FROM cams_instances WHERE id = ?').get(instanceId) as { version: number } | undefined;
  const a = (db.prepare(`SELECT c.account_id id, c.revision rev FROM config_revision c JOIN cams_instance_accounts s ON s.account_id = c.account_id
    WHERE s.instance_id = ? ORDER BY c.account_id`).all(instanceId) as { id: string; rev: number }[]).map((r) => [r.id, r.rev]);
  return 'r:' + sha256hex(jcs({ i: instanceId, iv: inst?.version ?? 0, a, k: keyFp })).slice(0, 16);
}

// camera id → the instance's override of host and camera user (migration 7; null = the camera's value).
export function overridesOf(db: Db, instanceId: string): Map<string, { host: string | null; cameraUser: string | null; version: number }> {
  return new Map((db.prepare('SELECT camera_id, host, camera_user, version FROM cams_camera_overrides WHERE instance_id = ?').all(instanceId) as Row[])
    .map((r) => [r.camera_id as string, { host: r.host as string | null, cameraUser: r.camera_user as string | null, version: r.version as number }]));
}

export function buildSnapshot(d: SnapshotDeps, instanceId: string): Snapshot {
  const q = (sql: string) => d.db.prepare(sql);
  const inst = q('SELECT id, name, rotate_before FROM cams_instances WHERE id = ?').get(instanceId) as Row | undefined;
  if (!inst) throw new ApiError(404, 'not_found');
  const now = d.clock.now();
  const overrides = overridesOf(d.db, instanceId);
  const accounts = (q(`SELECT a.id, a.name, a.display_name, c.revision FROM cams_instance_accounts s JOIN accounts a ON a.id = s.account_id
    JOIN config_revision c ON c.account_id = a.id WHERE s.instance_id = ? ORDER BY a.name`).all(instanceId) as Row[]).map((a): SnapAccount => {
    const accountId = a.id as string;
    const users = (q('SELECT email, role, disabled FROM account_users WHERE account_id = ? ORDER BY email').all(accountId) as Row[])
      .map((u) => ({ email: (u.email as string).toLowerCase(), role: u.role as SnapUser['role'], disabled: u.disabled === 1 }));
    // Only proxies routed to this instance (default-deny, security review I1).
    const proxies = (q(`SELECT p.id, p.name, p.display_name, COALESCE(r.url, p.url) url, p.admin_ui_url, p.tls_servername, p.ca_fingerprints FROM proxies p
      JOIN cams_instance_routes r ON r.proxy_id = p.id AND r.instance_id = ? WHERE p.account_id = ? AND r.hidden = 0 ORDER BY p.name, p.id`).all(instanceId, accountId) as Row[])
      .map((p): SnapProxy => ({
        id: p.id as string, name: p.name as string, displayName: p.display_name as string, url: p.url as string | null, adminUiUrl: p.admin_ui_url as string | null,
        tlsServername: p.tls_servername as string | null, caFingerprints: (JSON.parse(p.ca_fingerprints as string) as unknown[]).filter((x): x is string => typeof x === 'string'),
        tokens: (q(`SELECT id, kind, state, retire_at FROM proxy_tokens WHERE proxy_id = ? AND holder = ?
          AND (state IN ('pending','active','retiring') OR (state = 'revoked' AND revoked_at > ?)) ORDER BY created_at, id`).all(p.id as string, instanceId, now - REVOKED_KEEP_MS) as Row[])
          .map((t) => ({ id: t.id as string, kind: t.kind as SnapToken['kind'], state: t.state as SnapToken['state'], retireAt: t.retire_at as number | null })),
      }));
    const listed = new Set(proxies.map((p) => p.id));
    const cameras = (q(`SELECT id, cams_id, name, proxy_id, proxy_camera_id, host, protocol, tls_servername, camera_user, web_ui_url, web_ui_note FROM cameras
      WHERE account_id = ? ORDER BY cams_id`).all(accountId) as Row[])
      .filter((c) => c.proxy_id === null || listed.has(c.proxy_id as string))
      .map((c): SnapCamera => {
        // This instance's own host and camera user, where it has one (the contract's fields, unchanged).
        const o = overrides.get(c.id as string);
        return {
        id: c.id as string, camsId: c.cams_id as string, name: c.name as string, proxyId: c.proxy_id as string | null, proxyCameraId: c.proxy_camera_id as string | null,
        host: o?.host ?? (c.host as string | null), protocol: c.protocol as SnapCamera['protocol'], tlsServername: c.tls_servername as string | null, cameraUser: o?.cameraUser ?? (c.camera_user as string | null),
        webUiUrl: c.web_ui_url as string | null, webUiNote: c.web_ui_note as string | null,
        };
      });
    return { id: accountId, name: a.name as string, displayName: a.display_name as string, revision: a.revision as number, users, proxies, cameras };
  });
  const unsigned = {
    v: 1 as const, type: 'cams-config' as const, instance: { id: inst.id as string, name: inst.name as string, rotateBefore: inst.rotate_before as number | null },
    revision: snapshotRevision(d.db, instanceId, d.signingFingerprint), generatedAt: now, accounts,
  };
  return { ...unsigned, sig: signEnvelope(d.signingKey, unsigned) };
}

// The answer's bytes; over the limit it is refused, never truncated.
export function encodeSnapshot(s: Snapshot, maxBytes = MAX_SNAPSHOT_BYTES): Buffer {
  const b = Buffer.from(JSON.stringify(s), 'utf8');
  if (b.length > maxBytes) throw new ApiError(500, 'snapshot_too_large');
  return b;
}
