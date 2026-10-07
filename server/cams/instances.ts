import type { Clock } from '../clock';
import type { Audit, AuditAction } from '../audit';
import type { Config } from '../config';
import { tx, type Db } from '../db/open';
import { codeHash, newCamsEnrollmentCode, newId } from '../ids';
import { ApiError, type Registry } from '../registry';
import { cameraOverrideInput, checkUrl, FieldError } from '../validate';
import { validateCams } from '../contract';
import { fieldOf } from '../tokens/service';
import { overridesOf, snapshotRevision } from './snapshot';
import type { RevocationEntry } from './revocations';

// The registry of cams instances (migration spec §5, §9.1, §9.6; plan P4
// Task 3): which accounts an instance serves, its per-proxy routes (a URL
// or hidden, ruling R4-3), its one-time CAC1 enrollment codes and its keys.
// What an instance does (last request, pulls, reports) lives in memory only
// (touch/live): the database is written on meaningful changes.

type Row = Record<string, unknown>;

export interface CamsInstance { id: string; name: string; displayName: string; baseUrl: string | null; notes: string | null; state: 'pending' | 'enrolled' | 'revoked'; rotateBefore: number | null; accounts: string[]; createdAt: number; updatedAt: number; version: number }
export interface CamsRoute { instanceId: string; proxyId: string; accountId: string; url: string | null; hidden: boolean }
export interface CamsKey { id: string; instanceId: string; fingerprint: string; createdAt: number; confirmedAt: number | null; lastSeenAt: number | null; revokedAt: number | null; revokedReason: string | null }
// A per-instance camera override (migration 7), with the camera's shared values beside it.
export interface CameraOverride {
  instanceId: string; cameraId: string; accountId: string; accountName: string; camsId: string; name: string;
  host: string | null; cameraUser: string | null; sharedHost: string | null; sharedCameraUser: string | null;
  createdAt: number; updatedAt: number; version: number;
}
export type TrustEntry = { accountId: string; camsId: string; fields: string[] };
// The contract's report-request (contract/cams-v1, lenient: only v and mode are sure).
export interface CamsReport {
  v: 1; mode: 'file' | 'shadow' | 'cams-admin'; version?: string; appliedRevision?: string | null; cacheVerifiedAt?: number | null; lastPullAt?: number | null;
  held?: TrustEntry[]; keptOld?: TrustEntry[]; shadow?: { accountId: string | null; differences: number; items: string[] } | null;
  tokens?: { managed: number; pending: number; legacy: number }; problems?: { code: string; accountId?: string | null; detail?: string }[];
}
export interface CamsLive { lastSeenAt: number | null; lastPullAt: number | null; lastPullStatus: 200 | 304 | null; report: CamsReport | null; reportAt: number | null; shadowZeroSince: number | null }

export interface CamsInstancesDeps {
  db: Db; clock: Clock; audit: Audit; registry: Registry; cfg: Pick<Config, 'publicUrl' | 'enrollCodeDefaultH'>;
  serverKeys: string[]; serverKeyFingerprints: string[];
  // R4-19: revokes the tokens the instance holds (Tokens.revokeHeldBy): all of
  // them, or those on the given accounts' / proxies' (no longer served or hidden).
  onRevoke: (instanceId: string, actor: string, scope?: { accountIds?: string[]; proxyIds?: string[] }) => void;
  // The revocation journal (restores can't undo a revocation, review M5).
  journal?: (r: RevocationEntry) => void;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIFETIMES = [1, 24, 168];
const MAX_ACCOUNTS = 64;
const notFound = () => new ApiError(404, 'not_found');
const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const EMPTY_LIVE: CamsLive = { lastSeenAt: null, lastPullAt: null, lastPullStatus: null, report: null, reportAt: null, shadowZeroSince: null };

const toKey = (r: Row): CamsKey => ({
  id: r.id as string, instanceId: r.instance_id as string, fingerprint: r.fingerprint as string, createdAt: r.created_at as number,
  confirmedAt: r.confirmed_at as number | null, lastSeenAt: r.last_seen_at as number | null, revokedAt: r.revoked_at as number | null, revokedReason: r.revoked_reason as string | null,
});

const toOverride = (r: Row): CameraOverride => ({
  instanceId: r.instance_id as string, cameraId: r.camera_id as string, accountId: r.account_id as string, accountName: r.account_name as string, camsId: r.cams_id as string, name: r.name as string,
  host: r.host as string | null, cameraUser: r.camera_user as string | null, sharedHost: r.shared_host as string | null, sharedCameraUser: r.shared_user as string | null,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number,
});

function text(b: Row, key: string, max: number, required: boolean): string | null | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw new ApiError(400, 'invalid', key);
    return undefined;
  }
  if (v === null || v === '') {
    if (required) throw new ApiError(400, 'invalid', key);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max) throw new ApiError(400, 'invalid', key);
  return v.trim();
}
function urlOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || v.length > 512) throw new ApiError(400, 'invalid', field);
  try {
    return checkUrl(v, field);
  } catch (e) {
    if (e instanceof FieldError) throw new ApiError(400, 'invalid', field);
    throw e;
  }
}

