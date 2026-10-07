import { beforeEach, describe, expect, it } from 'vitest';
import { readEpoch } from '../server/db/open';
import { CamsInstances } from '../server/cams/instances';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';

const FP = 'SHA256:' + 'AB'.repeat(32);

describe('cams instances (P4)', () => {
  const dir = tmpDir();
  let r: ReturnType<typeof makeRegistry>;
  let inst: CamsInstances;
  let revoked: string[];
  let scopes: unknown[];
  let home: { id: string }, beta: { id: string };
  let piProxy: { id: string }, clusterProxy: { id: string }, otherAccountProxy: { id: string };
  const auditActions = () => (r.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((x) => x.action);
  const make = () => inst.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [home.id] });

  beforeEach(() => {
    r = makeRegistry(dir);
    revoked = [];
    scopes = [];
    inst = new CamsInstances({
      db: r.db, clock: r.clock, audit: r.audit, registry: r.reg, cfg: { publicUrl: 'https://admin.example.org', enrollCodeDefaultH: 24 },
      serverKeys: ['pk'], serverKeyFingerprints: [FP], onRevoke: (id, _actor, scope) => { revoked.push(id); scopes.push(scope); },
    });
    home = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    beta = r.reg.createAccount(ACTOR, { name: 'beta', displayName: 'Beta' });
    piProxy = r.reg.createProxy(ACTOR, home.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
    clusterProxy = r.reg.createProxy(ACTOR, home.id, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster' });
    otherAccountProxy = r.reg.createProxy(ACTOR, beta.id, { name: 'b1', displayName: 'B1', runsOn: 'cloud' });
  });

  it('create: name rules, served accounts must exist, one audit record', () => {
    const before = r.auditCount();
    const i = make();
    expect(i).toMatchObject({ state: 'pending', accounts: [home.id], name: 'cluster', displayName: 'Cluster', baseUrl: null, rotateBefore: null, version: 1 });
    expect(i.id).toMatch(/^cms_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(r.auditCount() - before).toBe(1);
    expect(() => inst.create(ACTOR, { name: 'Bad Name', displayName: 'x', accounts: [] })).toThrow(expect.objectContaining({ status: 400, field: 'name' }));
    expect(() => inst.create(ACTOR, { name: 'x', displayName: 'x', accounts: ['acc_NOPE'] })).toThrow(expect.objectContaining({ status: 400, field: 'accounts' }));
    expect(() => inst.create(ACTOR, { name: 'x', displayName: 'x', accounts: [home.id, home.id] })).toThrow(expect.objectContaining({ status: 400, field: 'accounts' }));
    expect(() => inst.create(ACTOR, { name: 'x', displayName: 'x', accounts: [], baseUrl: 'ftp://x' })).toThrow(expect.objectContaining({ status: 400, field: 'baseUrl' }));
    expect(() => make()).toThrow(expect.objectContaining({ status: 409, code: 'duplicate_name' }));
    expect(auditActions()).toContain('cams-instance-create');
  });

  it('update: version check; served accounts replaced as a whole; the version bumps', () => {
    const i = make();
    const u = inst.update(ACTOR, i.id, { accounts: [beta.id, home.id], version: 1 });
    expect([...u.accounts].sort()).toEqual([beta.id, home.id].sort());
    expect(u.version).toBe(2);
    expect(inst.servedAccountIds(i.id).sort()).toEqual([beta.id, home.id].sort());
    expect(() => inst.update(ACTOR, i.id, { displayName: 'X', version: 1 })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => inst.update(ACTOR, 'cms_NOPE', { displayName: 'X', version: 1 })).toThrow(expect.objectContaining({ status: 404 }));
    expect(auditActions().filter((a) => a === 'cams-instance-update')).toHaveLength(1);
  });

  it('a route only for a proxy of a served account; url rules as proxy urls; no url = the registered URL', () => {
    const i = make();
    expect(() => inst.setRoute(ACTOR, i.id, otherAccountProxy.id, { url: 'http://127.0.0.1:8480', hidden: false })).toThrow(expect.objectContaining({ status: 404 }));
    expect(inst.setRoute(ACTOR, i.id, piProxy.id, { url: 'http://127.0.0.1:8480', hidden: false })).toMatchObject({ url: 'http://127.0.0.1:8480', hidden: false, accountId: home.id });
    expect(() => inst.setRoute(ACTOR, i.id, piProxy.id, { url: 'ftp://x', hidden: false })).toThrow(expect.objectContaining({ field: 'url' }));
    expect(inst.setRoute(ACTOR, i.id, piProxy.id, { url: null, hidden: false })).toMatchObject({ url: null, hidden: false }); // the registered URL
    expect(inst.setRoute(ACTOR, i.id, clusterProxy.id, { url: null, hidden: true })).toMatchObject({ hidden: true, url: null });
    expect(inst.routes(i.id).map((x) => x.proxyId).sort()).toEqual([piProxy.id, clusterProxy.id].sort());
    inst.deleteRoute(ACTOR, i.id, piProxy.id);
    expect(() => inst.deleteRoute(ACTOR, i.id, piProxy.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(auditActions().filter((a) => a === 'route-update')).toHaveLength(4);
  });

  it('codes: shown once (CAC1-…), hash stored, a new code cancels the live one, commands name the cluster and the Pi forms', () => {
    const i = make();
    const c = inst.createCode(ACTOR, i.id, 24);
    expect(c.code).toMatch(/^CAC1-/);
    expect(c.serverKeyFingerprints).toEqual([FP]);
    expect(JSON.stringify(r.db.prepare('SELECT * FROM cams_enrollment_codes').all())).not.toContain(c.code);
    expect(JSON.stringify(r.db.prepare('SELECT * FROM audit_log').all())).not.toContain(c.code);
    expect(c.command.cluster).toBe('kubectl exec -i -n cams <cams pod> -- node dist/server/cli.js admin-enroll --url <CAMS_ADMIN_URL>');
    expect(c.command.pi).toBe('docker compose exec -T cams node dist/server/cli.js admin-enroll --url https://admin.example.org');
    const c2 = inst.createCode(ACTOR, i.id, undefined);
    expect(r.db.prepare('SELECT count(*) n FROM cams_enrollment_codes WHERE used_at IS NULL AND cancelled_at IS NULL').get()).toEqual({ n: 1 });
    expect(() => inst.createCode(ACTOR, i.id, 5)).toThrow(expect.objectContaining({ field: 'lifetimeH' }));
    inst.cancelCode(ACTOR, i.id, c2.id);
    expect(() => inst.cancelCode(ACTOR, i.id, c2.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('block and delete revoke the keys and call onRevoke once (R4-19)', () => {
    const i = make();
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000001', ?, 'pk1', 'fp', 1, 1)`).run(i.id);
    inst.createCode(ACTOR, i.id, 1);
    const b = inst.block(ACTOR, i.id);
    expect(b.state).toBe('revoked');
    expect(revoked).toEqual([i.id]);
    expect(inst.keys(i.id)[0]).toMatchObject({ revokedReason: 'blocked' });
    expect(r.db.prepare('SELECT count(*) n FROM cams_enrollment_codes WHERE cancelled_at IS NULL').get()).toEqual({ n: 0 });
    expect(() => inst.createCode(ACTOR, i.id, 1)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => inst.remove(ACTOR, i.id, 'wrong')).toThrow(expect.objectContaining({ field: 'confirmName' }));
    inst.remove(ACTOR, i.id, 'cluster');
    expect(revoked).toEqual([i.id, i.id]);
    expect(() => inst.get(i.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(auditActions()).toEqual(expect.arrayContaining(['cams-instance-block', 'cams-instance-delete']));
  });

  it('revokeKey: once, audited; keys never carry the public key', () => {
    const i = make();
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000001', ?, 'pk1', 'fp', 1, 1)`).run(i.id);
    expect(inst.revokeKey(ACTOR, i.id, 'key_00000000000000000001')).toMatchObject({ revokedReason: 'admin' });
    expect(() => inst.revokeKey(ACTOR, i.id, 'key_00000000000000000001')).toThrow(expect.objectContaining({ status: 409 }));
    expect(JSON.stringify(inst.keys(i.id))).not.toContain('pk1');
    expect(inst.list()[0].activeKey).toBeNull();
  });

  it('rotateNow sets rotateBefore and bumps the instance version', () => {
    const i = make();
    const x = inst.rotateNow(ACTOR, i.id);
    expect(x).toMatchObject({ rotateBefore: r.clock.now(), version: 2 });
    expect(auditActions()).toContain('cams-rotate');
  });

  it('touch() never writes the database; live() defaults to nothing seen', () => {
    const i = make();
    expect(inst.live(i.id)).toEqual({ lastSeenAt: null, lastPullAt: null, lastPullStatus: null, report: null, reportAt: null, shadowZeroSince: null });
    const e = readEpoch(r.db);
    inst.touch(i.id, { lastPullAt: 1 });
    expect(readEpoch(r.db)).toBe(e);
    expect(inst.list()[0].live.lastPullAt).toBe(1);
  });

  it('revoking a key revokes every token the instance holds, at once (review I3)', () => {
    const i = make();
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000001', ?, 'pk1', 'fp', 1, 1)`).run(i.id);
    inst.revokeKey(ACTOR, i.id, 'key_00000000000000000001');
    expect(revoked).toEqual([i.id]);
    expect(scopes).toEqual([undefined]); // all of them
  });

  it('a re-enrollment whose new key replaces the active one revokes the old key\'s tokens; a first enrollment revokes nothing (review I3)', () => {
    const i = make();
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at) VALUES ('key_00000000000000000001', ?, 'pk1', 'fp', 1)`).run(i.id);
    expect(inst.confirmKey(i.id, 'key_00000000000000000001')).toBe(true);
    expect(revoked).toEqual([]);
    r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at) VALUES ('key_00000000000000000002', ?, 'pk2', 'fp', 2)`).run(i.id);
    expect(inst.confirmKey(i.id, 'key_00000000000000000002')).toBe(true);
    expect(revoked).toEqual([i.id]);
  });
});
