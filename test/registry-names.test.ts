import { describe, expect, it } from 'vitest';
import { ApiError } from '../server/registry';
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

  it('each camera of the proxy follows its own reported name (a second record of the same proxy camera is refused)', () => {
    // The table forbids two records of one proxy camera (UNIQUE (proxy_id, proxy_camera_id));
    // the sync updates every mapped row of the report, never only the first.
    const s = setup();
    expect(() => s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'garage2', name: 'Garage 2', kind: 'camera', proxyId: s.prx.id, proxyCameraId: 'cam1' })).toThrow();
    const c2 = s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'yard', name: 'Yard', kind: 'camera', proxyId: s.prx.id, proxyCameraId: 'cam2' });
    const changed = s.reg.syncCameraNames(s.prx.id, [
      { ref: 'cam1', name: 'Garage door', nameSource: 'camera' }, { ref: 'cam2', name: 'Backyard', nameSource: 'camera' },
    ]);
    expect(changed.map((c) => [c.id, c.name]).sort()).toEqual([[s.cam.id, 'Garage door'], [c2.id, 'Backyard']].sort());
    expect(s.synced().map((a) => a.targetId).sort()).toEqual([s.cam.id, c2.id].sort());
  });

  it('a ref reported twice in one report: the last valid name counts, one update and one audit row', () => {
    const s = setup();
    const changed = s.reg.syncCameraNames(s.prx.id, [
      { ref: 'cam1', name: 'First', nameSource: 'camera' }, { ref: 'cam1', name: 'Second', nameSource: 'camera' }, { ref: 'cam1', name: 'bad_name', nameSource: 'camera' },
    ]);
    expect(changed.map((c) => c.name)).toEqual(['Second']);
    expect(s.reg.getCamera(s.acc.id, s.cam.id)).toMatchObject({ name: 'Second', version: 2 });
    expect(s.synced()).toHaveLength(1);
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

// Task 5: the camera's name rules; a name edit of a camera behind a proxy goes to the camera.
describe('registry: camera name rules and renames at the camera', () => {
  const dir = tmpDir();
  const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof ApiError ? [e.status, e.code, e.field, e.hint] : String(e); } };

  function setup() {
    const r = makeRegistry(dir);
    const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    const prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    const mapped = r.reg.createCamera(ACTOR, acc.id, { camsId: 'garage', name: 'Garage', kind: 'camera', proxyId: prx.id, proxyCameraId: 'cam1' });
    const direct = r.reg.createCamera(ACTOR, acc.id, { camsId: 'porch', name: 'Porch', kind: 'camera', host: 'porch.example.net' });
    return { ...r, acc, prx, mapped, direct };
  }

  it.each([
    ['x'.repeat(32), 'too long: 32 characters, at most 31'],
    ['Back_yard', 'not allowed: _'],
    [' Garage', 'no leading or trailing space'],
  ])('a name that breaks the rules (%j) is refused on create and update with the reason', (name, reason) => {
    const s = setup();
    expect(code(() => s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'yard', name, kind: 'camera' }))).toEqual([400, 'invalid', 'name', reason]);
    expect(code(() => s.reg.updateCamera(ACTOR, s.acc.id, s.direct.id, { name, version: 1 }))).toEqual([400, 'invalid', 'name', reason]);
    expect(s.reg.getCamera(s.acc.id, s.direct.id)).toMatchObject({ name: 'Porch', version: 1 });
  });

  it('PATCH name of a mapped camera answers 409 rename_at_camera and changes nothing', () => {
    const s = setup();
    const before = s.audit.list({}).items.length;
    expect(code(() => s.reg.updateCamera(ACTOR, s.acc.id, s.mapped.id, { name: 'Garage door', host: 'g.example.net', notes: 'n', version: 1 }))).toEqual([
      409, 'rename_at_camera', 'name', `POST /api/v1/accounts/${s.acc.id}/proxies/${s.prx.id}/cameras/cam1/name`,
    ]);
    expect(s.reg.getCamera(s.acc.id, s.mapped.id)).toMatchObject({ name: 'Garage', host: null, notes: null, version: 1 });
    expect(s.audit.list({}).items).toHaveLength(before);
  });

  it('PATCH of a mapped camera with its current name, or without a name, works', () => {
    const s = setup();
    expect(s.reg.updateCamera(ACTOR, s.acc.id, s.mapped.id, { name: 'Garage', notes: 'n', version: 1 })).toMatchObject({ name: 'Garage', notes: 'n', version: 2 });
    expect(s.reg.updateCamera(ACTOR, s.acc.id, s.mapped.id, { notes: 'm', version: 2 })).toMatchObject({ notes: 'm', version: 3 });
  });

  it('PATCH name of an unmapped camera works (record only)', () => {
    const s = setup();
    expect(s.reg.updateCamera(ACTOR, s.acc.id, s.direct.id, { name: 'Front porch', version: 1 })).toMatchObject({ name: 'Front porch', version: 2 });
  });

  it('PATCH that unmaps a camera and renames it in one go is 409 rename_at_camera; nothing changes (unmap first, then rename)', () => {
    const s = setup();
    expect(() => s.reg.updateCamera(ACTOR, s.acc.id, s.mapped.id, { proxyId: null, proxyCameraId: null, name: 'Shed', version: 1 })).toThrow(expect.objectContaining({ status: 409, code: 'rename_at_camera' }));
    expect(s.reg.getCamera(s.acc.id, s.mapped.id)).toMatchObject({ name: 'Garage', proxyId: s.prx.id, version: 1 });
  });

  it('create with a mapping takes the typed name as a placeholder', () => {
    const s = setup();
    expect(s.reg.createCamera(ACTOR, s.acc.id, { camsId: 'yard', name: 'Yard', kind: 'camera', proxyId: s.prx.id, proxyCameraId: 'cam2' })).toMatchObject({ name: 'Yard', proxyCameraId: 'cam2' });
  });
});
