// One onboarding view per camera (cam-proxy onboarding design §5): the proxy's onboarding status (§4.5; the
// heartbeat's compact one and the newest full camera.onboarding.get), the registry row and each viewer's state
// for that camera (from the cams instances' reports: applied, held, kept old, problems), with what is still
// missing. Read-only: a GET never sends a command. Named fields only (no row spread, no notes, hashes, tokens);
// the command result passes through sanitize and the secret redaction as stored command results do.
import type { ApiDeps } from '../api/router';
import { ApiError } from '../registry';
import { snapshotRevision } from '../cams/snapshot';
import { CAMERA_ID_PATTERN, ONBOARDING_REQUIRED } from '../../contract/build';
import { sanitize } from '../contract';
import { redactSecrets } from '../config/redact';

export interface ViewerState {
  instanceId: string; name: string; state: string; lastSeenAt: number | null; reportAt: number | null;
  hidden: boolean;                  // the instance does not serve this proxy (route hidden or none)
  applied: boolean | null;          // report.appliedRevision === current revision; null without a report
  held: string[]; heldProxy: string[]; keptOld: string[];   // fields for this camsId / this proxy
  problems: { code: string; detail: string | null }[];      // the report's problems for this account (or accountId null)
}
export interface OnboardingView {
  camera: { id: string; accountId: string; camsId: string; name: string; kind: string; model: string | null; proxyCameraId: string | null; host: string | null; protocol: string | null; tlsServername: string | null; rowVersion: number; moveId: string | null } | null;
  proxy: { id: string; name: string; state: string; connected: boolean; lastHeartbeatAt: number | null; version: string | null; pin: string; commands: string; onboardingAllowed: { get: boolean; ftpSetup: boolean; timeSet: boolean } };
  proxyCameraId: string; online: boolean | null;
  reported: { ready: boolean; missing: string[] } | null;
  detail: { cmdId: string; state: string; finishedAt: number | null; result: Record<string, unknown> | null } | null;
  viewers: ViewerState[];
  ready: boolean;
  missing: string[];    // what keeps it from ready, in order
  optional: string[];   // the proxy's optional steps not done (FTP, time, name, PoE, profile, or a newer proxy's): never block ready
}

const CAM_RE = new RegExp(CAMERA_ID_PATTERN);
const REQUIRED = new Set<string>(ONBOARDING_REQUIRED);

