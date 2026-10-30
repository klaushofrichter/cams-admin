import { describe, expect, it } from 'vitest';
import { ApiError } from '../server/registry';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';

const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}${e.field ? ' ' + e.field : ''}` : String(e); } };

describe('registry', () => {
  const dir = tmpDir();

  it('creates, reads, updates and deletes an account, one audit record per write', () => {
    const { reg, auditCount, audit } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    expect(a).toMatchObject({ name: 'home', displayName: 'Home', version: 1 });
    expect(reg.listAccounts()[0]).toMatchObject({ id: a.id, users: 0, proxies: 0, cameras: 0, admins: 0 });
    const u = reg.updateAccount(ACTOR, a.id, { displayName: 'Home 2', version: 1 });
    expect(u.version).toBe(2);
    expect(code(() => reg.updateAccount(ACTOR, a.id, { displayName: 'x', version: 1 }))).toBe('409 conflict');
    expect(code(() => reg.createAccount(ACTOR, { name: 'home', displayName: 'Again' }))).toBe('409 duplicate_name name');
    expect(code(() => reg.deleteAccount(ACTOR, a.id, 'wrong'))).toBe('400 confirm_mismatch confirmName');
    reg.deleteAccount(ACTOR, a.id, 'home');
    expect(code(() => reg.getAccount(a.id))).toBe('404 not_found');
    expect(auditCount()).toBe(3);
    expect(audit.list({}).items.map((r) => r.action)).toEqual(['account-delete', 'account-update', 'account-create']);
    expect(audit.list({ action: 'account-update' }).items[0].detail).toEqual({ fields: ['displayName'] });
    expect(audit.list({ action: 'account-delete' }).items[0].targetLabel).toBe('home');
  });

  it('keeps one email once per account, allows it in another, and answers memberships', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const b = reg.createAccount(ACTOR, { name: 'beta', displayName: 'B' });
    reg.createUser(ACTOR, a.id, { email: 'X@example.com', role: 'admin' });
    expect(code(() => reg.createUser(ACTOR, a.id, { email: 'x@example.com', role: 'viewer' }))).toBe('409 duplicate_email email');
    const ub = reg.createUser(ACTOR, b.id, { email: 'x@example.com', role: 'viewer' });
    expect(reg.memberships('X@Example.com')).toEqual([
      { accountId: a.id, accountName: 'alpha', displayName: 'A', role: 'admin' },
      { accountId: b.id, accountName: 'beta', displayName: 'B', role: 'viewer' },
    ]);
    reg.updateUser(ACTOR, b.id, ub.id, { disabled: true, version: 1 });
    expect(reg.memberships('x@example.com').map((m) => m.accountName)).toEqual(['alpha']);
    expect(reg.usersByEmail('x@example.com')).toHaveLength(2);
    expect(reg.listAccounts().find((x) => x.id === a.id)).toMatchObject({ users: 1, admins: 1 });
  });

  it('a proxy delete keeps its cameras without a proxy', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const p = reg.createProxy(ACTOR, a.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', hostKind: 'pi' });
    expect(p).toMatchObject({ state: 'pending', caFingerprints: [] });
    expect(code(() => reg.createProxy(ACTOR, a.id, { name: 'pi', displayName: 'Again', runsOn: 'cloud' }))).toBe('409 duplicate_name name');
    const c = reg.createCamera(ACTOR, a.id, { camsId: 'garage', name: 'Garage', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1' });
    expect(code(() => reg.createCamera(ACTOR, a.id, { camsId: 'garage', name: 'Again', kind: 'camera' }))).toBe('409 duplicate_cams_id camsId');
    expect(code(() => reg.createCamera(ACTOR, a.id, { camsId: 'g2', name: 'Again', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1' }))).toBe('409 duplicate_proxy_camera proxyCameraId');
    reg.deleteProxy(ACTOR, a.id, p.id);
    expect(reg.getCamera(a.id, c.id)).toMatchObject({ proxyId: null, camsId: 'garage' });
  });

  it('refuses a camera on another account\'s proxy', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const b = reg.createAccount(ACTOR, { name: 'beta', displayName: 'B' });
    const pb = reg.createProxy(ACTOR, b.id, { name: 'pb', displayName: 'PB', runsOn: 'cloud' });
    expect(code(() => reg.createCamera(ACTOR, a.id, { camsId: 'c', name: 'C', kind: 'camera', proxyId: pb.id, proxyCameraId: 'cam1' }))).toBe('400 invalid proxyId');
  });

  it('a camera with a proxy needs the proxy camera id, also on update', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const p = reg.createProxy(ACTOR, a.id, { name: 'p', displayName: 'P', runsOn: 'cloud' });
    const c = reg.createCamera(ACTOR, a.id, { camsId: 'c', name: 'C', kind: 'camera' });
    expect(code(() => reg.updateCamera(ACTOR, a.id, c.id, { proxyId: p.id, version: 1 }))).toBe('400 invalid proxyCameraId');
    expect(reg.updateCamera(ACTOR, a.id, c.id, { proxyId: p.id, proxyCameraId: 'cam9', version: 1 })).toMatchObject({ proxyId: p.id, proxyCameraId: 'cam9', version: 2 });
  });

  it('sim details only for kind sim', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const c = reg.createCamera(ACTOR, a.id, { camsId: 'c', name: 'C', kind: 'camera' });
    const s = reg.createCamera(ACTOR, a.id, { camsId: 's', name: 'S', kind: 'sim' });
    expect(code(() => reg.setSim(ACTOR, a.id, c.id, { runsOn: 'mac' }))).toBe('400 not_a_sim');
    expect(reg.setSim(ACTOR, a.id, s.id, { runsOn: 'mac', controlUrl: 'http://127.0.0.1:29502' })).toMatchObject({ runsOn: 'mac' });
    expect(reg.getCamera(a.id, s.id).sim).toMatchObject({ runsOn: 'mac', controlUrl: 'http://127.0.0.1:29502' });
    reg.deleteSim(ACTOR, a.id, s.id);
    expect(reg.getCamera(a.id, s.id).sim).toBeNull();
  });

  it('account delete cascades and returns the proxies to disconnect', () => {
    const { reg, db } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const p = reg.createProxy(ACTOR, a.id, { name: 'p', displayName: 'P', runsOn: 'cloud' });
    reg.createUser(ACTOR, a.id, { email: 'a@example.com', role: 'viewer' });
    reg.createCamera(ACTOR, a.id, { camsId: 'c', name: 'C', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1' });
    expect(reg.deleteAccount(ACTOR, a.id, 'alpha')).toEqual({ proxyIds: [p.id] });
    for (const t of ['account_users', 'proxies', 'cameras']) expect(db.prepare(`SELECT count(*) n FROM ${t}`).get()).toEqual({ n: 0 });
  });

  it('not found across accounts', () => {
    const { reg } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'alpha', displayName: 'A' });
    const b = reg.createAccount(ACTOR, { name: 'beta', displayName: 'B' });
    const p = reg.createProxy(ACTOR, a.id, { name: 'p', displayName: 'P', runsOn: 'cloud' });
    expect(code(() => reg.getProxy(b.id, p.id))).toBe('404 not_found');
  });
});

describe('onboarding fields', () => {
  const dir = tmpDir();
  it('autoAdopt defaults to false and is set by PATCH (audit fields [\'autoAdopt\'])', () => {
    const { reg, audit } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'auto', displayName: 'Auto' });
    expect(a.autoAdopt).toBe(false);
    const u = reg.updateAccount(ACTOR, a.id, { autoAdopt: true, version: a.version });
    expect(u.autoAdopt).toBe(true);
    expect(reg.getAccount(a.id).autoAdopt).toBe(true);
    expect(audit.list({ action: 'account-update' }).items[0].detail).toEqual({ fields: ['autoAdopt'] });
    expect(code(() => reg.updateAccount(ACTOR, a.id, { autoAdopt: 'yes', version: u.version }))).toBe('400 invalid autoAdopt');
    expect(reg.listAccounts().find((x) => x.id === a.id)!.autoAdopt).toBe(true);
  });
  it('deleteCamera audit names proxyId and proxyCameraId', () => {
    const { reg, audit, db } = makeRegistry(dir);
    const a = reg.createAccount(ACTOR, { name: 'del', displayName: 'Del' });
    const p = reg.createProxy(ACTOR, a.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    const c = reg.createCamera(ACTOR, a.id, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1', host: 'from-proxy' });
    reg.deleteCamera(ACTOR, a.id, c.id);
    expect(audit.list({ action: 'camera-delete' }).items[0].detail).toEqual({ proxyId: p.id, proxyCameraId: 'cam1' });
    expect(db.prepare('SELECT proxy_id, proxy_camera_id, reason FROM adopt_blocks').all()).toEqual([{ proxy_id: p.id, proxy_camera_id: 'cam1', reason: 'deleted' }]);
    // A camera without a proxy: no block, the audit names nulls.
    const n = reg.createCamera(ACTOR, a.id, { camsId: 'loose', name: 'Loose', kind: 'camera' });
    reg.deleteCamera(ACTOR, a.id, n.id);
    expect(audit.list({ action: 'camera-delete' }).items[0].detail).toEqual({ proxyId: null, proxyCameraId: null });
    expect(db.prepare('SELECT count(*) n FROM adopt_blocks').get()).toEqual({ n: 1 });
  });
});
