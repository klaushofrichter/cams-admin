// One onboarding view per camera (cam-proxy onboarding design §5): the proxy's onboarding status, the registry
// row and each viewer's state for that camera, with what is still missing. Named fields only.
import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { onboardingView } from '../server/onboarding/view';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());
const deps = () => ({ ...a, serverKeyFingerprints: [a.signing.fingerprint] });
const ACTOR = 'admin@example.com';
const REPORT = { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], heldProxies: [], keptOld: [], shadow: null, tokens: { managed: 1, pending: 0, legacy: 0 }, problems: [] };
let n = 0;

// An account, an enrolled online proxy reporting `onboarding`, optionally the camera registered and a viewer.
function setup(o: { onboarding?: unknown; register?: boolean; viewer?: 'applied' | 'stale' | 'none' | 'hidden'; report?: Record<string, unknown> } = {}) {
  const i = n++;
  const acc = a.registry.createAccount(ACTOR, { name: `ov${i}`, displayName: 'OV' }).id;
  const px = a.registry.createProxy(ACTOR, acc, { name: `ovp${i}`, displayName: 'P', runsOn: 'local-host' }).id;
  a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(px);
  a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, 'fp', 1, 1)`).run(`key_ov${String(i).padStart(18, '0')}`, px, `pk${px}`);
  const hb = (onboarding: unknown) => {
    a.status.hello(px, 'v2', Date.now(), ['status', 'commands']);
    a.status.heartbeat(px, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['camera.onboarding.get', 'camera.action:camera-ftp-setup'], seenWindow: 1000 } }, truncated: false, ...(onboarding === undefined ? {} : { onboarding }) }, Date.now());
  };
  hb('onboarding' in o ? o.onboarding : { cam1: { ready: true, missing: [] } });
  const cam = o.register === false ? null : a.registry.createCamera(ACTOR, acc, { camsId: `ovcam${i}`, name: 'Porch', kind: 'camera', proxyId: px, proxyCameraId: 'cam1', host: 'from-proxy', model: 'RLC-1224A' });
  let inst: string | null = null;
  if (o.viewer) {
    inst = a.camsInstances.create(ACTOR, { name: `ovc${i}`, displayName: 'Viewer', accounts: [acc] }).id;
    a.db.prepare(`UPDATE cams_instances SET state = 'enrolled' WHERE id = ?`).run(inst);
    a.camsInstances.setRoute(ACTOR, inst, px, { url: null, hidden: o.viewer === 'hidden' });
    if (o.viewer !== 'none') {
      const { revision } = a.camsInstances.report(inst, { ...REPORT, ...o.report }, Date.now());
      if (o.viewer === 'applied' || o.viewer === 'hidden') a.camsInstances.report(inst, { ...REPORT, ...o.report, appliedRevision: revision }, Date.now());
    }
  }
  return { acc, px, cam, inst, hb, camsId: `ovcam${i}`, name: `ovc${i}` };
}

describe('onboarding view', () => {
  it('a registered, ready camera with one viewer that applied the current revision is ready', () => {
    const s = setup({ viewer: 'applied' });
    const v = onboardingView(deps(), s.acc, s.px, 'cam1');
    expect(v).toMatchObject({
      ready: true, missing: [], optional: [], proxyCameraId: 'cam1', online: true, reported: { ready: true, missing: [] },
      camera: { id: s.cam!.id, accountId: s.acc, camsId: s.camsId, name: 'Porch', kind: 'camera', model: 'RLC-1224A', proxyCameraId: 'cam1', host: 'from-proxy', moveId: null },
      proxy: { id: s.px, state: 'online', connected: true, pin: 'none', commands: 'allowed', onboardingAllowed: { get: true, ftpSetup: true, timeSet: false } },
      detail: null,
    });
    expect(v.viewers).toEqual([{ instanceId: s.inst, name: s.name, state: 'enrolled', lastSeenAt: null, reportAt: expect.any(Number), hidden: false, applied: true, held: [], heldProxy: [], keptOld: [], problems: [] }]);
  });

  it('missing names each gap', () => {
    const s = setup({ onboarding: { cam1: { ready: false, missing: ['login', 'ftp'] } } });
    // The proxy stops (before the viewers report: their revision is the one after).
    a.status.bye(s.px, 'shutdown');
    // A viewer that holds this camera's host, and a hidden one that is listed but not counted.
    const inst3 = a.camsInstances.create(ACTOR, { name: `ovx${n++}`, displayName: 'Hidden', accounts: [s.acc] }).id;
    a.db.prepare(`UPDATE cams_instances SET state = 'enrolled' WHERE id = ?`).run(inst3);
    a.camsInstances.setRoute(ACTOR, inst3, s.px, { url: null, hidden: true });
    const inst2 = a.camsInstances.create(ACTOR, { name: `ovh${n++}`, displayName: 'Held', accounts: [s.acc] }).id;
    a.db.prepare(`UPDATE cams_instances SET state = 'enrolled' WHERE id = ?`).run(inst2);
    a.camsInstances.setRoute(ACTOR, inst2, s.px, { url: null, hidden: false });
    const rep2 = { ...REPORT, held: [{ accountId: s.acc, camsId: s.camsId, fields: ['host'] }], problems: [{ code: 'proxy_unreachable', accountId: s.acc, detail: 'timeout' }, { code: 'other', accountId: `acc_${'0'.repeat(20)}` }] };
    const { revision } = a.camsInstances.report(inst2, rep2, Date.now());
    a.camsInstances.report(inst2, { ...rep2, appliedRevision: revision }, Date.now());
    const v = onboardingView(deps(), s.acc, s.px, 'cam1');
    const h = v.viewers.find((x) => x.instanceId === inst2)!;
    expect(h).toMatchObject({ held: ['host'], applied: true, problems: [{ code: 'proxy_unreachable', detail: 'timeout' }] });
    expect(v.viewers.find((x) => x.instanceId === inst3)).toMatchObject({ hidden: true, applied: null });
    expect(v.missing).toEqual(['proxy-offline', 'proxy:login', `viewer:${h.name}:held`]);
    expect(v.optional).toEqual(['proxy:ftp']);
    expect(v.ready).toBe(false);
    expect(v.online).toBeNull();
  });

  it('a viewer without a report, or one not on the current revision, is a gap', () => {
    const s = setup({ viewer: 'none' });
    expect(onboardingView(deps(), s.acc, s.px, 'cam1').missing).toEqual([`viewer:${s.name}:no-report`]);
    const t = setup({ viewer: 'stale' });
    expect(onboardingView(deps(), t.acc, t.px, 'cam1').missing).toEqual([`viewer:${t.name}:not-applied`]);
  });

  it('before the adopt: camera null, missing has not-registered', () => {
    const s = setup({ register: false });
    const v = onboardingView(deps(), s.acc, s.px, 'cam1');
    expect(v.camera).toBeNull();
    expect(v.missing).toEqual(['not-registered']);
    expect(v.ready).toBe(false);
  });

  it('a proxy without onboarding: reported null, missing proxy:onboarding-unreported', () => {
    const s = setup({ onboarding: undefined });
    const v = onboardingView(deps(), s.acc, s.px, 'cam1');
    expect(v.reported).toBeNull();
    expect(v.missing).toEqual(['proxy:onboarding-unreported']);
    // A map without this camera reads the same.
    s.hb({ cam2: { ready: true, missing: [] } });
    expect(onboardingView(deps(), s.acc, s.px, 'cam1').missing).toEqual(['proxy:onboarding-unreported']);
    // Not ready for a reason the proxy does not name as a required step.
    s.hb({ cam1: { ready: false, missing: [] } });
    expect(onboardingView(deps(), s.acc, s.px, 'cam1').missing).toEqual(['proxy:not-ready']);
  });

  it('detail is the newest camera.onboarding.get of this camera', () => {
    const s = setup();
    const mk = (camera: string, result: unknown) => {
      const id = a.actions.onboardingRefresh(ACTOR, s.acc, s.px, camera).commandId;
      a.db.prepare(`UPDATE commands SET state = 'done', finished_at = ?, result = ? WHERE id = ?`).run(Date.now(), JSON.stringify({ body: { phase: 'done', status: 'ok', result } }), id);
      return id;
    };
    const status = (ready: boolean) => ({ camera: 'cam1', ready, checkedAt: 1, steps: { login: { ok: ready, detail: '' } }, trust: { mode: 'site-ca', fingerprint: null, served: null }, time: { clockOffsetMs: 0, zone: null, cameraStdOffsetMinutes: null, cameraDst: null } });
    mk('cam1', { cameras: { cam1: status(false) } });
    (a.actions as unknown as { recent: Map<string, unknown> }).recent.clear();
    const second = mk('cam1', { cameras: { cam1: status(true) } });
    mk('cam2', { cameras: { cam2: { ...status(false), camera: 'cam2' } } });
    const v = onboardingView(deps(), s.acc, s.px, 'cam1');
    expect(v.detail).toMatchObject({ cmdId: second, state: 'done', finishedAt: expect.any(Number), result: { camera: 'cam1', ready: true, steps: { login: { ok: true } } } });
  });

  it('another account\'s proxy is 404; a bad camera id 400', () => {
    const s = setup();
    const t = setup();
    expect(() => onboardingView(deps(), t.acc, s.px, 'cam1')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => onboardingView(deps(), s.acc, s.px, 'Cam 1')).toThrow(expect.objectContaining({ status: 400, code: 'invalid', field: 'camera' }));
  });

  it('the session route', async () => {
    const s = setup({ viewer: 'applied' });
    const r = await a.api('get', `/accounts/${s.acc}/proxies/${s.px}/cameras/cam1/onboarding`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ready: true, camera: { camsId: s.camsId } });
  });
});
