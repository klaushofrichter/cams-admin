// Auto-adopt per account (cam-proxy onboarding design §5): off by default; a camera a proxy reports, that the
// registry lacks and whose reported onboarding is ready, is adopted by the system. Never a second camera during a
// move, never what was deleted or moved away (adopt blocks), one refusal audit per failing camera.
import { describe, expect, it } from 'vitest';
import { makeRegistry, ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { StatusStore } from '../server/status/store';
import { LiveHub } from '../server/live';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { AutoAdopt, AUTO_ADOPT_ACTOR } from '../server/onboarding/autoAdopt';

const dir = tmpDir();
type Onb = Record<string, { ready: boolean; missing: string[] }> | undefined;

function setup(o: { autoAdopt?: boolean } = {}) {
  const r = makeRegistry(dir);
  const live = new LiveHub({ clock: r.clock, maxPerSession: 5, keepaliveMs: 0 });
  const status = new StatusStore({ db: r.db, clock: r.clock, registry: r.reg, live, offlineAfterMs: 90_000 });
  const auto = new AutoAdopt({ db: r.db, registry: r.reg, status, audit: r.audit, live });
  status.onHeartbeat = (proxyId) => { auto.onHeartbeat(proxyId); };
  const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home', ...(o.autoAdopt === undefined ? {} : { autoAdopt: o.autoAdopt }) });
  const mkProxy = (name: string) => {
    const p = r.reg.createProxy(ACTOR, acc.id, { name, displayName: name, runsOn: 'local-host' });
    r.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(p.id);
    return p.id;
  };
  const px = mkProxy('pi');
  // makeSummary names its cameras cam1… with the model RLC-1224A.
  const hb = (proxyId: string, onboarding: Onb, cameras = 2) => status.heartbeat(proxyId, {
    summary: makeSummary({ cameras, now: r.clock.now() }), proxy: makeProxyInfo({ now: r.clock.now() }), truncated: false, ...(onboarding === undefined ? {} : { onboarding }),
  }, r.clock.now());
  const adoptAudits = () => (r.db.prepare(`SELECT actor, actor_type, outcome, detail, target_label FROM audit_log WHERE action = 'camera-adopt' ORDER BY id`).all() as { actor: string; actor_type: string; outcome: string; detail: string; target_label: string }[])
    .map((x) => ({ actor: x.actor, actorType: x.actor_type, outcome: x.outcome, detail: JSON.parse(x.detail), label: x.target_label }));
  const cams = () => r.reg.listCameras(acc.id);
  return { ...r, live, status, auto, acc: acc.id, px, mkProxy, hb, adoptAudits, cams };
}
const ready = { ready: true, missing: [] };

describe('auto-adopt', () => {
  it('off by default: a ready camera is not adopted', () => {
    const s = setup();
    expect(s.reg.getAccount(s.acc).autoAdopt).toBe(false);
    s.hb(s.px, { cam1: ready });
    expect(s.cams()).toEqual([]);
    expect(s.adoptAudits()).toEqual([]);
  });

  it('on: a ready camera is adopted (host from-proxy, model and name from the report, audit camera-adopt actorType system, actor system:auto-adopt)', () => {
    const s = setup({ autoAdopt: true });
    s.hb(s.px, { cam1: ready, cam2: { ready: false, missing: ['login'] } });
    expect(s.cams()).toHaveLength(1);
    expect(s.cams()[0]).toMatchObject({ camsId: 'cam1', name: 'Camera 1', kind: 'camera', proxyId: s.px, proxyCameraId: 'cam1', host: 'from-proxy', model: 'RLC-1224A' });
    expect(s.adoptAudits()).toEqual([{ actor: AUTO_ADOPT_ACTOR, actorType: 'system', outcome: 'ok', detail: { kind: 'camera', proxyId: s.px, proxyCameraId: 'cam1' }, label: 'cam1' }]);
    // The next heartbeat adopts nothing more.
    s.hb(s.px, { cam1: ready, cam2: { ready: false, missing: ['login'] } });
    expect(s.cams()).toHaveLength(1);
    expect(s.auto.onHeartbeat(s.px)).toEqual([]);
  });

  it('a camera that is not ready, or a proxy that sends no onboarding, is not adopted', () => {
    const s = setup({ autoAdopt: true });
    s.hb(s.px, { cam1: { ready: false, missing: ['events'] } });
    s.hb(s.px, undefined);
    s.hb(s.px, {});
    expect(s.cams()).toEqual([]);
    // ready true with a required step missing reads not ready.
    s.hb(s.px, { cam1: { ready: true, missing: ['login'] } });
    expect(s.cams()).toEqual([]);
  });

  it('auto-adopt skips a proxy with an open move (source and target)', () => {
    const s = setup({ autoAdopt: true });
    const other = s.mkProxy('pc');
    const third = s.mkProxy('mini');
    const cam = s.reg.createCamera(ACTOR, s.acc, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: other, proxyCameraId: 'cam9', host: 'from-proxy' });
    s.db.prepare(`INSERT INTO moves (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, created_at, updated_at) VALUES ('mv_0123456789ABCDEFGHJK', ?, ?, ?, ?, 'rq_1', 'copying', 1, 1)`).run(s.acc, cam.id, other, s.px);
    // The target reports the camera before the registry switches: no second camera.
    s.hb(s.px, { cam1: ready });
    s.hb(other, { cam1: ready });
    expect(s.cams().map((c) => c.camsId)).toEqual(['porch']);
    // A proxy outside the move goes on.
    s.hb(third, { cam1: ready });
    expect(s.cams().map((c) => c.proxyId).sort()).toEqual([other, third].sort());
    // The move ends: the target's camera is adopted.
    s.db.prepare(`UPDATE moves SET ended_at = 2, phase = 'done'`).run();
    s.hb(s.px, { cam1: ready });
    expect(s.cams().filter((c) => c.proxyId === s.px)).toHaveLength(1);
  });

  it('a moved camera is blocked on its old proxy', () => {
    const s = setup({ autoAdopt: true });
    const target = s.mkProxy('pc');
    const cam = s.reg.createCamera(ACTOR, s.acc, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: s.px, proxyCameraId: 'cam1', host: 'from-proxy' });
    s.reg.moveCamera('system', s.acc, cam.id, { proxyId: target, proxyCameraId: 'cam4', tlsServername: null, moveId: 'mv_0123456789ABCDEFGHJK' });
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(true);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams()).toHaveLength(1);
    expect(s.cams()[0]).toMatchObject({ proxyId: target, proxyCameraId: 'cam4' });
  });

  it('a deleted camera is not re-adopted; a manual adopt lifts the block', () => {
    const s = setup({ autoAdopt: true });
    s.hb(s.px, { cam1: ready }, 1);
    const cam = s.cams()[0];
    s.reg.deleteCamera(ACTOR, s.acc, cam.id);
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(true);
    s.hb(s.px, { cam1: ready }, 1);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams()).toEqual([]);
    // A manual adopt (what the adopt route does) lifts it.
    const again = s.reg.createCamera(ACTOR, s.acc, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: s.px, proxyCameraId: 'cam1', host: 'from-proxy' }, 'camera-adopt');
    s.reg.liftAdoptBlock(s.px, 'cam1');
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(false);
    // A later delete blocks again.
    s.reg.deleteCamera(ACTOR, s.acc, again.id);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams()).toEqual([]);
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(true);
  });

  it('a refused auto-adopt is audited once', () => {
    const s = setup({ autoAdopt: true });
    // The cams id cam1 is taken in the account by a camera of another proxy; the proposed id is then pi-cam1, taken too.
    const other = s.mkProxy('pc');
    s.reg.createCamera(ACTOR, s.acc, { camsId: 'cam1', name: 'Other', kind: 'camera', proxyId: other, proxyCameraId: 'cam7', host: 'from-proxy' });
    s.reg.createCamera(ACTOR, s.acc, { camsId: 'pi-cam1', name: 'Other 2', kind: 'camera', proxyId: null, proxyCameraId: null });
    const before = s.adoptAudits().length;
    const epoch = () => (s.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
    for (let i = 0; i < 10; i++) s.hb(s.px, { cam1: ready }, 1);
    const refusals = s.adoptAudits().slice(before);
    expect(refusals).toEqual([{ actor: AUTO_ADOPT_ACTOR, actorType: 'system', outcome: 'refused', detail: { proxyId: s.px, proxyCameraId: 'cam1', reason: 'duplicate_cams_id' }, label: 'cam1' }]);
    expect(s.cams().filter((c) => c.proxyId === s.px)).toEqual([]);
    const n = epoch();
    s.hb(s.px, { cam1: ready }, 1);
    expect(epoch()).toBe(n);
    // Not ready, then ready again: the same refusal is not audited again.
    s.hb(s.px, { cam1: { ready: false, missing: ['stream'] } }, 1);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.adoptAudits().slice(before).filter((x) => x.outcome === 'refused')).toHaveLength(1);
    // Its state changes (the taken cams id is freed): tried again, adopted.
    s.reg.deleteCamera(ACTOR, s.acc, s.cams().find((c) => c.camsId === 'pi-cam1')!.id);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams().filter((c) => c.proxyId === s.px)).toHaveLength(1);
  });

  it('refusals of a deleted proxy or a camera no longer reported are forgotten', () => {
    const s = setup({ autoAdopt: true });
    const other = s.mkProxy('pc');
    s.reg.createCamera(ACTOR, s.acc, { camsId: 'cam1', name: 'Other', kind: 'camera', proxyId: other, proxyCameraId: 'cam7', host: 'from-proxy' });
    s.reg.createCamera(ACTOR, s.acc, { camsId: 'pi-cam1', name: 'Other 2', kind: 'camera', proxyId: null, proxyCameraId: null });
    s.hb(s.px, { cam1: ready }, 1);
    const refused = (s.auto as unknown as { refused: Map<string, Map<string, string>> }).refused;
    expect(refused.get(s.px)?.size).toBe(1);
    // The camera stops being reported: forgotten.
    s.hb(s.px, {}, 1);
    expect(refused.get(s.px)?.size ?? 0).toBe(0);
    s.hb(s.px, { cam1: ready }, 1);
    expect(refused.get(s.px)?.size).toBe(1);
    // The proxy is deleted: forgotten at the next heartbeat of any proxy.
    s.reg.deleteProxy(ACTOR, s.acc, s.px);
    s.hb(other, {}, 1);
    expect(refused.has(s.px)).toBe(false);
  });

  it('a camera reassigned by PATCH is blocked on its old proxy', () => {
    const s = setup({ autoAdopt: true });
    const other = s.mkProxy('pc');
    s.hb(s.px, { cam1: ready }, 1);
    const cam = s.cams()[0];
    // Off any proxy ("— none —"), then onto another.
    s.reg.updateCamera(ACTOR, s.acc, cam.id, { proxyId: null, proxyCameraId: null, version: cam.version });
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(true);
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams()).toHaveLength(1);
    s.reg.updateCamera(ACTOR, s.acc, cam.id, { proxyId: other, proxyCameraId: 'cam1', version: s.reg.getCamera(s.acc, cam.id).version });
    s.hb(s.px, { cam1: ready }, 1);
    expect(s.cams()).toHaveLength(1);
    // An edit that keeps the proxy writes no block.
    s.reg.updateCamera(ACTOR, s.acc, cam.id, { name: 'Renamed', version: s.reg.getCamera(s.acc, cam.id).version });
    expect(s.reg.isAdoptBlocked(other, 'cam1')).toBe(false);
  });

  it('a camera returned to its source by a cancelled move lifts the source block', () => {
    const s = setup({ autoAdopt: true });
    const target = s.mkProxy('pc');
    const cam = s.reg.createCamera(ACTOR, s.acc, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: s.px, proxyCameraId: 'cam1', host: 'from-proxy' });
    s.reg.moveCamera('system', s.acc, cam.id, { proxyId: target, proxyCameraId: 'cam4', tlsServername: null, moveId: 'mv_0123456789ABCDEFGHJK' });
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(true);
    s.reg.moveCamera('system', s.acc, cam.id, { proxyId: s.px, proxyCameraId: 'cam1', tlsServername: null, moveId: 'mv_0123456789ABCDEFGHJK' });
    expect(s.reg.isAdoptBlocked(s.px, 'cam1')).toBe(false);
    expect(s.reg.isAdoptBlocked(target, 'cam4')).toBe(true);
  });

  it('a pending proxy adopts nothing', () => {
    const s = setup({ autoAdopt: true });
    s.db.prepare(`UPDATE proxies SET state='pending' WHERE id=?`).run(s.px);
    s.hb(s.px, { cam1: ready });
    expect(s.cams()).toEqual([]);
  });
});
