// Site-CA pins from the proxy's report (cam-proxy onboarding design §5): no hand copy of the proxy's /tls/ca.pem.
// A proxy whose registry row has NO pins takes its enrolled proxy's reported fingerprints on the next heartbeat
// (audit proxy-update, actor system:proxy-report). A CHANGE of existing pins is never automatic: take() (the proxy
// page's "Use the reported pins", or an ops `registry` token); the cams viewers then hold the changed proxy until
// someone confirms it there, as for a hand edit. A report is taken only as the proxy sends it in canonical form
// (1..2 entries, each SHA256: and 64 upper-case hex digits); anything else is never taken.
import { ApiError, type Proxy, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import { actorTypeOf } from '../audit';

const FP_RE = /^SHA256:[0-9A-F]{64}$/;
export const PROXY_REPORT_ACTOR = 'system:proxy-report';

export class ReportedPins {
  constructor(private d: { registry: Registry; status: StatusStore; live: LiveHub; log?: Logger }) {}

  // The proxy's reported fingerprints when they can be taken as they are; null otherwise.
  private reported(proxyId: string): string[] | null {
    const rep = this.d.status.row(proxyId)?.reported;
    if (!rep || rep.caFingerprintUnreadable) return null;
    const fps = rep.caFingerprint ?? [];
    return fps.length >= 1 && fps.length <= 2 && fps.every((f) => typeof f === 'string' && FP_RE.test(f)) ? [...fps] : null;
  }

  // After each heartbeat: only an enrolled proxy without pins; never throws into the heartbeat.
  onHeartbeat(proxyId: string): void {
    try {
      const p = this.d.registry.proxyById(proxyId);
      if (!p || p.state !== 'enrolled' || p.caFingerprints.length > 0) return;
      const fps = this.reported(proxyId);
      if (!fps) return;
      this.d.registry.setProxyPins(PROXY_REPORT_ACTOR, 'system', p.accountId, proxyId, fps, true);
      this.d.live.publishRegistry('proxy', proxyId);
    } catch (e) {
      this.d.log?.warn({ proxyId, err: (e as Error).message }, 'reported_pins_failed');
    }
  }

  // body (#126, optional): { keepPrevious?: boolean }: when the proxy reports one pin, keep the first current pin that
  // differs from it as the second one (a CA rotation: cams viewers that still meet the old CA keep working).
  take(actor: string, accountId: string, proxyId: string, body: unknown = {}): { proxy: Proxy; changed: boolean } {
    const p = this.d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
    const b = body ?? {};
    if (typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'invalid', 'body');
    for (const k of Object.keys(b)) if (k !== 'keepPrevious') throw new ApiError(400, 'invalid', k);
    const keep = (b as { keepPrevious?: unknown }).keepPrevious;
    if (keep !== undefined && typeof keep !== 'boolean') throw new ApiError(400, 'invalid', 'keepPrevious');
    const reported = this.reported(proxyId);
    if (!reported) throw new ApiError(409, 'no_reported_pins');
    // A report older than the offline limit may predate a CA rotation: never taken (#126).
    if (!this.d.status.reportFresh(proxyId)) throw new ApiError(409, 'report_stale', undefined, 'the proxy has not reported recently: wait until it is online again');
    const prev = p.caFingerprints.find((f) => f !== reported[0]);
    const fps = keep === true && reported.length === 1 && prev !== undefined ? [reported[0], prev] : reported;
    if (JSON.stringify(fps) === JSON.stringify(p.caFingerprints)) return { proxy: p, changed: false };
    const proxy = this.d.registry.setProxyPins(actor, actorTypeOf(actor), accountId, proxyId, fps, false);
    this.d.live.publishRegistry('proxy', proxyId);
    return { proxy, changed: true };
  }
}
