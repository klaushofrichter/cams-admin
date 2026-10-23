import { tx } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Proxy } from '../registry';
import type { Commands } from '../commands/service';
import type { CamsInstances } from '../cams/instances';
import { validateCommandArgs } from '../contract';
import { SITE_PATTERN } from '../../contract/build';
import { online, precheckReport, siteOf, unseen, type PrecheckDeps, type PrecheckReason, type PrecheckReport } from './precheck';
import type { MoveBounds } from './types';

// A move started from cams-admin (move.begin plan Task 3, rulings R3, A4–A10):
// the checks on the request and the source first, then the precheck. Only
// three failing rules are fixed here: `routed` (a visible route, url null, on
// each cams instance that sees the source but not the target), `site_ca` (the
// registry's empty tls_site from the proxy's own reported site; never the CA
// fingerprints or the TLS name) and `no_host_override` (the instance's host
// for the camera cleared, its camera user kept). Every check, including
// whether each fix may be made, runs before the first fix, in one transaction:
// a refused request writes nothing. A re-check that still fails after the
// fixes answers 409 and keeps them (each one is audited). Then move.begin to
// the source, which runs its own checks and emits the usual move.request.

export interface BeginInput { sourceProxyId: string; targetProxyId: string; cameraId: string; bounds: MoveBounds | null }
export type Fix = { rule: 'routed'; instanceId: string; proxyId: string } | { rule: 'site_ca'; proxyId: string; site: string } | { rule: 'no_host_override'; instanceId: string; cameraId: string };
export type BeginResult =
  | { ok: true; commandId: string; fixed: Fix[]; report: PrecheckReport }
  | { ok: false; status: 404 | 409; error: string; field?: string; reason?: PrecheckReason | null; report?: PrecheckReport; fixed?: Fix[] };
export interface BeginDeps extends PrecheckDeps { audit: Audit; commands: Commands; camsInstances: CamsInstances }

const FIXABLE = new Set(['site_ca', 'routed', 'no_host_override']);
const SITE_RE = new RegExp(SITE_PATTERN);
const ID_MAX = 64;
// Any valid proxy id: the bounds are checked with the strict move.begin args schema on their own.
const ANY_PROXY = 'prx_0123456789ABCDEFGHJK';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function beginInput(body: unknown): BeginInput {
  const b = isObj(body) ? body : {};
  const id = (k: 'sourceProxyId' | 'targetProxyId' | 'cameraId'): string => {
    const v = b[k];
    if (typeof v !== 'string' || v.length === 0 || v.length > ID_MAX) throw new ApiError(400, 'invalid', k);
    return v;
  };
  const out = { sourceProxyId: id('sourceProxyId'), targetProxyId: id('targetProxyId'), cameraId: id('cameraId') };
  if (!('bounds' in b) || !validateCommandArgs('move.begin', { v: 1, camera: 'cam1', target: ANY_PROXY, bounds: b.bounds }).ok) throw new ApiError(400, 'invalid', 'bounds');
  return { ...out, bounds: b.bounds as MoveBounds | null };
}

// A refusal before any write: thrown out of the transaction (which rolls back, not even the write epoch moves).
class Refused {
  constructor(readonly r: BeginResult) {}
}

export function begin(d: BeginDeps, actor: string, body: unknown): BeginResult {
  const input = beginInput(body);
  try {
    return tx(d.db, () => run(d, actor, input));
  } catch (e) {
    if (e instanceof Refused) return e.r;
    throw e;
  }
}

