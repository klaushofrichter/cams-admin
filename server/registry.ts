import type { Clock } from './clock';
import type { Audit, AuditAction } from './audit';
import { tx, type Db } from './db/open';
import { newId } from './ids';
import {
  accountInput, cameraInput, checkCameraHost, checkCameraProxy, FieldError, normaliseEmail, proxyInput, simInput, userInput,
  type CameraFields, type ProxyFields, type SimFields,
} from './validate';

// The registry of spec §4: accounts, users, proxies, keys, cameras, sims.
// Every write is one transaction with exactly one audit record.

export class ApiError extends Error {
  constructor(public status: number, public code: string, public field?: string) {
    super(code);
  }
}
const notFound = () => new ApiError(404, 'not_found');

type Row = Record<string, unknown>;

export interface Account { id: string; name: string; displayName: string; notes: string | null; createdAt: number; updatedAt: number; version: number }
export interface AccountListItem extends Account { users: number; admins: number; proxies: number; cameras: number }
export interface User { id: string; accountId: string; email: string; displayName: string | null; role: 'admin' | 'viewer'; disabled: boolean; createdAt: number; updatedAt: number; version: number }
export interface Proxy extends ProxyFields { id: string; accountId: string; state: 'pending' | 'enrolled' | 'revoked'; createdAt: number; updatedAt: number; version: number }
// pending: redeemed, waiting for the key's first hello ('waiting'), or too
// late for one ('expired', an enroll answer the proxy never used).
export interface ProxyKey { id: string; proxyId: string; publicKey: string; fingerprint: string; createdAt: number; enrollmentId: string | null; lastSeenAt: number | null; confirmedAt: number | null; pending: 'waiting' | 'expired' | null; revokedAt: number | null; revokedReason: string | null }

// How long a redeemed key may wait for its first hello.
export const PENDING_KEY_MS = 24 * 3600_000;
export const pendingExpired = (createdAt: number, now: number) => now - createdAt >= PENDING_KEY_MS;
export interface Sim extends SimFields { cameraId: string }
export interface Camera extends CameraFields { id: string; accountId: string; createdAt: number; updatedAt: number; version: number; sim: Sim | null }
export interface Membership { accountId: string; accountName: string; displayName: string; role: 'admin' | 'viewer' }

const toAccount = (r: Row): Account => ({ id: r.id as string, name: r.name as string, displayName: r.display_name as string, notes: r.notes as string | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number });
const toUser = (r: Row): User => ({ id: r.id as string, accountId: r.account_id as string, email: r.email as string, displayName: r.display_name as string | null, role: r.role as User['role'], disabled: r.disabled === 1, createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number });
const toProxy = (r: Row): Proxy => ({
  id: r.id as string, accountId: r.account_id as string, name: r.name as string, displayName: r.display_name as string, runsOn: r.runs_on as string,
  hostKind: r.host_kind as string | null, url: r.url as string | null, adminUiUrl: r.admin_ui_url as string | null, dnsName: r.dns_name as string | null,
  tlsSite: r.tls_site as string | null, tlsServername: r.tls_servername as string | null, caFingerprints: JSON.parse(r.ca_fingerprints as string),
  notes: r.notes as string | null, state: r.state as Proxy['state'], createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number,
});
export const toKey = (r: Row, now: number): ProxyKey => ({
  id: r.id as string, proxyId: r.proxy_id as string, publicKey: r.public_key as string, fingerprint: r.fingerprint as string, createdAt: r.created_at as number,
  enrollmentId: r.enrollment_id as string | null, lastSeenAt: r.last_seen_at as number | null, confirmedAt: r.confirmed_at as number | null,
  pending: r.revoked_at !== null || r.confirmed_at !== null ? null : pendingExpired(r.created_at as number, now) ? 'expired' : 'waiting',
  revokedAt: r.revoked_at as number | null, revokedReason: r.revoked_reason as string | null,
});
const toSim = (r: Row): Sim => ({ cameraId: r.camera_id as string, runsOn: r.runs_on as string, controlUrl: r.control_url as string | null, uiUrl: r.ui_url as string | null, image: r.image as string | null, notes: r.notes as string | null });
const toCamera = (r: Row, sim: Sim | null): Camera => ({
  id: r.id as string, accountId: r.account_id as string, proxyId: r.proxy_id as string | null, camsId: r.cams_id as string, proxyCameraId: r.proxy_camera_id as string | null,
  name: r.name as string, kind: r.kind as Camera['kind'], model: r.model as string | null, host: r.host as string | null, protocol: r.protocol as string | null,
  tlsServername: r.tls_servername as string | null, cameraUser: r.camera_user as string | null, webUiUrl: r.web_ui_url as string | null, webUiNote: r.web_ui_note as string | null,
  notes: r.notes as string | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number, version: r.version as number, sim,
});

