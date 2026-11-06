import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';

// Camera name sync (design 2026-11-06, Task 4): the camera holds its name; a
// record follows the name its proxy reports with nameSource 'camera'.
describe('registry: camera records follow the reported name', () => {
  const dir = tmpDir();

  function setup() {
    const r = makeRegistry(dir);
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    const cam = r.reg.createCamera(ACTOR, acc.id, { camsId: 'garage', name: 'Garage', kind: 'camera', proxyId: prx.id, proxyCameraId: 'cam1' });
    const synced = () => r.audit.list({ action: 'camera-name-synced' }).items;
    const rev = () => (r.db.prepare('SELECT revision FROM config_revision WHERE account_id = ?').get(acc.id) as { revision: number }).revision;
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    const log = { warn: (obj: Record<string, unknown>, msg: string) => { warnings.push({ obj, msg }); } };
    return { ...r, acc, prx, cam, synced, rev, warnings, log };
  }

  it('a reported camera name replaces the record name, with one audit entry', () => {
    const s = setup();
    const before = s.rev();
    s.clock.advance(5000);
    const changed = s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: 'Garage door', nameSource: 'camera' }]);
    expect(changed.map((c) => [c.id, c.name, c.version])).toEqual([[s.cam.id, 'Garage door', 2]]);
    const c = s.reg.getCamera(s.acc.id, s.cam.id);
    expect(c).toMatchObject({ name: 'Garage door', version: 2, updatedAt: s.clock.now() });
    const a = s.synced();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actorType: 'proxy', actor: s.prx.id, action: 'camera-name-synced', accountId: s.acc.id, targetType: 'camera', targetId: s.cam.id, targetLabel: 'garage', outcome: 'ok',
      detail: { from: 'Garage', to: 'Garage door', proxyCameraId: 'cam1' },
    });
    // The cams snapshot follows: its revision is built from config_revision (no SNAPSHOT_FORMAT bump: same shape).
    expect(s.rev()).toBeGreaterThan(before);
  });

  it('the same name again changes nothing and writes no audit', () => {
    const s = setup();
    const rep = [{ ref: 'cam1', name: 'Garage door', nameSource: 'camera' as const }];
    expect(s.reg.syncCameraNames(s.prx.id, rep)).toHaveLength(1);
    const rev = s.rev();
    expect(s.reg.syncCameraNames(s.prx.id, rep)).toEqual([]);
    expect(s.synced()).toHaveLength(1);
    expect(s.reg.getCamera(s.acc.id, s.cam.id).version).toBe(2);
    expect(s.rev()).toBe(rev);
  });

  it('a config-sourced name is ignored', () => {
    const s = setup();
    expect(s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: 'Camera 1', nameSource: 'config' }])).toEqual([]);
    expect(s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: 'Camera 1' }])).toEqual([]); // an older proxy: no nameSource
    expect(s.reg.getCamera(s.acc.id, s.cam.id)).toMatchObject({ name: 'Garage', version: 1 });
    expect(s.synced()).toEqual([]);
  });

  it('a name that breaks the camera rules is ignored and warned once', () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect(s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: 'old_name', nameSource: 'camera' }], s.log)).toEqual([]);
    expect(s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: ' padded', nameSource: 'camera' }], s.log)).toEqual([]);
    expect(s.reg.syncCameraNames(s.prx.id, [{ ref: 'cam1', name: 'x'.repeat(32), nameSource: 'camera' }], s.log)).toEqual([]);
    expect(s.reg.getCamera(s.acc.id, s.cam.id)).toMatchObject({ name: 'Garage', version: 1 });
    expect(s.synced()).toEqual([]);
    expect(s.warnings.map((w) => [w.msg, w.obj.name])).toEqual([
      ['camera_name_not_synced', 'old_name'], ['camera_name_not_synced', ' padded'], ['camera_name_not_synced', 'x'.repeat(32)],
    ]);
    expect(s.warnings[0].obj).toMatchObject({ proxyId: s.prx.id, proxyCameraId: 'cam1', problem: 'not allowed: _' });
  });

  it('two records mapped to the same proxy camera both follow', () => {
    // The table forbids this (UNIQUE (proxy_id, proxy_camera_id)), so the case
    // cannot arise; the sync still updates per row, never only the first.
    const s = setup();
    expect(() => s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'garage2', name: 'Garage 2', kind: 'camera', proxyId: s.prx.id, proxyCameraId: 'cam1' })).toThrow();
    const c2 = s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'yard', name: 'Yard', kind: 'camera', proxyId: s.prx.id, proxyCameraId: 'cam2' });
    const changed = s.reg.syncCameraNames(s.prx.id, [
      { ref: 'cam1', name: 'Garage door', nameSource: 'camera' }, { ref: 'cam2', name: 'Backyard', nameSource: 'camera' },
    ]);
    expect(changed.map((c) => [c.id, c.name]).sort()).toEqual([[s.cam.id, 'Garage door'], [c2.id, 'Backyard']].sort());
    expect(s.synced().map((a) => a.targetId).sort()).toEqual([s.cam.id, c2.id].sort());
  });

  it('cameras without a proxy are never touched', () => {
    const s = setup();
    const direct = s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'porch', name: 'Porch', kind: 'camera', host: 'porch.example.net' });
    // Another proxy reporting the same ref does not reach this proxy's camera either.
    const other = s.reg.createProxy(ACTOR, s.acc.id, { name: 'pi2', displayName: 'Pi 2', runsOn: 'local-host' });
    expect(s.reg.syncCameraNames(other.id, [{ ref: 'cam1', name: 'Elsewhere', nameSource: 'camera' }])).toEqual([]);
    expect(s.reg.getCamera(s.acc.id, direct.id)).toMatchObject({ name: 'Porch', version: 1 });
    expect(s.reg.getCamera(s.acc.id, s.cam.id)).toMatchObject({ name: 'Garage', version: 1 });
    expect(s.synced()).toEqual([]);
  });
});
