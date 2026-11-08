import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { CommandRow, Commands } from '../commands/service';
import { validateResultPayload } from '../contract';
import { REMOVE_CONTENT } from '../../contract/build';

// Remove a camera from its proxy, decommission a proxy (spec "decommission + account-move fixes" 2026-11-08, B4/B5).
// - camera.remove.preview: what the proxy holds for the camera (a read: answered within a short wait).
// - camera.remove: disruptive, typed confirm (the cams id); when the proxy answers done, the camera's record is
//   deleted (adopt block as Delete), audited camera-remove with the answer.
// - proxy.unenroll: disruptive, typed confirm (the proxy name), refused while the proxy reports cameras; when the
//   proxy answers done, the proxy's record is deleted as Delete does (keys revoked), audited proxy-unenroll.
// The record is deleted from the command's final row (Commands.onFinal), so it happens also when nobody watches
// the page; a cams-admin restart before the answer leaves the command open (a later answer still deletes).

export const PREVIEW_WAIT_MS = 15_000;
const CAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// What an older proxy answers for a command it does not know (check order step 8), or args it can't read.
const OLD_PROXY_CODES = new Set(['not_allowed', 'not_implemented', 'unsupported_version', 'invalid_args']);
export const DECOMMISSION_SINCE = 'the cam-proxy release with camera.remove';

export interface DecommissionDeps {
  db: Db; audit: Audit; registry: Registry; status: StatusStore; commands: Commands;
  connected: (proxyId: string) => boolean;
  // RemoteActions.gate: the fleet budget of disruptive commands (one proxy at a time, a few per 10 minutes).
  gate: (actor: string, accountId: string, proxyId: string, command: string) => void;
  // After a record is deleted: live registry event, switch survey upkeep, keys closed.
  onCameraRemoved?: (accountId: string, cameraId: string) => void;
  onProxyDeleted?: (accountId: string, proxyId: string, keyIds: string[]) => void;
  log?: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
  waitMs?: number;
}
export interface RemovePreview { cameraId: string; proxyId: string; camera: string; clips: number; stills: number; archivedClips: number; bytes: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

export class Decommission {
  constructor(private d: DecommissionDeps) {
    d.commands.onFinal((r) => {
      try {
        if (r.command === 'camera.remove') this.removeFinal(r);
        else if (r.command === 'proxy.unenroll') this.unenrollFinal(r);
      } catch (e) {
        d.log?.error({ err: e, cmdId: r.id }, 'decommission_final_failed');
      }
    });
  }

  // --- remove a camera ----------------------------------------------------------------------------
  private cameraOnProxy(accountId: string, cameraId: string) {
    const cam = this.d.registry.getCamera(accountId, cameraId); // 404 for another account's camera
    if (!cam.proxyId || !cam.proxyCameraId || !CAM_RE.test(cam.proxyCameraId)) throw new ApiError(409, 'camera_not_on_proxy');
    if (!this.d.connected(cam.proxyId)) throw new ApiError(409, 'proxy_offline', undefined, 'the proxy is not connected: Delete record only, and remove the camera on the proxy itself');
    return { ...cam, proxyId: cam.proxyId, proxyCameraId: cam.proxyCameraId };
  }

  async removePreview(actor: string, accountId: string, cameraId: string): Promise<RemovePreview> {
    const cam = this.cameraOnProxy(accountId, cameraId);
    const cmd = this.d.commands.create(actor, accountId, cam.proxyId, 'camera.remove.preview', { v: 1, camera: cam.proxyCameraId });
    const fin = await this.d.commands.waitFinal(cmd.id, this.d.waitMs ?? PREVIEW_WAIT_MS);
    if (!fin) throw new ApiError(504, 'timeout', undefined, 'the proxy did not answer in time');
    if (fin.state === 'done') {
      const r = fin.result as Record<string, unknown> | null;
      if (!validateResultPayload('camera.remove.preview', r) || !isObj(r)) throw new ApiError(502, 'bad_result');
      return { cameraId: cam.id, proxyId: cam.proxyId, camera: cam.proxyCameraId, clips: r.clips as number, stills: r.stills as number, archivedClips: r.archivedClips as number, bytes: r.bytes as number };
    }
    throw this.refusal(fin);
  }