export class CamsInstances {
  private liveState = new Map<string, CamsLive>();
  constructor(private d: CamsInstancesDeps) {}

  private q(sql: string) {
    return this.d.db.prepare(sql);
  }
  private log(actor: string, action: AuditAction, i: { id: string; name: string }, detail?: Record<string, unknown>): void {
    this.d.audit.write({ actorType: 'sysadmin', actor, action, targetType: 'cams-instance', targetId: i.id, targetLabel: i.name, outcome: 'ok', detail });
  }

  private accountsInput(v: unknown): string[] {
    if (!Array.isArray(v) || v.length > MAX_ACCOUNTS || v.some((x) => typeof x !== 'string') || new Set(v).size !== v.length) throw new ApiError(400, 'invalid', 'accounts');
    for (const id of v as string[]) if (!this.q('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw new ApiError(400, 'invalid', 'accounts');
    return v as string[];
  }
  private setAccounts(id: string, accounts: string[]): void {
    this.q('DELETE FROM cams_instance_accounts WHERE instance_id = ?').run(id);
    const ins = this.q('INSERT INTO cams_instance_accounts (instance_id, account_id) VALUES (?, ?)');
    for (const a of accounts) ins.run(id, a);
  }
  private mapName<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && /UNIQUE.*cams_instances\.name/.test(e.message)) throw new ApiError(409, 'duplicate_name', 'name');
      throw e;
    }
  }

  // --- instances ----------------------------------------------------------------------

  create(actor: string, input: unknown): CamsInstance {
    if (!isObj(input)) throw new ApiError(400, 'invalid', 'body');
    const name = text(input, 'name', 32, true)!;
    if (!NAME_RE.test(name)) throw new ApiError(400, 'invalid', 'name');
    const displayName = text(input, 'displayName', 200, true)!;
    const baseUrl = urlOrNull(input.baseUrl, 'baseUrl');
    const notes = text(input, 'notes', 2000, false) ?? null;
    return this.mapName(() => tx(this.d.db, () => {
      const accounts = this.accountsInput(input.accounts ?? []);
      const now = this.d.clock.now();
      const id = newId('cms');
      this.q(`INSERT INTO cams_instances (id, name, display_name, base_url, notes, state, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)`).run(id, name, displayName, baseUrl, notes, now, now);
      this.setAccounts(id, accounts);
      this.log(actor, 'cams-instance-create', { id, name }, { accounts });
      return this.get(id);
    }));
  }

  get(id: string): CamsInstance {
    const r = this.q('SELECT * FROM cams_instances WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound();
    return this.toInstance(r);
  }

  // The row without the served accounts (the request check's lookup); null when unknown.
  getRaw(id: string): { id: string; name: string; state: CamsInstance['state']; version: number; rotateBefore: number | null } | null {
    const r = this.q('SELECT id, name, state, version, rotate_before FROM cams_instances WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, name: r.name as string, state: r.state as CamsInstance['state'], version: r.version as number, rotateBefore: r.rotate_before as number | null } : null;
  }

  private toInstance(r: Row): CamsInstance {
    return {
      id: r.id as string, name: r.name as string, displayName: r.display_name as string, baseUrl: r.base_url as string | null, notes: r.notes as string | null,
      state: r.state as CamsInstance['state'], rotateBefore: r.rotate_before as number | null, accounts: this.servedAccountIds(r.id as string),
      createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number,
    };
  }

  list(): (CamsInstance & { live: CamsLive; activeKey: CamsKey | null })[] {
    return (this.q('SELECT * FROM cams_instances ORDER BY name').all() as Row[]).map((r) => {
      const i = this.toInstance(r);
      const k = this.q('SELECT * FROM cams_instance_keys WHERE instance_id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL').get(i.id) as Row | undefined;
      return { ...i, live: this.live(i.id), activeKey: k ? toKey(k) : null };
    });
  }

  update(actor: string, id: string, patch: unknown): CamsInstance {
    if (!isObj(patch)) throw new ApiError(400, 'invalid', 'body');
    if (!Number.isInteger(patch.version)) throw new ApiError(400, 'invalid', 'version');
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const fields: string[] = [];
    if (patch.name !== undefined) {
      const n = text(patch, 'name', 32, true)!;
      if (!NAME_RE.test(n)) throw new ApiError(400, 'invalid', 'name');
      sets.push('name = ?'); args.push(n); fields.push('name');
    }
    if (patch.displayName !== undefined) { sets.push('display_name = ?'); args.push(text(patch, 'displayName', 200, true)!); fields.push('displayName'); }
    if (patch.baseUrl !== undefined) { sets.push('base_url = ?'); args.push(urlOrNull(patch.baseUrl, 'baseUrl')); fields.push('baseUrl'); }
    if (patch.notes !== undefined) { sets.push('notes = ?'); args.push(text(patch, 'notes', 2000, false) ?? null); fields.push('notes'); }
    const r = this.mapName(() => tx(this.d.db, () => {
      const old = this.get(id);
      const accounts = patch.accounts !== undefined ? this.accountsInput(patch.accounts) : null;
      const res = this.q(`UPDATE cams_instances SET ${[...sets, 'updated_at = ?', 'version = version + 1'].join(', ')} WHERE id = ? AND version = ?`)
        .run(...args, this.d.clock.now(), id, patch.version as number);
      if (res.changes === 0) throw new ApiError(409, 'conflict');
      if (accounts) {
        this.setAccounts(id, accounts);
        fields.push('accounts');
        // Overrides on an account no longer served go with it (a re-serve starts clean).
        const stale = this.q(`SELECT o.camera_id, o.host, o.camera_user, c.account_id, c.cams_id FROM cams_camera_overrides o JOIN cameras c ON c.id = o.camera_id
          WHERE o.instance_id = ? ORDER BY c.cams_id`).all(id) as Row[];
        for (const o of stale.filter((x) => !accounts.includes(x.account_id as string))) {
          this.q('DELETE FROM cams_camera_overrides WHERE instance_id = ? AND camera_id = ?').run(id, o.camera_id as string);
          this.d.audit.write({ actorType: 'sysadmin', actor, action: 'camera-override-clear', accountId: o.account_id as string, targetType: 'cams-instance', targetId: id, targetLabel: old.name, outcome: 'ok', detail: { camera: o.cams_id, host: o.host, cameraUser: o.camera_user, reason: 'account-not-served' } });
        }
      }
      this.log(actor, 'cams-instance-update', { id, name: old.name }, { fields, ...(accounts ? { accounts } : {}) });
      return { old, now: this.get(id) };
    }));
    // An account it no longer serves keeps no token of it.
    const removed = r.old.accounts.filter((a) => !r.now.accounts.includes(a));
    if (removed.length) this.d.onRevoke(id, actor, { accountIds: removed });
    return r.now;
  }

  // R4-19: the instance's tokens are revoked (onRevoke, each through
  // Tokens.revoke so the proxies drop them) before its rows go.
  remove(actor: string, id: string, confirmName: unknown): void {
    const i = this.get(id);
    if (confirmName !== i.name) throw new ApiError(400, 'confirm_mismatch', 'confirmName');
    this.d.onRevoke(id, actor);
    tx(this.d.db, () => {
      const keys = this.revokeKeys(id, 'instance-deleted', this.d.clock.now());
      this.q('DELETE FROM cams_instances WHERE id = ?').run(id);
      this.log(actor, 'cams-instance-delete', i, { revokedKeys: keys });
    });
    this.liveState.delete(id);
  }

  block(actor: string, id: string): CamsInstance {
    const out = tx(this.d.db, () => {
      const i = this.get(id);
      const now = this.d.clock.now();
      const keys = this.revokeKeys(id, 'blocked', now);
      this.q('UPDATE cams_enrollment_codes SET cancelled_at = ? WHERE instance_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, id);
      this.q(`UPDATE cams_instances SET state = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, id);
      this.log(actor, 'cams-instance-block', i, { revokedKeys: keys });
      return this.get(id);
    });
    this.d.journal?.({ kind: 'block', instanceId: id });
    this.d.onRevoke(id, actor);
    return out;
  }

  // A journal replay (buildServer): what was revoked stays revoked after a restore.
  replay(r: RevocationEntry, revokeToken: (tokenId: string) => void): void {
    const now = this.d.clock.now();
    const sys = (action: AuditAction, i: { id: string; name: string }, detail: Record<string, unknown>) =>
      this.d.audit.write({ actorType: 'system', actor: 'system', action, targetType: 'cams-instance', targetId: i.id, targetLabel: i.name, outcome: 'ok', detail: { ...detail, replayed: true } });
    if (r.kind === 'block') {
      const i = this.getRaw(r.instanceId);
      if (!i || i.state === 'revoked') return;
      tx(this.d.db, () => {
        const keys = this.revokeKeys(i.id, 'blocked', now);
        this.q('UPDATE cams_enrollment_codes SET cancelled_at = ? WHERE instance_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, i.id);
        this.q(`UPDATE cams_instances SET state = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, i.id);
        sys('cams-instance-block', i, { revokedKeys: keys });
      });
      this.d.onRevoke(i.id, 'system');
    } else if (r.kind === 'key') {
      const i = this.getRaw(r.instanceId);
      const k = this.q('SELECT revoked_at, fingerprint FROM cams_instance_keys WHERE id = ? AND instance_id = ?').get(r.keyId, r.instanceId) as Row | undefined;
      if (!i || !k || k.revoked_at !== null) return;
      tx(this.d.db, () => {
        this.q(`UPDATE cams_instance_keys SET revoked_at = ?, revoked_reason = 'admin' WHERE id = ?`).run(now, r.keyId);
        sys('cams-key-revoke', i, { keyId: r.keyId, fingerprint: k.fingerprint });
      });
    } else {
      for (const t of r.tokenIds) revokeToken(t);
    }
  }

  // The next pull carries rotateBefore = now: cams registers new tokens and retires the old ones (M §10.1).
  rotateNow(actor: string, id: string): CamsInstance {
    return tx(this.d.db, () => {
      const i = this.get(id);
      const now = this.d.clock.now();
      this.q('UPDATE cams_instances SET rotate_before = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, now, id);
      this.log(actor, 'cams-rotate', i, { rotateBefore: now });
      return this.get(id);
    });
  }

  servedAccountIds(id: string): string[] {
    return (this.q('SELECT s.account_id FROM cams_instance_accounts s JOIN accounts a ON a.id = s.account_id WHERE s.instance_id = ? ORDER BY a.name').all(id) as Row[]).map((r) => r.account_id as string);
  }

  // --- routes ---------------------------------------------------------------------------

  routes(id: string): CamsRoute[] {
    this.get(id);
    return (this.q(`SELECT r.*, p.account_id FROM cams_instance_routes r JOIN proxies p ON p.id = r.proxy_id WHERE r.instance_id = ? ORDER BY p.name`).all(id) as Row[])
      .map((r) => ({ instanceId: r.instance_id as string, proxyId: r.proxy_id as string, accountId: r.account_id as string, url: r.url as string | null, hidden: r.hidden === 1 }));
  }

  setRoute(actor: string, id: string, proxyId: string, input: unknown): CamsRoute {
    if (!isObj(input)) throw new ApiError(400, 'invalid', 'body');
    if (typeof input.hidden !== 'boolean') throw new ApiError(400, 'invalid', 'hidden');
    const hidden = input.hidden;
    // url null: the proxy's registered URL. Routes are default-deny: without
    // a visible route row an instance never sees the proxy (review I1).
    const url = hidden ? null : urlOrNull(input.url, 'url');
    const route = tx(this.d.db, (): CamsRoute => {
      const i = this.get(id);
      const px = this.d.registry.proxyById(proxyId);
      if (!px || !i.accounts.includes(px.accountId)) throw notFound();
      this.q(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES (?,?,?,?)
        ON CONFLICT(instance_id, proxy_id) DO UPDATE SET url = excluded.url, hidden = excluded.hidden`).run(id, proxyId, url, hidden ? 1 : 0);
      this.bumpVersion(id);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'route-update', accountId: px.accountId, targetType: 'cams-instance', targetId: id, targetLabel: i.name, outcome: 'ok', detail: { proxyId, proxy: px.name, url, hidden } });
      return { instanceId: id, proxyId, accountId: px.accountId, url, hidden };
    });
    // A proxy hidden for the instance keeps no token of it.
    if (hidden) this.d.onRevoke(id, actor, { proxyIds: [proxyId] });
    return route;
  }

  deleteRoute(actor: string, id: string, proxyId: string): void {
    tx(this.d.db, () => {
      const i = this.get(id);
      const px = this.d.registry.proxyById(proxyId);
      const res = this.q('DELETE FROM cams_instance_routes WHERE instance_id = ? AND proxy_id = ?').run(id, proxyId);
      if (res.changes === 0) throw notFound();
      this.bumpVersion(id);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'route-update', accountId: px?.accountId ?? null, targetType: 'cams-instance', targetId: id, targetLabel: i.name, outcome: 'ok', detail: { proxyId, removed: true } });
    });
  }

  // --- camera overrides (migration 7) -----------------------------------------------------------

  overrides(id: string): CameraOverride[] {
    this.get(id);
    return (this.q(`SELECT o.*, c.account_id, c.cams_id, c.name, c.host shared_host, c.camera_user shared_user, a.name account_name FROM cams_camera_overrides o
      JOIN cameras c ON c.id = o.camera_id JOIN accounts a ON a.id = c.account_id WHERE o.instance_id = ? ORDER BY a.name, c.cams_id`).all(id) as Row[]).map(toOverride);
  }

  // The camera, when the instance serves its account; else 404 (no write, no hint).
  private servedCamera(i: CamsInstance, cameraId: string): { id: string; accountId: string; camsId: string } {
    const c = this.q('SELECT id, account_id, cams_id FROM cameras WHERE id = ?').get(cameraId) as Row | undefined;
    if (!c || !i.accounts.includes(c.account_id as string)) throw notFound();
    return { id: c.id as string, accountId: c.account_id as string, camsId: c.cams_id as string };
  }

  // Sets the instance's host and camera user for a camera (null = the
  // camera's own value). Version-checked: a new override takes no version,
  // a change the one read. Bumps the instance's version (its revision only).
  setOverride(actor: string, id: string, cameraId: string, input: unknown): CameraOverride {
    let f: ReturnType<typeof cameraOverrideInput>;
    try {
      f = cameraOverrideInput(input);
    } catch (e) {
      if (e instanceof FieldError) throw new ApiError(400, 'invalid', e.field);
      throw e;
    }
    return tx(this.d.db, () => {
      const i = this.get(id);
      const cam = this.servedCamera(i, cameraId);
      const old = this.q('SELECT host, camera_user, version FROM cams_camera_overrides WHERE instance_id = ? AND camera_id = ?').get(id, cameraId) as Row | undefined;
      if (old ? f.version !== old.version : f.version !== undefined) throw new ApiError(409, 'conflict');
      // The same values again: nothing written (no version, no revision, no audit).
      if (old && old.host === f.host && old.camera_user === f.cameraUser) return this.overrides(id).find((o) => o.cameraId === cameraId)!;
      const now = this.d.clock.now();
      this.q(`INSERT INTO cams_camera_overrides (instance_id, camera_id, host, camera_user, created_at, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(instance_id, camera_id) DO UPDATE SET host = excluded.host, camera_user = excluded.camera_user, updated_at = excluded.updated_at, version = version + 1`)
        .run(id, cameraId, f.host, f.cameraUser, now, now);
      this.bumpVersion(id);
      const was = { host: (old?.host as string | null) ?? null, cameraUser: (old?.camera_user as string | null) ?? null };
      const detail: Record<string, unknown> = { camera: cam.camsId };
      for (const k of ['host', 'cameraUser'] as const) if (was[k] !== f[k]) detail[k] = { from: was[k], to: f[k] };
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'camera-override-set', accountId: cam.accountId, targetType: 'cams-instance', targetId: id, targetLabel: i.name, outcome: 'ok', detail });
      return this.overrides(id).find((o) => o.cameraId === cameraId)!;
    });
  }

  clearOverride(actor: string, id: string, cameraId: string): void {
    tx(this.d.db, () => {
      const i = this.get(id);
      const cam = this.servedCamera(i, cameraId);
      const old = this.q('SELECT host, camera_user FROM cams_camera_overrides WHERE instance_id = ? AND camera_id = ?').get(id, cameraId) as Row | undefined;
      if (!old) throw notFound();
      this.q('DELETE FROM cams_camera_overrides WHERE instance_id = ? AND camera_id = ?').run(id, cameraId);
      this.bumpVersion(id);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'camera-override-clear', accountId: cam.accountId, targetType: 'cams-instance', targetId: id, targetLabel: i.name, outcome: 'ok', detail: { camera: cam.camsId, host: old.host, cameraUser: old.camera_user } });
    });
  }

  // camera id → this instance's override (the importer's and the Export's view).
  overrideMap(id: string): Map<string, { host: string | null; cameraUser: string | null; version: number }> {
    return overridesOf(this.d.db, id);
  }

  // The instance's own row is part of its snapshot revision (R4-1).
  private bumpVersion(id: string): void {
    this.q('UPDATE cams_instances SET updated_at = ?, version = version + 1 WHERE id = ?').run(this.d.clock.now(), id);
  }

  // --- enrollment codes and keys ------------------------------------------------------------------

  createCode(actor: string, id: string, lifetimeH: unknown): { id: string; code: string; expiresAt: number; command: { cluster: string; pi: string }; serverKeyFingerprints: string[] } {
    const h = lifetimeH === undefined || lifetimeH === null ? this.d.cfg.enrollCodeDefaultH : lifetimeH;
    if (typeof h !== 'number' || !LIFETIMES.includes(h)) throw new ApiError(400, 'invalid', 'lifetimeH');
    return tx(this.d.db, () => {
      const i = this.get(id);
      if (i.state === 'revoked') throw new ApiError(409, 'instance_blocked');
      const now = this.d.clock.now();
      this.q('UPDATE cams_enrollment_codes SET cancelled_at = ? WHERE instance_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, id);
      const code = newCamsEnrollmentCode();
      const codeId = newId('enr');
      const expiresAt = now + h * 3600_000;
      this.q('INSERT INTO cams_enrollment_codes (id, instance_id, code_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(codeId, id, codeHash(code), actor, now, expiresAt);
      this.log(actor, 'cams-enrollment-code-create', i, { codeId, lifetimeH: h });
      return {
        id: codeId, code, expiresAt, serverKeyFingerprints: this.d.serverKeyFingerprints,
        command: {
          // The in-cluster URL is kube-setup's (docs/migration-p4-runbook.md).
          cluster: 'kubectl exec -i -n cams <cams pod> -- node dist/server/cli.js admin-enroll --url <CAMS_ADMIN_URL>',
          pi: `docker compose exec -T cams node dist/server/cli.js admin-enroll --url ${this.d.cfg.publicUrl}`,
        },
      };
    });
  }

  cancelCode(actor: string, id: string, codeId: string): void {
    tx(this.d.db, () => {
      const i = this.get(id);
      const r = this.q('UPDATE cams_enrollment_codes SET cancelled_at = ? WHERE id = ? AND instance_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(this.d.clock.now(), codeId, id);
      if (r.changes === 0) throw notFound();
      this.log(actor, 'cams-enrollment-code-cancel', i, { codeId });
    });
  }

  liveCode(id: string): { id: string; expiresAt: number; createdAt: number } | null {
    const r = this.q('SELECT id, expires_at, created_at FROM cams_enrollment_codes WHERE instance_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?').get(id, this.d.clock.now()) as Row | undefined;
    return r ? { id: r.id as string, expiresAt: r.expires_at as number, createdAt: r.created_at as number } : null;
  }

  keys(id: string): CamsKey[] {
    this.get(id);
    return (this.q('SELECT * FROM cams_instance_keys WHERE instance_id = ? ORDER BY created_at DESC, id DESC').all(id) as Row[]).map(toKey);
  }

  // A revoked key takes the instance's proxy tokens with it, at once (review
  // I3: a stolen instance holds both); cams registers new ones after a re-enrollment.
  revokeKey(actor: string, id: string, keyId: string): CamsKey {
    const k = tx(this.d.db, () => {
      const i = this.get(id);
      const k = this.q('SELECT * FROM cams_instance_keys WHERE id = ? AND instance_id = ?').get(keyId, id) as Row | undefined;
      if (!k) throw notFound();
      if (k.revoked_at !== null) throw new ApiError(409, 'already_revoked');
      this.q(`UPDATE cams_instance_keys SET revoked_at = ?, revoked_reason = 'admin' WHERE id = ?`).run(this.d.clock.now(), keyId);
      this.log(actor, 'cams-key-revoke', i, { keyId, fingerprint: k.fingerprint, tokensRevoked: true });
      return toKey(this.q('SELECT * FROM cams_instance_keys WHERE id = ?').get(keyId) as Row);
    });
    this.d.journal?.({ kind: 'key', instanceId: id, keyId });
    this.d.onRevoke(id, actor);
    return k;
  }

  // Inside the caller's transaction: every unrevoked key of the instance.
  revokeKeys(id: string, reason: 'admin' | 're-enrolled' | 'instance-deleted' | 'blocked', now: number, which: 'all' | 'confirmed' | 'pending' = 'all', except?: string): string[] {
    const cond = which === 'confirmed' ? ' AND confirmed_at IS NOT NULL' : which === 'pending' ? ' AND confirmed_at IS NULL' : '';
    const ids = (this.q(`SELECT id FROM cams_instance_keys WHERE instance_id = ? AND revoked_at IS NULL${cond}`).all(id) as Row[]).map((r) => r.id as string).filter((k) => k !== except);
    const upd = this.q('UPDATE cams_instance_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?');
    for (const k of ids) upd.run(now, reason, k);
    return ids;
  }

  // A pending key's first verified request (CamsAuth step 7): it becomes the
  // active key, the older active key goes ('re-enrolled'), a pending instance
  // is enrolled. false when the instance is blocked or the key not pending.
  confirmKey(instanceId: string, keyId: string): boolean {
    const r = tx(this.d.db, () => {
      const k = this.q('SELECT k.*, i.state, i.name FROM cams_instance_keys k JOIN cams_instances i ON i.id = k.instance_id WHERE k.id = ? AND k.instance_id = ?').get(keyId, instanceId) as Row | undefined;
      if (!k || k.revoked_at !== null || k.confirmed_at !== null || k.state === 'revoked') return false as const;
      const now = this.d.clock.now();
      const replaced = this.revokeKeys(instanceId, 're-enrolled', now, 'confirmed');
      this.q('UPDATE cams_instance_keys SET confirmed_at = ? WHERE id = ?').run(now, keyId);
      if (k.state === 'pending') this.q(`UPDATE cams_instances SET state = 'enrolled', updated_at = ? WHERE id = ?`).run(now, instanceId);
      this.d.audit.write({ actorType: 'cams', actor: instanceId, action: 'cams-key-confirmed', targetType: 'cams-instance', targetId: instanceId, targetLabel: k.name as string, outcome: 'ok', detail: { keyId, fingerprint: k.fingerprint, replacedKeys: replaced } });
      return { ok: true, replaced };
    });
    if (r === false) return false;
    for (const k of r.replaced) this.d.journal?.({ kind: 'key', instanceId, keyId: k });
    // A re-enrollment replaced a working key: the tokens held under it go too (review I3).
    if (r.replaced.length) this.d.onRevoke(instanceId, 'system');
    return true;
  }

  // POST /cams/v1/report: kept in memory only (no write); answers whether the
  // instance's applied revision is the current one.
  report(instanceId: string, report: unknown, now: number): { changed: boolean; revision: string } {
    const v = validateCams('report-request', report);
    if (!v.ok) throw new ApiError(400, 'invalid', fieldOf(v.detail));
    const r = report as CamsReport;
    const prev = this.live(instanceId);
    const zero = r.mode === 'shadow' && !!r.shadow && r.shadow.differences === 0;
    this.touch(instanceId, { report: r, reportAt: now, shadowZeroSince: zero ? prev.shadowZeroSince ?? now : null });
    const revision = snapshotRevision(this.d.db, instanceId, this.d.serverKeyFingerprints[0] ?? '');
    return { changed: r.appliedRevision !== revision, revision };
  }

  // --- in memory ------------------------------------------------------------------------------

  live(id: string): CamsLive {
    return { ...(this.liveState.get(id) ?? EMPTY_LIVE) };
  }

  touch(id: string, patch: Partial<CamsLive>): void {
    this.liveState.set(id, { ...(this.liveState.get(id) ?? EMPTY_LIVE), ...patch });
  }
}