export function onboardingView(d: ApiDeps, accountId: string, proxyId: string, proxyCameraId: string): OnboardingView {
  const px = d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
  if (typeof proxyCameraId !== 'string' || !CAM_RE.test(proxyCameraId)) throw new ApiError(400, 'invalid', 'camera');
  const v = d.status.viewOf(px);
  const row = d.status.row(px.id);
  const allow = v.allow;
  const c = d.registry.listCameras(accountId).find((x) => x.proxyId === px.id && x.proxyCameraId === proxyCameraId) ?? null;
  const moveId = c ? ((d.db.prepare('SELECT move_id FROM cameras WHERE id = ?').get(c.id) as { move_id: string | null } | undefined)?.move_id ?? null) : null;
  const onb = row?.reported?.onboarding ?? null;
  const reported = onb?.[proxyCameraId] ? { ready: onb[proxyCameraId].ready, missing: [...onb[proxyCameraId].missing] } : null;
  const latest = d.commands.latest(px.id, 'camera.onboarding.get', proxyCameraId);
  const cams = (latest?.result as { cameras?: Record<string, unknown> } | null)?.cameras;
  const res = cams && typeof cams === 'object' ? cams[proxyCameraId] : undefined;
  const detail = latest ? {
    cmdId: latest.id, state: latest.state, finishedAt: latest.finishedAt,
    // Stored results are redacted on arrival already; again here, whatever reached the row.
    result: res && typeof res === 'object' && !Array.isArray(res) ? (redactSecrets(sanitize(res)).value as Record<string, unknown>) : null,
  } : null;

  const fp = d.serverKeyFingerprints[0] ?? '';
  const viewers: ViewerState[] = d.camsInstances.list().filter((i) => i.accounts.includes(accountId)).map((i) => {
    const route = d.camsInstances.routes(i.id).find((r) => r.proxyId === px.id);
    const rep = i.live.report;
    const mine = <T extends { accountId: string }>(xs: T[] | undefined, match: (x: T) => boolean) => (xs ?? []).filter((x) => x.accountId === accountId && match(x));
    return {
      instanceId: i.id, name: i.name, state: i.state, lastSeenAt: i.live.lastSeenAt, reportAt: i.live.reportAt,
      hidden: !route || route.hidden,
      applied: rep ? rep.appliedRevision === snapshotRevision(d.db, i.id, fp) : null,
      held: c ? mine(rep?.held, (h) => h.camsId === c.camsId).flatMap((h) => h.fields) : [],
      heldProxy: mine(rep?.heldProxies, (h) => h.proxyId === px.id).flatMap((h) => h.fields),
      keptOld: c ? mine(rep?.keptOld, (h) => h.camsId === c.camsId).flatMap((h) => h.fields) : [],
      problems: (rep?.problems ?? []).filter((p) => p.accountId === accountId || p.accountId == null).map((p) => ({ code: p.code, detail: p.detail ?? null })),
    };
  });

  const missing: string[] = [];
  const optional: string[] = [];
  if (v.state !== 'online') missing.push('proxy-offline');
  if (!reported) missing.push('proxy:onboarding-unreported');
  else {
    for (const s of reported.missing) (REQUIRED.has(s) ? missing : optional).push(`proxy:${s}`);
    if (!reported.ready && !reported.missing.some((s) => REQUIRED.has(s))) missing.push('proxy:not-ready');
  }
  if (!c) missing.push('not-registered');
  for (const w of viewers) {
    if (w.state !== 'enrolled' || w.hidden) continue;
    if (w.applied === null) { missing.push(`viewer:${w.name}:no-report`); continue; }
    if (!w.applied) missing.push(`viewer:${w.name}:not-applied`);
    if (w.held.length || w.heldProxy.length) missing.push(`viewer:${w.name}:held`);
    if (w.keptOld.length) missing.push(`viewer:${w.name}:kept-old`);
  }

  return {
    camera: c && {
      id: c.id, accountId: c.accountId, camsId: c.camsId, name: c.name, kind: c.kind, model: c.model, proxyCameraId: c.proxyCameraId, host: c.host, protocol: c.protocol,
      tlsServername: c.tlsServername, rowVersion: c.version, moveId,
    },
    proxy: {
      id: px.id, name: px.name, state: v.state, connected: v.connected, lastHeartbeatAt: v.lastHeartbeatAt, version: v.version, pin: v.pin, commands: v.commands,
      onboardingAllowed: { get: allow.includes('camera.onboarding.get'), ftpSetup: allow.includes('camera.action:camera-ftp-setup'), timeSet: allow.includes('camera.action:camera-time-set') },
    },
    proxyCameraId, online: v.cameras.find((x) => x.ref === proxyCameraId)?.online ?? null,
    reported, detail, viewers,
    ready: missing.length === 0 && reported?.ready === true,
    missing, optional,
  };
}

// By a cams id or a registry id (cam_…); a cams id in several accounts is 409 ambiguous unless accountId names one.
export function onboardingByCamsId(d: ApiDeps, idOrCamsId: string, accountId?: string): OnboardingView {
  const all = d.registry.listCameras(accountId).filter((c) => c.id === idOrCamsId || c.camsId === idOrCamsId);
  if (all.length === 0) throw new ApiError(404, 'not_found');
  if (all.length > 1) throw new ApiError(409, 'ambiguous');
  const c = all[0];
  if (!c.proxyId || !c.proxyCameraId) throw new ApiError(409, 'no_proxy');
  return onboardingView(d, c.accountId, c.proxyId, c.proxyCameraId);
}