  remove(actor: string, accountId: string, cameraId: string, body: unknown): { commandId: string } {
    if (!isObj(body) || !only(body, ['content', 'archive', 'confirm'])) throw new ApiError(400, 'invalid', 'body');
    const content = body.content;
    if (typeof content !== 'string' || !(REMOVE_CONTENT as readonly string[]).includes(content)) throw new ApiError(400, 'invalid', 'content');
    const archive = body.archive === undefined ? false : body.archive;
    if (typeof archive !== 'boolean' || (archive && content !== 'delete')) throw new ApiError(400, 'invalid', 'archive');
    const cam = this.cameraOnProxy(accountId, cameraId);
    if (body.confirm !== cam.camsId) throw new ApiError(400, 'confirm_required', 'confirm');
    if (this.d.db.prepare('SELECT 1 FROM moves WHERE ended_at IS NULL AND camera_id = ? LIMIT 1').get(cam.id)) throw new ApiError(409, 'move_active');
    this.d.gate(actor, accountId, cam.proxyId, 'camera.remove');
    return { commandId: this.d.commands.create(actor, accountId, cam.proxyId, 'camera.remove', { v: 1, camera: cam.proxyCameraId, content, archive }).id };
  }

  private removeFinal(r: CommandRow): void {
    const args = r.args as { camera?: unknown; content?: unknown; archive?: unknown };
    const proxyId = r.proxyId;
    const camera = typeof args.camera === 'string' ? args.camera : null;
    const row = proxyId && camera
      ? this.d.db.prepare('SELECT id, cams_id FROM cameras WHERE account_id = ? AND proxy_id = ? AND proxy_camera_id = ?').get(r.accountId, proxyId, camera) as { id: string; cams_id: string } | undefined
      : undefined;
    const base = { cmdId: r.id, proxyId, proxyCameraId: camera, content: args.content, archive: args.archive };
    if (r.state !== 'done') {
      this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'camera-remove', accountId: r.accountId, targetType: 'camera', targetId: row?.id ?? null, targetLabel: row?.cams_id ?? camera ?? '', outcome: 'failed', detail: { ...base, state: r.state, code: r.outcomeCode } });
      return;
    }
    const res = isObj(r.result) ? r.result : {};
    const answer = { removed: res.removed, leftovers: res.leftovers, deleted: res.deleted };
    if (!row) {
      // Already gone (deleted by hand meanwhile): the answer is still recorded.
      this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'camera-remove', accountId: r.accountId, targetType: 'camera', targetId: null, targetLabel: camera ?? '', outcome: 'ok', detail: { ...base, ...answer, record: 'already gone' } });
      return;
    }
    try {
      this.d.registry.deleteCamera(r.actor, r.accountId, row.id, { action: 'camera-remove', detail: { ...base, ...answer } });
    } catch (e) {
      this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'camera-remove', accountId: r.accountId, targetType: 'camera', targetId: row.id, targetLabel: row.cams_id, outcome: 'failed', detail: { ...base, ...answer, record: e instanceof ApiError ? e.code : 'error' } });
      return;
    }
    this.d.onCameraRemoved?.(r.accountId, row.id);
  }

  // --- decommission a proxy -----------------------------------------------------------------------
  // The cameras the proxy reports (its latest heartbeat): it must hold none before it unenrolls.
  reportedCameras(proxyId: string): string[] {
    return (this.d.status.row(proxyId)?.reported?.cameras ?? []).map((c) => c.ref);
  }

  unenroll(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string } {
    const px = this.d.registry.getProxy(accountId, proxyId);
    if (!isObj(body) || !only(body, ['confirm'])) throw new ApiError(400, 'invalid', 'body');
    if (body.confirm !== px.name) throw new ApiError(400, 'confirm_required', 'confirm');
    if (!this.d.connected(proxyId)) throw new ApiError(409, 'proxy_offline', undefined, 'the proxy is not connected: Delete record only, and run admin-unenroll on its host');
    const cams = this.reportedCameras(proxyId);
    if (cams.length) throw new ApiError(409, 'has_cameras', undefined, `the proxy reports ${cams.join(', ')}: remove ${cams.length > 1 ? 'them' : 'it'} first`);
    // What would stop the record's delete afterwards stops the unenroll now.
    const pre = this.d.registry.proxyDeletePreview(accountId, proxyId);
    if (pre.activeMoves) throw new ApiError(409, 'move_active');
    if (pre.switches.length) throw new ApiError(409, 'switch_operated', undefined, `operates PoE switch${pre.switches.length > 1 ? 'es' : ''} ${pre.switches.map((n) => `"${n}"`).join(', ')}: move or remove ${pre.switches.length > 1 ? 'them' : 'it'} first`);
    this.d.gate(actor, accountId, proxyId, 'proxy.unenroll');
    return { commandId: this.d.commands.create(actor, accountId, proxyId, 'proxy.unenroll', { v: 1 }).id };
  }

  private unenrollFinal(r: CommandRow): void {
    if (!r.proxyId) return;
    const px = this.d.registry.proxyById(r.proxyId);
    const label = px?.name ?? r.proxyId;
    if (r.state !== 'done') {
      this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'proxy-unenroll', accountId: r.accountId, targetType: 'proxy', targetId: r.proxyId, targetLabel: label, outcome: 'failed', detail: { cmdId: r.id, state: r.state, code: r.outcomeCode } });
      return;
    }
    const unenrollAt = isObj(r.result) && typeof r.result.unenrollAt === 'number' ? r.result.unenrollAt : null;
    this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'proxy-unenroll', accountId: r.accountId, targetType: 'proxy', targetId: r.proxyId, targetLabel: label, outcome: 'ok', detail: { cmdId: r.id, unenrollAt } });
    if (!px) return;
    try {
      const { keyIds } = this.d.registry.deleteProxy(r.actor, r.accountId, px.id);
      this.d.onProxyDeleted?.(r.accountId, px.id, keyIds);
    } catch (e) {
      this.d.log?.warn({ err: e, proxyId: px.id }, 'decommission_delete_failed');
      this.d.audit.write({ actorType: 'sysadmin', actor: r.actor, action: 'proxy-unenroll', accountId: r.accountId, targetType: 'proxy', targetId: px.id, targetLabel: label, outcome: 'failed', detail: { cmdId: r.id, record: e instanceof ApiError ? e.code : 'error' } });
    }
  }

  private refusal(fin: CommandRow): ApiError {
    const code = fin.outcomeCode ?? '';
    if (fin.state === 'refused' && OLD_PROXY_CODES.has(code)) return new ApiError(424, 'proxy_update_needed', undefined, `the proxy needs ${DECOMMISSION_SINCE}`);
    if (fin.state === 'refused' && code === 'paused') return new ApiError(409, 'paused_on_proxy');
    if (fin.state === 'refused' && code === 'rate_limited') return new ApiError(429, 'rate_limited');
    if (fin.state === 'refused' && code === 'busy') return new ApiError(409, 'busy');
    if (fin.state === 'failed' && code === 'not_found') return new ApiError(409, 'unknown_camera', undefined, 'the proxy does not have this camera');
    if (fin.state === 'expired' || fin.state === 'unknown') return new ApiError(504, 'timeout', undefined, 'the proxy did not answer in time');
    return new ApiError(502, 'proxy_failed', undefined, code || undefined);
  }
}
