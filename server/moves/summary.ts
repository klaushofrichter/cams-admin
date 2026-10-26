import type { Clock } from '../clock';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { CommandRow, Commands } from '../commands/service';
import { validateResultPayload } from '../contract';
import { PROXY_UPDATE_SINCE } from './types';
import type { SpaceCheck } from './space';

// The content summary before a move (the Start move form): move.summary to the camera's proxy (read only, entry
// move.send), and the answer within a short wait. Until now cams-admin first learned the content when the source
// sent move.request. With a target the space figures against its reported profile are added (the same check as
// at request time: never a refusal). The summary is kept in memory for a short while, and asks for the same camera
// while one is on its way share its command, so choosing targets one after another sends one command.

export const SUMMARY_WAIT_MS = 15_000;
export const SUMMARY_KEEP_MS = 30_000;
// What an older proxy answers for a command it does not know (check order step 8), or args it can't read.
const OLD_PROXY_CODES = new Set(['not_allowed', 'not_implemented', 'unsupported_version', 'invalid_args']);
const ID_MAX = 64;

export interface SummaryDeps {
  clock: Clock; registry: Registry; status: StatusStore; commands: Commands; waitMs?: number;
  spaceFor: (targetProxyId: string, summary: unknown) => SpaceCheck | null;
}
export interface SummaryAnswer {
  cameraId: string; proxyId: string; at: number; summary: Record<string, unknown>;
  target: { proxyId: string; name: string; profile: boolean } | null; space: SpaceCheck | null;
}
// A refusal with a body of its own (the route answers it as is).
export class SummaryRefused extends Error {
  constructor(readonly status: number, readonly body: { error: string; detail?: string; field?: string }) {
    super(body.error);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class MoveSummaries {
  private kept = new Map<string, { at: number; summary: Record<string, unknown> }>();
  private inflight = new Map<string, Promise<Record<string, unknown>>>();
  constructor(private d: SummaryDeps) {}

  async get(actor: string, accountId: string, cameraId: string, body: unknown): Promise<SummaryAnswer> {
    const b = isObj(body) ? body : {};
    const t = b.targetProxyId;
    if (t !== undefined && t !== null && (typeof t !== 'string' || t.length === 0 || t.length > ID_MAX)) throw new ApiError(400, 'invalid', 'targetProxyId');
    const cam = this.d.registry.getCamera(accountId, cameraId); // 404 for another account's camera
    let target: SummaryAnswer['target'] = null;
    if (typeof t === 'string') {
      const px = this.d.registry.proxyById(t);
      if (!px || px.accountId !== accountId) throw new SummaryRefused(404, { error: 'not_found', field: 'targetProxyId' });
      target = { proxyId: px.id, name: px.name, profile: !!this.d.status.row(px.id)?.reported?.profile };
    }
    if (!cam.proxyId || !cam.proxyCameraId) throw new SummaryRefused(409, { error: 'camera_not_on_proxy' });
    const summary = await this.summaryOf(actor, accountId, cam.id, cam.proxyId, cam.proxyCameraId);
    const kept = this.kept.get(cam.id)!;
    return { cameraId: cam.id, proxyId: cam.proxyId, at: kept.at, summary, target, space: target ? this.d.spaceFor(target.proxyId, summary) : null };
  }

  private summaryOf(actor: string, accountId: string, cameraId: string, proxyId: string, proxyCameraId: string): Promise<Record<string, unknown>> {
    const now = this.d.clock.now();
    const k = this.kept.get(cameraId);
    if (k && now - k.at < SUMMARY_KEEP_MS) return Promise.resolve(k.summary);
    const open = this.inflight.get(cameraId);
    if (open) return open;
    const p = this.ask(actor, accountId, cameraId, proxyId, proxyCameraId).finally(() => this.inflight.delete(cameraId));
    this.inflight.set(cameraId, p);
    return p;
  }

  private async ask(actor: string, accountId: string, cameraId: string, proxyId: string, proxyCameraId: string): Promise<Record<string, unknown>> {
    if (this.d.status.row(proxyId)?.connected !== true) throw new SummaryRefused(409, { error: 'source_offline' });
    // Commands.create refuses (409) a proxy without commands, paused, or without move.send; 429 over its rate.
    const cmd = this.d.commands.create(actor, accountId, proxyId, 'move.summary', { v: 1, camera: proxyCameraId });
    const fin = await this.d.commands.waitFinal(cmd.id, this.d.waitMs ?? SUMMARY_WAIT_MS);
    const summary = this.read(fin);
    // A done answer only; the clock again (the wait took time).
    this.kept.set(cameraId, { at: this.d.clock.now(), summary });
    for (const [id, v] of this.kept) if (this.d.clock.now() - v.at >= SUMMARY_KEEP_MS) this.kept.delete(id);
    return summary;
  }

  private read(fin: CommandRow | null): Record<string, unknown> {
    if (!fin) throw new SummaryRefused(504, { error: 'timeout', detail: 'the proxy did not answer in time' });
    if (fin.state === 'done') {
      const summary = isObj(fin.result) ? fin.result.summary : undefined;
      if (!validateResultPayload('move.summary', fin.result) || !isObj(summary)) throw new SummaryRefused(502, { error: 'bad_result' });
      return summary;
    }
    const code = fin.outcomeCode ?? '';
    if (fin.state === 'refused' && OLD_PROXY_CODES.has(code)) throw new SummaryRefused(424, { error: 'proxy_update_needed', detail: `the proxy needs cam-proxy ${PROXY_UPDATE_SINCE} or later` });
    if (fin.state === 'refused' && code === 'paused') throw new SummaryRefused(409, { error: 'paused_on_proxy' });
    if (fin.state === 'refused' && code === 'rate_limited') throw new SummaryRefused(429, { error: 'rate_limited' });
    if (fin.state === 'refused' && code === 'busy') throw new SummaryRefused(409, { error: 'busy' });
    if (fin.state === 'failed' && code === 'unknown_camera') throw new SummaryRefused(409, { error: 'unknown_camera' });
    if (fin.state === 'expired' || fin.state === 'unknown') throw new SummaryRefused(504, { error: 'timeout', detail: 'the proxy did not answer in time' });
    throw new SummaryRefused(502, { error: 'proxy_failed', ...(code ? { detail: code } : {}) });
  }
}