// camelCase field → column.
const COLUMNS: Record<string, string> = {
  name: 'name', displayName: 'display_name', notes: 'notes', email: 'email', role: 'role', disabled: 'disabled',
  runsOn: 'runs_on', hostKind: 'host_kind', url: 'url', adminUiUrl: 'admin_ui_url', dnsName: 'dns_name', tlsSite: 'tls_site', tlsServername: 'tls_servername', caFingerprints: 'ca_fingerprints',
  proxyId: 'proxy_id', camsId: 'cams_id', proxyCameraId: 'proxy_camera_id', kind: 'kind', model: 'model', host: 'host', protocol: 'protocol', cameraUser: 'camera_user', webUiUrl: 'web_ui_url', webUiNote: 'web_ui_note',
  controlUrl: 'control_url', uiUrl: 'ui_url', image: 'image',
};
const dbValue = (k: string, v: unknown): string | number | null => (k === 'caFingerprints' ? JSON.stringify(v) : k === 'disabled' ? (v ? 1 : 0) : (v as string | number | null));

// SQLite constraint messages → API errors naming the field.
function mapConstraint(e: unknown): never {
  const m = e instanceof Error ? e.message : String(e);
  if (/UNIQUE.*account_users\.account_id, account_users\.email/.test(m)) throw new ApiError(409, 'duplicate_email', 'email');
  if (/UNIQUE.*accounts\.name/.test(m) || /UNIQUE.*proxies\.account_id, proxies\.name/.test(m)) throw new ApiError(409, 'duplicate_name', 'name');
  if (/UNIQUE.*cameras\.account_id, cameras\.cams_id/.test(m)) throw new ApiError(409, 'duplicate_cams_id', 'camsId');
  if (/UNIQUE.*cameras\.proxy_id, cameras\.proxy_camera_id/.test(m)) throw new ApiError(409, 'duplicate_proxy_camera', 'proxyCameraId');
  if (/FOREIGN KEY/.test(m)) throw new ApiError(400, 'invalid', 'proxyId');
  if (/not a sim/.test(m)) throw new ApiError(400, 'not_a_sim');
  throw e;
}
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof FieldError) throw new ApiError(400, 'invalid', e.field);
    return mapConstraint(e);
  }
}

function versionOf(patch: Row): number {
  const v = patch.version;
  if (!Number.isInteger(v)) throw new ApiError(400, 'invalid', 'version');
  return v as number;
}

export class Registry {
  constructor(private db: Db, private clock: Clock, private audit: Audit) {}

  // --- generic helpers ---------------------------------------------------------

  private one(sql: string, ...args: (string | number | null)[]): Row {
    const r = this.db.prepare(sql).get(...args) as Row | undefined;
    if (!r) throw notFound();
    return r;
  }