function run(d: BeginDeps, actor: string, input: BeginInput): BeginResult {
  const refuse = (r: Omit<Extract<BeginResult, { ok: false }>, 'ok'>): never => {
    throw new Refused({ ok: false, ...r });
  };
  // A4, A7: the source, the camera on it (the registry id or the cams id in the source's account), the source able to take move.begin.
  const src = d.registry.proxyById(input.sourceProxyId);
  if (!src) return refuse({ status: 404, error: 'not_found', field: 'sourceProxyId' });
  const cam = d.registry.listCameras(src.accountId).find((c) => c.id === input.cameraId || c.camsId === input.cameraId);
  if (!cam) return refuse({ status: 404, error: 'not_found', field: 'cameraId' });
  if (cam.proxyId !== src.id || !cam.proxyCameraId) return refuse({ status: 409, error: 'camera_not_on_source' });
  if (!online(d, src)) return refuse({ status: 409, error: 'source_offline' });
  const sv = d.status.viewOf(src);
  if (sv.commands !== 'allowed' || !sv.allow.includes('move.send')) return refuse({ status: 409, error: 'moves_not_allowed' });
  if (!src.url || !src.tlsServername) return refuse({ status: 409, error: 'source_registry_incomplete' });

  const cand = { accountId: src.accountId, sourceProxyId: src.id, targetProxyId: input.targetProxyId, cameraId: cam.id };
  const r1 = precheckReport(d, cand);
  const failing = new Set(r1.rules.filter((r) => !r.ok).map((r) => r.rule));
  const notFixed = () => refuse({ status: 409, error: 'precheck', reason: r1.reason, report: r1, fixed: [] });
  if ([...failing].some((r) => !FIXABLE.has(r))) return notFixed();
  // Past same_account: the target is registered in the source's account.
  const tgt = d.registry.proxyById(input.targetProxyId)!;

  // Every fix decided before the first is made.
  const fixes: Fix[] = [];
  if (failing.has('site_ca')) {
    for (const p of [src, tgt]) {
      if (siteOf(d, p)) continue;
      const reported = d.status.row(p.id)?.reported?.site ?? null;
      // A registry site that is set (and differs) is never overwritten; an unusable reported site is no fix.
      if (p.tlsSite !== null || typeof reported !== 'string' || !SITE_RE.test(reported)) return notFixed();
      fixes.push({ rule: 'site_ca', proxyId: p.id, site: reported });
    }
  }
  if (failing.has('routed')) {
    for (const instanceId of unseen(d, src.id, tgt.id)) {
      // A5: a route a sysadmin hid stays hidden.
      if (d.db.prepare('SELECT 1 FROM cams_instance_routes WHERE instance_id = ? AND proxy_id = ? AND hidden = 1').get(instanceId, tgt.id)) return notFixed();
      fixes.push({ rule: 'routed', instanceId, proxyId: tgt.id });
    }
  }
  const overrides = failing.has('no_host_override')
    ? d.db.prepare('SELECT instance_id, camera_user, version FROM cams_camera_overrides WHERE camera_id = ? AND host IS NOT NULL ORDER BY instance_id').all(cam.id) as { instance_id: string; camera_user: string | null; version: number }[]
    : [];
  for (const o of overrides) {
    // Only an instance that serves the camera's account can change its override (else setOverride answers 404).
    if (!d.db.prepare('SELECT 1 FROM cams_instance_accounts WHERE instance_id = ? AND account_id = ?').get(o.instance_id, cam.accountId)) return notFixed();
    fixes.push({ rule: 'no_host_override', instanceId: o.instance_id, cameraId: cam.id });
  }

  // The fixes, in the order site, routes, overrides; each audited (A9: by rule and ids, there is no move yet).
  const audit = (f: Fix) => {
    const { rule, ...ids } = f;
    d.audit.write({
      actorType: 'sysadmin', actor, action: 'move-fix', accountId: src.accountId, targetType: f.rule === 'site_ca' ? 'proxy' : 'cams-instance', targetId: f.rule === 'site_ca' ? f.proxyId : f.instanceId,
      outcome: 'ok', detail: { rule, source: src.id, target: tgt.id, camera: cam.camsId, ...ids },
    });
  };
  for (const f of fixes) {
    if (f.rule === 'site_ca') {
      const p = d.registry.proxyById(f.proxyId) as Proxy;
      d.registry.updateProxy(actor, p.accountId, p.id, { tlsSite: f.site, version: p.version });
    } else if (f.rule === 'routed') {
      d.camsInstances.setRoute(actor, f.instanceId, f.proxyId, { url: null, hidden: false });
    } else {
      // A6: the host goes, a camera user stays (the row deleted only when it has none).
      const o = overrides.find((x) => x.instance_id === f.instanceId)!;
      if (o.camera_user !== null) d.camsInstances.setOverride(actor, f.instanceId, f.cameraId, { host: null, cameraUser: o.camera_user, version: o.version });
      else d.camsInstances.clearOverride(actor, f.instanceId, f.cameraId);
    }
    audit(f);
  }

  const r2 = precheckReport(d, cand);
  if (!r2.ok) return { ok: false, status: 409, error: 'precheck', reason: r2.reason, report: r2, fixed: fixes };
  // An ApiError here (paused, rate limited) rolls the fixes back with it.
  const cmd = d.commands.create(actor, src.accountId, src.id, 'move.begin', { v: 1, camera: cam.proxyCameraId, target: tgt.id, bounds: input.bounds });
  d.audit.write({
    actorType: 'sysadmin', actor, action: 'move-begin', accountId: src.accountId, targetType: 'camera', targetId: cam.id, targetLabel: cam.camsId, outcome: 'ok',
    detail: { cmdId: cmd.id, source: src.id, target: tgt.id, camera: cam.camsId, bounds: input.bounds, fixed: fixes.map((f) => f.rule) },
  });
  return { ok: true, commandId: cmd.id, fixed: fixes, report: r2 };
}
