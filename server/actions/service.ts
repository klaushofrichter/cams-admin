import type { Clock } from '../clock';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { Commands } from '../commands/service';
import type { ProxyConfig } from '../config/service';
import { DISRUPTIVE_ACTIONS, REMOTE_ACTIONS } from '../../contract/build';

// Remote camera actions, camera renames and proxy restarts (migration spec
// §8.6, P3 plan Task 5, R3-18): signed commands with closed args; the
// disruptive ones (Klaus's decision 3) need the action's name typed back as
// `confirm`. cams-admin never talks to a camera: the proxy runs the action
// and re-reads what it wrote. The proxy re-checks everything (R2-15) and
// bounds the disruptive ones with its journal budget.

const CAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
export const BUSY_MS = 10_000;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const isDisruptive = (a: string) => (DISRUPTIVE_ACTIONS as readonly string[]).includes(a);

export interface ActionsDeps { registry: Registry; commands: Commands; status: StatusStore; clock: Clock; config?: ProxyConfig }
export interface Available { actions: { action: string; disruptive: boolean; allowed: boolean }[]; rename: boolean; restart: boolean; cameras: string[] }

export class RemoteActions {
  // proxy|camera|action → the command of the last request (a double click within 10 s is busy while it is open).
  private recent = new Map<string, { at: number; cmdId: string }>();

  constructor(private d: ActionsDeps) {}

  cameraAction(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    if (!isObj(body) || !only(body, ['camera', 'action', 'input', 'confirm'])) throw new ApiError(400, 'invalid', 'body');
    const action = body.action;
    if (typeof action !== 'string' || !(REMOTE_ACTIONS as readonly string[]).includes(action)) throw new ApiError(400, 'invalid', 'action');
    const camera = body.camera;
    if (action === 'retention-run' ? camera !== null : typeof camera !== 'string' || !CAM_RE.test(camera)) throw new ApiError(400, 'invalid', 'camera');
    let input: Record<string, unknown> | undefined;
    if (body.input !== undefined) {
      const i = body.input;
      if (action !== 'inventory' || !isObj(i) || !only(i, ['kind', 'camera']) || typeof i.kind !== 'string' || i.kind.length < 1 || i.kind.length > 32
        || (i.camera !== undefined && typeof i.camera !== 'boolean')) throw new ApiError(400, 'invalid', 'input');
      input = { kind: i.kind, ...(i.camera !== undefined ? { camera: i.camera } : {}) };
    }
    if (isDisruptive(action) && body.confirm !== action) throw new ApiError(400, 'confirm_required', 'confirm');
    const key = `${proxyId}|${String(camera)}|${action}`;
    const now = this.d.clock.now();
    const last = this.recent.get(key);
    if (last && now - last.at < BUSY_MS && this.isOpen(accountId, proxyId, last.cmdId)) throw new ApiError(409, 'busy');
    const row = this.d.commands.create(actor, accountId, proxyId, 'camera.action', { v: 1, camera, action, ...(input ? { input } : {}) });
    this.recent.set(key, { at: now, cmdId: row.id });
    for (const [k, v] of this.recent) if (now - v.at >= BUSY_MS) this.recent.delete(k);
    return { commandId: row.id };
  }

  rename(actor: string, accountId: string, proxyId: string, camera: string, body: unknown): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    if (!CAM_RE.test(camera)) throw new ApiError(400, 'invalid', 'camera');
    if (!isObj(body) || !only(body, ['name']) || typeof body.name !== 'string' || !NAME_RE.test(body.name)) throw new ApiError(400, 'invalid', 'name');
    return { commandId: this.d.commands.create(actor, accountId, proxyId, 'camera.name.set', { v: 1, camera, name: body.name }).id };
  }

  restart(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    if (!isObj(body) || body.confirm !== 'proxy.restart') throw new ApiError(400, 'confirm_required', 'confirm');
    return { commandId: this.d.commands.create(actor, accountId, proxyId, 'proxy.restart', { v: 1 }).id };
  }

  available(accountId: string, proxyId: string): Available {
    this.d.registry.getProxy(accountId, proxyId);
    const rep = this.d.status.row(proxyId)?.reported;
    const allow = rep?.commands ? rep.commands.allow : [];
    const view = this.d.config?.state(accountId, proxyId).view;
    const cameras = view?.cameras.length ? [...view.cameras] : (rep?.cameras ?? []).map((c) => c.ref).filter((c) => CAM_RE.test(c));
    return {
      actions: REMOTE_ACTIONS.map((a) => ({ action: a, disruptive: isDisruptive(a), allowed: allow.includes(`camera.action:${a}`) })),
      rename: allow.includes('camera.name.set'), restart: allow.includes('proxy.restart'), cameras,
    };
  }

  private isOpen(accountId: string, proxyId: string, cmdId: string): boolean {
    try {
      return ['queued', 'sent', 'received'].includes(this.d.commands.get(accountId, proxyId, cmdId).state);
    } catch {
      return false;
    }
  }
}
