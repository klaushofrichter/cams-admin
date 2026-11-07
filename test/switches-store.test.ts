import { beforeEach, describe, expect, it } from 'vitest';
import { SwitchStore, type CameraPower } from '../server/switches/store';
import { ApiError } from '../server/registry';
import { tmpDir } from './helpers/tmp';
import { ACTOR, makeRegistry } from './helpers/registry';

describe('switch records and camera power', () => {
  const dir = tmpDir();
  let r: ReturnType<typeof makeRegistry>;
  let st: SwitchStore;
  let acc: { id: string }, prx: { id: string }, prx2: { id: string };
  const actions = () => (r.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((x) => x.action);
  const sw = (name = 'GPS-208', extra: Record<string, unknown> = {}) =>
    st.createSwitch(ACTOR, acc.id, { name, model: 'sscpoe-web', host: '192.168.1.217', ports: 8, offSeconds: 10, proxyId: prx.id, ...extra });
  const cam = (n: string) => r.reg.createCamera(ACTOR, acc.id, { camsId: n, name: n, kind: 'camera', host: 'from-proxy' });
  const poe = (switchId: string, port: number, verifiedAt?: number): CameraPower => ({ kind: 'poe', switchId, port, watts: 4.2, ...(verifiedAt === undefined ? {} : { verifiedAt }) });
  const power = (id: string) => r.reg.getCamera(acc.id, id).power;

  beforeEach(() => {
    r = makeRegistry(dir);
    st = new SwitchStore(r.db, r.clock, r.audit);
    acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
    prx = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
    prx2 = r.reg.createProxy(ACTOR, acc.id, { name: 'pi2', displayName: 'Pi2', runsOn: 'local-host', url: 'https://proxy2.example.net:8480' });
  });

  it('round trip: create, get, list, update, delete', () => {
    const s = sw();
    expect(s).toMatchObject({ name: 'GPS-208', model: 'sscpoe-web', host: '192.168.1.217', ports: 8, offSeconds: 10, proxyId: prx.id, state: 'pending', sn: null, firmware: null, readAt: null, survey: true });
    expect(s.id).toMatch(/^sw_/);
    expect(st.getSwitch(acc.id, s.id)).toEqual(s);
    expect(st.listSwitches(acc.id).map((x) => x.id)).toEqual([s.id]);
    const u = st.updateSwitch(ACTOR, acc.id, s.id, { state: 'active', sn: 'SN1', firmware: '1.2', readAt: 5, survey: false, offSeconds: 15 });
    expect(u).toMatchObject({ state: 'active', sn: 'SN1', firmware: '1.2', readAt: 5, survey: false, offSeconds: 15 });
    expect(st.findBySerial('SN1')?.id).toBe(s.id);
    expect(st.findBySerial('nope')).toBeNull();
    st.updateSwitch(ACTOR, acc.id, s.id, { proxyId: prx2.id });
    st.deleteSwitch(ACTOR, acc.id, s.id);
    expect(st.listSwitches(acc.id)).toEqual([]);
    expect(() => st.getSwitch(acc.id, s.id)).toThrow(ApiError);
    expect(actions().filter((a) => a.startsWith('switch-'))).toEqual(['switch-create', 'switch-update', 'switch-move', 'switch-delete']);
  });

  it('duplicate name in the account is a 409', () => {
    sw('A');
    expect(() => sw('A')).toThrow(expect.objectContaining({ status: 409, code: 'duplicate_name' }));
    const b = sw('B');
    expect(() => st.updateSwitch(ACTOR, acc.id, b.id, { name: 'A' })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('power reads unknown by default', () => {
    expect(power(cam('c1').id)).toEqual({ kind: 'unknown' });
  });

  it('setPower on a taken port moves the older camera to unknown, two audit entries', () => {
    const s = sw();
    const c1 = cam('c1'), c2 = cam('c2');
    st.setPower(c1.id, poe(s.id, 3, 100), ACTOR, 'sysadmin', 'survey');
    expect(power(c1.id)).toEqual(poe(s.id, 3, 100));
    const before = actions().length;
    st.setPower(c2.id, poe(s.id, 3, 200), ACTOR, 'sysadmin', 'verify');
    expect(power(c2.id)).toEqual(poe(s.id, 3, 200));
    expect(power(c1.id)).toEqual({ kind: 'unknown' });
    expect(actions().slice(before)).toEqual(['camera-power-set', 'camera-power-set']);
  });

  it('a record without verifiedAt is older; a newer holder keeps the port', () => {
    const s = sw();
    const c1 = cam('c1'), c2 = cam('c2');
    st.setPower(c1.id, poe(s.id, 1), ACTOR, 'sysadmin', 'a');
    st.setPower(c2.id, poe(s.id, 1, 50), ACTOR, 'sysadmin', 'b');
    expect(power(c1.id).kind).toBe('unknown');
    st.setPower(c1.id, poe(s.id, 1, 10), ACTOR, 'sysadmin', 'c');
    expect(power(c2.id)).toEqual(poe(s.id, 1, 50));
    expect(power(c1.id)).toEqual({ kind: 'unknown' });
  });

  it('adapter and unknown never occupy a port; other ports and switches are independent', () => {
    const s = sw(), s2 = sw('Two');
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(cam);
    st.setPower(a.id, { kind: 'adapter' }, ACTOR, 'sysadmin', 'x');
    st.setPower(b.id, poe(s.id, 2, 1), ACTOR, 'sysadmin', 'x');
    st.setPower(c.id, poe(s.id, 3, 1), ACTOR, 'sysadmin', 'x');
    st.setPower(d.id, { kind: 'data-only', switchId: s2.id, port: 2, verifiedAt: 1 }, ACTOR, 'sysadmin', 'x');
    expect([a, b, c, d].map((x) => power(x.id).kind)).toEqual(['adapter', 'poe', 'poe', 'data-only']);
    st.setPower(b.id, { kind: 'unknown' }, ACTOR, 'system', 'x');
    expect(power(b.id)).toEqual({ kind: 'unknown' });
  });

  it('refuses a switch of another account', () => {
    const other = r.reg.createAccount(ACTOR, { name: 'other', displayName: 'Other' });
    const s = sw();
    const oc = r.reg.createCamera(ACTOR, other.id, { camsId: 'o', name: 'o', kind: 'camera', host: 'from-proxy' });
    expect(() => st.setPower(oc.id, poe(s.id, 1, 1), ACTOR, 'sysadmin', 'x')).toThrow(ApiError);
  });

  it('camerasOnSwitch returns only that switch\'s poe and data-only cameras', () => {
    const s = sw(), s2 = sw('Two');
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(cam);
    st.setPower(a.id, poe(s.id, 1, 1), ACTOR, 'sysadmin', 'x');
    st.setPower(b.id, { kind: 'data-only', switchId: s.id, port: 2, verifiedAt: 1 }, ACTOR, 'sysadmin', 'x');
    st.setPower(c.id, poe(s2.id, 1, 1), ACTOR, 'sysadmin', 'x');
    st.setPower(d.id, { kind: 'adapter' }, ACTOR, 'sysadmin', 'x');
    expect(st.camerasOnSwitch(s.id).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(st.camerasOnSwitch(s.id)[0]).toMatchObject({ accountId: acc.id });
  });

  it('deleteSwitch sets its cameras to unknown in the same transaction', () => {
    const s = sw();
    const c = cam('c');
    st.setPower(c.id, poe(s.id, 1, 1), ACTOR, 'sysadmin', 'x');
    st.deleteSwitch(ACTOR, acc.id, s.id);
    expect(power(c.id)).toEqual({ kind: 'unknown' });
  });

  it('account delete cascades switches', () => {
    sw();
    r.reg.deleteAccount(ACTOR, acc.id, 'home');
    expect((r.db.prepare('SELECT count(*) n FROM switches').get() as { n: number }).n).toBe(0);
  });
});