  private insert(table: string, values: Record<string, string | number | null>): void {
    const cols = Object.keys(values);
    this.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(values));
  }

  // UPDATE … WHERE id AND version: 409 when someone else wrote first.
  private updateRow(table: string, where: { id: string; accountId?: string }, fields: Row, version: number): string[] {
    const keys = Object.keys(fields).filter((k) => k !== 'version');
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`);
    const args = keys.map((k) => dbValue(k, fields[k]));
    const acc = where.accountId ? ' AND account_id = ?' : '';
    const res = this.db.prepare(`UPDATE ${table} SET ${[...sets, 'updated_at = ?', 'version = version + 1'].join(', ')} WHERE id = ?${acc} AND version = ?`)
      .run(...args, this.clock.now(), where.id, ...(where.accountId ? [where.accountId] : []), version);
    if (res.changes === 0) {
      const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?${acc}`).get(where.id, ...(where.accountId ? [where.accountId] : []));
      throw exists ? new ApiError(409, 'conflict') : notFound();
    }
    return keys;
  }

  private log(actor: string, action: AuditAction, accountId: string | null, targetType: string, targetId: string, targetLabel: string, detail?: Record<string, unknown>): void {
    this.audit.write({ actorType: 'sysadmin', actor, action, accountId, targetType, targetId, targetLabel, outcome: 'ok', detail });
  }

  // --- accounts --------------------------------------------------------------------

  createAccount(actor: string, input: unknown): Account {
    return guard(() => tx(this.db, () => {
      const f = accountInput(input, false);
      const now = this.clock.now();
      const id = newId('acc');
      this.insert('accounts', { id, name: f.name!, display_name: f.displayName!, notes: f.notes ?? null, created_at: now, updated_at: now });
      this.log(actor, 'account-create', id, 'account', id, f.name!);
      return this.getAccount(id);
    }));
  }

  getAccount(id: string): Account {
    return toAccount(this.one('SELECT * FROM accounts WHERE id = ?', id));
  }

  listAccounts(): AccountListItem[] {
    const rows = this.db.prepare(`SELECT a.*,
      (SELECT count(*) FROM account_users u WHERE u.account_id = a.id) users,
      (SELECT count(*) FROM account_users u WHERE u.account_id = a.id AND u.role = 'admin' AND u.disabled = 0) admins,
      (SELECT count(*) FROM proxies p WHERE p.account_id = a.id) proxies,
      (SELECT count(*) FROM cameras c WHERE c.account_id = a.id) cameras
      FROM accounts a ORDER BY a.name`).all() as Row[];
    return rows.map((r) => ({ ...toAccount(r), users: r.users as number, admins: r.admins as number, proxies: r.proxies as number, cameras: r.cameras as number }));
  }

  updateAccount(actor: string, id: string, patch: unknown): Account {
    return guard(() => tx(this.db, () => {
      const f = accountInput(patch, true);
      const old = this.getAccount(id);
      const keys = this.updateRow('accounts', { id }, f, versionOf(patch as Row));
      this.log(actor, 'account-update', id, 'account', id, f.name ?? old.name, { fields: keys, ...(f.name && f.name !== old.name ? { renamedFrom: old.name } : {}) });
      return this.getAccount(id);
    }));
  }

  // The caller closes the returned proxies' live connections first (4403).
  deleteAccount(actor: string, id: string, confirmName: unknown): { proxyIds: string[] } {
    return guard(() => tx(this.db, () => {
      const a = this.getAccount(id);
      if (confirmName !== a.name) throw new ApiError(400, 'confirm_mismatch', 'confirmName');
      const proxyIds = (this.db.prepare('SELECT id FROM proxies WHERE account_id = ? ORDER BY id').all(id) as Row[]).map((r) => r.id as string);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      this.log(actor, 'account-delete', id, 'account', id, a.name, { proxies: proxyIds.length });
      return { proxyIds };
    }));
  }

  // --- users -------------------------------------------------------------------------

  createUser(actor: string, accountId: string, input: unknown): User {
    return guard(() => tx(this.db, () => {
      const a = this.getAccount(accountId);
      const f = userInput(input, false);
      const now = this.clock.now();
      const id = newId('usr');
      this.insert('account_users', { id, account_id: accountId, email: f.email!, display_name: f.displayName ?? null, role: f.role!, disabled: f.disabled ? 1 : 0, created_at: now, updated_at: now });
      this.log(actor, 'user-create', accountId, 'user', id, f.email!, { role: f.role, account: a.name });
      return this.getUser(accountId, id);
    }));
  }

  getUser(accountId: string, id: string): User {
    return toUser(this.one('SELECT * FROM account_users WHERE id = ? AND account_id = ?', id, accountId));
  }

  listUsers(accountId: string): User[] {
    this.getAccount(accountId);
    return (this.db.prepare('SELECT * FROM account_users WHERE account_id = ? ORDER BY email').all(accountId) as Row[]).map(toUser);
  }

  updateUser(actor: string, accountId: string, id: string, patch: unknown): User {
    return guard(() => tx(this.db, () => {
      const f = userInput(patch, true);
      const keys = this.updateRow('account_users', { id, accountId }, f, versionOf(patch as Row));
      const u = this.getUser(accountId, id);
      this.log(actor, 'user-update', accountId, 'user', id, u.email, { fields: keys, ...(f.role ? { role: f.role } : {}) });
      return u;
    }));
  }

  deleteUser(actor: string, accountId: string, id: string): void {
    guard(() => tx(this.db, () => {
      const u = this.getUser(accountId, id);
      this.db.prepare('DELETE FROM account_users WHERE id = ?').run(id);
      this.log(actor, 'user-delete', accountId, 'user', id, u.email);
    }));
  }

  // Every membership of one email, disabled ones too (the administrator's view).
  usersByEmail(email: string): (User & { accountName: string })[] {
    const e = normaliseEmailOr400(email);
    return (this.db.prepare('SELECT u.*, a.name account_name FROM account_users u JOIN accounts a ON a.id = u.account_id WHERE u.email = ? ORDER BY a.name').all(e) as Row[])
      .map((r) => ({ ...toUser(r), accountName: r.account_name as string }));
  }

  // Spec §5: the P4 lookup, accounts and roles for this email.
  memberships(email: string): Membership[] {
    const e = normaliseEmailOr400(email);
    return (this.db.prepare(`SELECT a.id, a.name, a.display_name, u.role FROM account_users u JOIN accounts a ON a.id = u.account_id
      WHERE u.email = ? AND u.disabled = 0 ORDER BY a.name`).all(e) as Row[])
      .map((r) => ({ accountId: r.id as string, accountName: r.name as string, displayName: r.display_name as string, role: r.role as Membership['role'] }));
  }

  // --- proxies -----------------------------------------------------------------------

  createProxy(actor: string, accountId: string, input: unknown): Proxy {
    return guard(() => tx(this.db, () => {
      this.getAccount(accountId);
      const f = proxyInput(input, false) as ProxyFields;
      const now = this.clock.now();
      const id = newId('prx');
      this.insert('proxies', {
        id, account_id: accountId, name: f.name, display_name: f.displayName, runs_on: f.runsOn, host_kind: f.hostKind, url: f.url, admin_ui_url: f.adminUiUrl,
        dns_name: f.dnsName, tls_site: f.tlsSite, tls_servername: f.tlsServername, ca_fingerprints: JSON.stringify(f.caFingerprints), notes: f.notes,
        state: 'pending', created_at: now, updated_at: now,
      });
      this.log(actor, 'proxy-create', accountId, 'proxy', id, f.name);
      return this.getProxy(accountId, id);
    }));
  }

  getProxy(accountId: string, id: string): Proxy {
    return toProxy(this.one('SELECT * FROM proxies WHERE id = ? AND account_id = ?', id, accountId));
  }

  proxyById(id: string): Proxy | null {
    const r = this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id) as Row | undefined;
    return r ? toProxy(r) : null;
  }

  listProxies(accountId?: string): Proxy[] {
    const rows = accountId === undefined
      ? this.db.prepare('SELECT * FROM proxies ORDER BY name').all()
      : this.db.prepare('SELECT * FROM proxies WHERE account_id = ? ORDER BY name').all(accountId);
    return (rows as Row[]).map(toProxy);
  }

  updateProxy(actor: string, accountId: string, id: string, patch: unknown): Proxy {
    return guard(() => tx(this.db, () => {
      const f = proxyInput(patch, true);
      const keys = this.updateRow('proxies', { id, accountId }, f, versionOf(patch as Row));
      const p = this.getProxy(accountId, id);
      this.log(actor, 'proxy-update', accountId, 'proxy', id, p.name, { fields: keys });
      return p;
    }));
  }

  // Returns the key ids whose connections the caller closes. Cameras stay (proxy_id NULL).
  deleteProxy(actor: string, accountId: string, id: string): { keyIds: string[] } {
    return guard(() => tx(this.db, () => {
      const p = this.getProxy(accountId, id);
      const keyIds = this.revokeActiveKeys(id, 'proxy-deleted', this.clock.now());
      this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
      this.log(actor, 'proxy-delete', accountId, 'proxy', id, p.name);
      return { keyIds };
    }));
  }

  // Spec §8.10: state revoked; the active key and any live code die.
  blockProxy(actor: string, accountId: string, id: string): Proxy {
    return guard(() => tx(this.db, () => {
      const p = this.getProxy(accountId, id);
      const now = this.clock.now();
      this.revokeActiveKeys(id, 'blocked', now);
      this.cancelLiveCodes(id, now);
      this.db.prepare(`UPDATE proxies SET state = 'revoked', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, id);
      this.log(actor, 'proxy-block', accountId, 'proxy', id, p.name);
      return this.getProxy(accountId, id);
    }));
  }

  // Inside the caller's transaction: the proxy's unrevoked keys (active and
  // pending; only the confirmed ones with `confirmed`) revoked, their ids returned.
  revokeActiveKeys(proxyId: string, reason: 'proxy-deleted' | 'blocked' | 're-enrolled', now: number, which: 'all' | 'confirmed' | 'pending' = 'all', except?: string): string[] {
    const cond = which === 'confirmed' ? ' AND confirmed_at IS NOT NULL' : which === 'pending' ? ' AND confirmed_at IS NULL' : '';
    const ids = (this.db.prepare(`SELECT id FROM proxy_keys WHERE proxy_id = ? AND revoked_at IS NULL${cond}`).all(proxyId) as Row[]).map((r) => r.id as string).filter((id) => id !== except);
    const upd = this.db.prepare('UPDATE proxy_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?');
    for (const id of ids) upd.run(now, reason, id);
    return ids;
  }

  // A pending key's first hello: it becomes the active key, the old active
  // key goes ('re-enrolled'), a pending proxy is enrolled. null when the key
  // is not pending or waited too long. Returns the replaced keys' ids.
  confirmKey(proxyId: string, keyId: string): { revoked: string[] } | null {
    return tx(this.db, () => {
      const now = this.clock.now();
      const k = this.db.prepare(`SELECT k.*, p.account_id, p.name proxy_name, p.state FROM proxy_keys k JOIN proxies p ON p.id = k.proxy_id WHERE k.id = ? AND k.proxy_id = ?`).get(keyId, proxyId) as Row | undefined;
      if (!k || k.revoked_at !== null || k.confirmed_at !== null || k.state === 'revoked' || pendingExpired(k.created_at as number, now)) return null;
      const revoked = this.revokeActiveKeys(proxyId, 're-enrolled', now, 'confirmed');
      this.db.prepare('UPDATE proxy_keys SET confirmed_at = ? WHERE id = ?').run(now, keyId);
      if (k.state === 'pending') this.db.prepare(`UPDATE proxies SET state = 'enrolled', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, proxyId);
      this.audit.write({ actorType: 'proxy', actor: proxyId, action: 'key-confirmed', accountId: k.account_id as string, targetType: 'proxy', targetId: proxyId, targetLabel: k.proxy_name as string, outcome: 'ok', detail: { keyId, fingerprint: k.fingerprint, replacedKeys: revoked } });
      return { revoked };
    });
  }

  // Inside the caller's transaction: every unused, uncancelled code of the proxy.
  cancelLiveCodes(proxyId: string, now: number): void {
    this.db.prepare('UPDATE enrollment_codes SET cancelled_at = ? WHERE proxy_id = ? AND used_at IS NULL AND cancelled_at IS NULL').run(now, proxyId);
  }

  listKeys(accountId: string, proxyId: string): ProxyKey[] {
    this.getProxy(accountId, proxyId);
    const now = this.clock.now();
    return (this.db.prepare('SELECT * FROM proxy_keys WHERE proxy_id = ? ORDER BY created_at DESC').all(proxyId) as Row[]).map((r) => toKey(r, now));
  }

  activeKey(proxyId: string): ProxyKey | null {
    const r = this.db.prepare('SELECT * FROM proxy_keys WHERE proxy_id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL').get(proxyId) as Row | undefined;
    return r ? toKey(r, this.clock.now()) : null;
  }

  revokeKey(actor: { type: 'sysadmin' | 'proxy'; id: string }, accountId: string, proxyId: string, keyId: string, reason: 'admin' | 'unenrolled' = 'admin'): ProxyKey {
    return guard(() => tx(this.db, () => {
      const p = this.getProxy(accountId, proxyId);
      const k = toKey(this.one('SELECT * FROM proxy_keys WHERE id = ? AND proxy_id = ?', keyId, proxyId), this.clock.now());
      if (k.revokedAt !== null) throw new ApiError(409, 'already_revoked');
      this.db.prepare('UPDATE proxy_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(this.clock.now(), reason, keyId);
      this.audit.write({ actorType: actor.type, actor: actor.id, action: 'key-revoke', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: p.name, outcome: 'ok', detail: { keyId, fingerprint: k.fingerprint, reason } });
      return toKey(this.one('SELECT * FROM proxy_keys WHERE id = ?', keyId), this.clock.now());
    }));
  }

  // --- cameras and sims --------------------------------------------------------------

  createCamera(actor: string, accountId: string, input: unknown, action: 'camera-create' | 'camera-adopt' = 'camera-create'): Camera {
    return guard(() => tx(this.db, () => {
      this.getAccount(accountId);
      const f = cameraInput(input, false) as CameraFields;
      const now = this.clock.now();
      const id = newId('cam');
      this.insert('cameras', {
        id, account_id: accountId, proxy_id: f.proxyId, cams_id: f.camsId, proxy_camera_id: f.proxyCameraId, name: f.name, kind: f.kind, model: f.model, host: f.host,
        protocol: f.protocol, tls_servername: f.tlsServername, camera_user: f.cameraUser, web_ui_url: f.webUiUrl, web_ui_note: f.webUiNote, notes: f.notes,
        created_at: now, updated_at: now,
      });
      this.log(actor, action, accountId, 'camera', id, f.camsId, { kind: f.kind, ...(f.proxyId ? { proxyId: f.proxyId, proxyCameraId: f.proxyCameraId } : {}) });
      return this.getCamera(accountId, id);
    }));
  }

  getCamera(accountId: string, id: string): Camera {
    const r = this.one('SELECT * FROM cameras WHERE id = ? AND account_id = ?', id, accountId);
    const s = this.db.prepare('SELECT * FROM sims WHERE camera_id = ?').get(id) as Row | undefined;
    return toCamera(r, s ? toSim(s) : null);
  }

  listCameras(accountId?: string): Camera[] {
    const rows = (accountId === undefined
      ? this.db.prepare('SELECT * FROM cameras ORDER BY cams_id').all()
      : this.db.prepare('SELECT * FROM cameras WHERE account_id = ? ORDER BY cams_id').all(accountId)) as Row[];
    const sims = new Map((this.db.prepare('SELECT * FROM sims').all() as Row[]).map((s) => [s.camera_id as string, toSim(s)]));
    return rows.map((r) => toCamera(r, sims.get(r.id as string) ?? null));
  }

  updateCamera(actor: string, accountId: string, id: string, patch: unknown): Camera {
    return guard(() => tx(this.db, () => {
      const f = cameraInput(patch, true);
      const old = this.getCamera(accountId, id);
      checkCameraProxy({ proxyId: f.proxyId !== undefined ? f.proxyId : old.proxyId, proxyCameraId: f.proxyCameraId !== undefined ? f.proxyCameraId : old.proxyCameraId });
      // A changed host is checked like an override host; an old free-form one doesn't block other edits.
      if (f.host && f.host !== old.host) checkCameraHost(f.host);
      const keys = this.updateRow('cameras', { id, accountId }, f, versionOf(patch as Row));
      const c = this.getCamera(accountId, id);
      this.log(actor, 'camera-update', accountId, 'camera', id, c.camsId, { fields: keys });
      return c;
    }));
  }

  deleteCamera(actor: string, accountId: string, id: string): void {
    guard(() => tx(this.db, () => {
      const c = this.getCamera(accountId, id);
      this.db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
      this.log(actor, 'camera-delete', accountId, 'camera', id, c.camsId);
    }));
  }

  setSim(actor: string, accountId: string, cameraId: string, input: unknown): Sim {
    return guard(() => tx(this.db, () => {
      const c = this.getCamera(accountId, cameraId);
      if (c.kind !== 'sim') throw new ApiError(400, 'not_a_sim');
      const f = simInput(input);
      this.db.prepare(`INSERT INTO sims (camera_id, runs_on, control_url, ui_url, image, notes) VALUES (?,?,?,?,?,?)
        ON CONFLICT(camera_id) DO UPDATE SET runs_on = excluded.runs_on, control_url = excluded.control_url, ui_url = excluded.ui_url, image = excluded.image, notes = excluded.notes`)
        .run(cameraId, f.runsOn, f.controlUrl, f.uiUrl, f.image, f.notes);
      this.log(actor, 'sim-update', accountId, 'camera', cameraId, c.camsId, { runsOn: f.runsOn });
      return this.getCamera(accountId, cameraId).sim!;
    }));
  }

  deleteSim(actor: string, accountId: string, cameraId: string): void {
    guard(() => tx(this.db, () => {
      const c = this.getCamera(accountId, cameraId);
      if (!c.sim) throw notFound();
      this.db.prepare('DELETE FROM sims WHERE camera_id = ?').run(cameraId);
      this.log(actor, 'sim-delete', accountId, 'camera', cameraId, c.camsId);
    }));
  }
}

function normaliseEmailOr400(email: string): string {
  try {
    return normaliseEmail(email);
  } catch {
    throw new ApiError(400, 'invalid', 'email');
  }
}
