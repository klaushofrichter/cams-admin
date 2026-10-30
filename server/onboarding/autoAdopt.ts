// Auto-adopt per account (cam-proxy onboarding design §5): off by default, switched only with a sign-in
// (PATCH /accounts/:accountId). After each heartbeat of an enrolled proxy of such an account, a camera the proxy
// reports, that the registry lacks and whose reported onboarding is ready, is adopted as the proxy page's "Add to
// account" button would (host from-proxy, model and name from the report), audited camera-adopt by the system.
// Never: on a proxy that is source or target of an open move (the camera would exist twice), a camera deleted
// from the registry or moved off this proxy (adopt_blocks; a manual adopt lifts that). A failing adopt (the cams
// id taken, a name the registry refuses) is audited once per (proxy, camera) and process run, and tried again
// only after the camera stopped being reported or ready. Never throws into the heartbeat.
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Camera, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import { reconcile } from '../status/derive';
import { FieldError } from '../validate';

export const AUTO_ADOPT_ACTOR = 'system:auto-adopt';

export class AutoAdopt {
  // proxyId → the camera refs tried and refused this process run.
  private refused = new Map<string, Set<string>>();

  constructor(private d: { db: Db; registry: Registry; status: StatusStore; audit: Audit; live: LiveHub; log?: Logger }) {}

  onHeartbeat(proxyId: string): Camera[] {
    try {
      return this.run(proxyId);
    } catch (e) {
      this.d.log?.warn({ proxyId, err: (e as Error).message }, 'auto_adopt_failed');
      return [];
    }
  }

  private run(proxyId: string): Camera[] {
    const px = this.d.registry.proxyById(proxyId);
    const row = this.d.status.row(proxyId);
    const onboarding = row?.reported?.onboarding ?? null;
    const refused = this.refused.get(proxyId);
    // Forget refusals of cameras no longer reported ready (the next ready report is a new attempt).
    if (refused) for (const ref of [...refused]) if (onboarding?.[ref]?.ready !== true) refused.delete(ref);
    if (!px || px.state !== 'enrolled' || !onboarding) return [];
    if (!this.d.registry.getAccount(px.accountId).autoAdopt) return [];
    if (this.d.db.prepare('SELECT 1 FROM moves WHERE ended_at IS NULL AND (source_proxy_id = ? OR target_proxy_id = ?) LIMIT 1').get(proxyId, proxyId)) return [];
    const accCams = this.d.registry.listCameras(px.accountId);
    const todo = reconcile(px, accCams.filter((c) => c.proxyId === proxyId), new Set(accCams.map((c) => c.camsId)), row)
      .reportedNotRegistered.filter((c) => onboarding[c.ref]?.ready === true && !refused?.has(c.ref) && !this.d.registry.isAdoptBlocked(proxyId, c.ref));
    const out: Camera[] = [];
    for (const c of todo) {
      const rep = row?.reported?.cameras.find((x) => x.ref === c.ref);
      try {
        const cam = this.d.registry.createCamera(AUTO_ADOPT_ACTOR, px.accountId, {
          camsId: c.proposedCamsId, name: rep?.name ?? c.ref, kind: 'camera', proxyId, proxyCameraId: c.ref, model: rep?.model ?? null, host: 'from-proxy',
        }, 'camera-adopt', 'system');
        this.d.live.publishRegistry('camera', cam.id);
        out.push(cam);
      } catch (e) {
        if (!(e instanceof ApiError) && !(e instanceof FieldError)) throw e;
        const reason = e instanceof ApiError ? e.code : e.field;
        this.d.audit.write({
          actorType: 'system', actor: AUTO_ADOPT_ACTOR, action: 'camera-adopt', accountId: px.accountId, targetType: 'camera', targetId: null, targetLabel: c.ref, outcome: 'refused',
          detail: { proxyId, proxyCameraId: c.ref, reason },
        });
        if (!this.refused.has(proxyId)) this.refused.set(proxyId, new Set());
        this.refused.get(proxyId)!.add(c.ref);
      }
    }
    return out;
  }
}
