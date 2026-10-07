import type { Db } from '../db/open';
import { ApiError, type Registry } from '../registry';
import type { CamsInstances } from '../cams/instances';

// The Export of M §11.6: per account and cams instance, a cameras.json for
// cams's file mode without passwords and tokens (cams needs a credentials
// file and a fresh token per proxy to use it), plus the ids and states of the
// tokens the instance holds. Hidden proxies (R4-3) and their cameras are left
// out, as in the instance's snapshot; proxy.url is the instance's route.

export interface ExportDeps { db: Db; registry: Registry; instances: CamsInstances }
export interface FileModeExport {
  cameras: Record<string, unknown>[];
  tokens: { proxyId: string; tokenId: string; kind: string; state: string }[];
  warnings: string[];
}

export function exportForInstance(d: ExportDeps, accountId: string, instanceId: string): FileModeExport {
  d.registry.getAccount(accountId);
  const inst = d.instances.get(instanceId);
  if (!inst.accounts.includes(accountId)) throw new ApiError(400, 'invalid', 'instance');
  const routes = new Map(d.instances.routes(instanceId).map((r) => [r.proxyId, r]));
  // The proxies routed to this instance (default-deny), as in its snapshot.
  const proxies = new Map(d.registry.listProxies(accountId).filter((p) => routes.has(p.id) && !routes.get(p.id)!.hidden).map((p) => [p.id, p]));
  const warnings: string[] = [];
  // The instance's own host and camera user (migration 7), as in its snapshot.
  const overrides = d.instances.overrideMap(instanceId);
  const cameras = d.registry.listCameras(accountId).filter((c) => c.kind === 'camera' || c.kind === 'sim').filter((c) => !c.proxyId || proxies.has(c.proxyId)).map((c) => {
    const o = overrides.get(c.id);
    const out: Record<string, unknown> = { id: c.camsId, name: c.name, host: o?.host ?? c.host ?? '', protocol: c.protocol ?? 'https', user: o?.cameraUser ?? c.cameraUser ?? '' };
    if (c.tlsServername) out.tlsServername = c.tlsServername;
    if (c.webUiUrl !== null) out.webUiUrl = c.webUiUrl;
    if (c.webUiNote) out.webUiNote = c.webUiNote;
    if (c.proxyId) {
      const p = proxies.get(c.proxyId)!;
      const url = routes.get(p.id)?.url ?? p.url;
      if (!url) warnings.push(`${c.camsId}: its proxy ${p.name} has no URL for this instance (exported without a proxy)`);
      else {
        out.proxy = {
          url, camera: c.proxyCameraId ?? c.camsId,
          ...(p.caFingerprints.length ? { caFingerprint: p.caFingerprints } : {}), ...(p.tlsServername ? { tlsServername: p.tlsServername } : {}),
        };
      }
    }
    return out;
  });
  const tokens = (d.db.prepare(`SELECT id, proxy_id, kind, state FROM proxy_tokens WHERE account_id = ? AND holder = ? AND state IN ('pending','active','retiring') ORDER BY created_at, id`)
    .all(accountId, instanceId) as { id: string; proxy_id: string; kind: string; state: string }[])
    .filter((t) => proxies.has(t.proxy_id)).map((t) => ({ proxyId: t.proxy_id, tokenId: t.id, kind: t.kind, state: t.state }));
  return { cameras, tokens, warnings };
}
