import type { Clock } from '../clock';
import { addressInfo } from '../../contract/address';
import type { Db } from '../db/open';
import { chunkCounts } from '../moves/view';
import type { Moves } from '../moves/service';
import type { Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { CamsInstances } from './instances';

// One account's fleet (contract cams-v1, `fleet-response`): what the cams MCP's
// admin tools show. Only rows of `accountId`, the caller checked the instance
// serves it. Every field is named here, nothing is spread from a row, so a new
// column can't reach an assistant: no token, hash, key or CA fingerprint, no
// other account. Reads only, live values from memory.
export interface FleetDeps { db: Db; clock: Clock; instances: CamsInstances; registry: Registry; status: StatusStore; moves: Moves }

const MAX_PROBLEMS = 20, MAX_VIEWERS = 32, MAX_HELD = 50, MAX_MOVES = 50;
const cut = (v: unknown, n: number): string | null => (typeof v === 'string' ? v.slice(0, n) : null);

function place(address: string | null | undefined) {
  const i = addressInfo(address);
  return i.href && i.scope ? { url: i.href, scope: i.scope, note: i.warning } : null;
}

interface SummaryItem { id?: unknown; label?: unknown; text?: unknown; problem?: unknown }
interface Summary { items?: SummaryItem[]; cameras?: { camera?: { id?: unknown }; items?: SummaryItem[] }[] }

// The problem items of a proxy's last summary, in its own words. `camsIdOf`: its camera ids in this account's.
function problemsOf(summary: Summary | null, camsIdOf: (ref: unknown) => string | null) {
  const item = (i: SummaryItem, camera: string | null) => ({ id: cut(i.id, 64), label: cut(i.label, 120), text: cut(i.text, 240), camera });
  const whole = (summary?.items ?? []).filter((i) => i.problem).map((i) => item(i, null));
  const perCamera = (summary?.cameras ?? []).flatMap((c) => (c.items ?? []).filter((i) => i.problem).map((i) => item(i, camsIdOf(c.camera?.id))));
  return [...whole, ...perCamera].slice(0, MAX_PROBLEMS);
}

export function accountFleet(d: FleetDeps, instanceId: string, accountId: string) {
  const proxies = d.registry.listProxies(accountId);
  const cameras = d.registry.listCameras(accountId);
  const proxyName = new Map(proxies.map((p) => [p.id, p.displayName || p.name]));
  const camera = new Map(cameras.map((c) => [c.id, c]));

  // Default-deny, as the snapshot: a proxy not routed to this instance isn't shown to it.
  const routed = new Set(d.instances.routes(instanceId).filter((r) => !r.hidden).map((r) => r.proxyId));
  const shown = proxies.filter((p) => routed.has(p.id));
  const proxyRows = shown.map((p) => {
    const v = d.status.viewOf(p);
    const own = cameras.filter((c) => c.proxyId === p.id);
    const online = new Map(v.cameras.map((c) => [c.ref, c.online]));
    return {
      name: p.name, displayName: p.displayName, state: v.state, version: v.version, ok: v.ok, problemCount: v.problemCount, reportedAt: v.lastHeartbeatAt,
      gui: place(p.adminUiUrl || p.url),
      problems: problemsOf(d.status.row(p.id)?.summary as Summary | null, (ref) => own.find((c) => c.proxyCameraId === ref)?.camsId ?? null),
      cameras: own.map((c) => ({ id: c.camsId, name: c.name, online: online.get(c.proxyCameraId ?? '') ?? null })),
    };
  });

  const viewers = d.instances.list().filter((i) => i.state === 'enrolled' && i.accounts.includes(accountId)).slice(0, MAX_VIEWERS).map((i) => {
    const rep = i.live.report;
    const ofCamera = (l: { accountId: string; camsId: string; fields: string[] }[] | undefined) => (l ?? []).filter((h) => h.accountId === accountId).map((h) => ({ camera: h.camsId, fields: [...h.fields] }));
    // A proxy outside this account is no held change of it, whatever a report says.
    const heldProxies = (rep?.heldProxies ?? []).filter((h) => h.accountId === accountId && proxyName.has(h.proxyId)).map((h) => ({ proxy: proxyName.get(h.proxyId)!, fields: [...h.fields] }));
    const held = ofCamera(rep?.held), keptOld = ofCamera(rep?.keptOld);
    return {
      name: i.name, displayName: i.displayName, thisViewer: i.id === instanceId, address: place(i.baseUrl),
      held: held.slice(0, MAX_HELD), keptOld: keptOld.slice(0, MAX_HELD), heldProxies: heldProxies.slice(0, MAX_HELD), heldTotal: held.length + keptOld.length + heldProxies.length,
    };
  });

  const moves = d.moves.store.list(accountId, MAX_MOVES).map((row) => {
    const m = d.moves.withProgress(row);
    const cam = camera.get(m.cameraId);
    return {
      id: m.id, camera: cam?.camsId ?? null, cameraName: cam?.name ?? null, source: proxyName.get(m.sourceProxyId) ?? null, target: proxyName.get(m.targetProxyId) ?? null,
      phase: m.phase, reason: cut(m.reason, 64), bytesTotal: m.bytesTotal, bytesDone: m.bytesDone, rateBps: m.rateBps, etaS: m.etaS, chunks: chunkCounts(d.moves.chunkStates(m.id)),
      createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
    };
  });

  return { v: 1, type: 'cams-fleet', accountId, generatedAt: d.clock.now(), proxies: proxyRows, notRouted: proxies.length - shown.length, viewers, moves };
}
