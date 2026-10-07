import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import type { CommandRow, Commands, WireCommand } from '../commands/service';
import { sanitize } from '../contract';
import { REMOTE_SETTABLE } from '../../contract/build';
import { isRemoteSettable, narrowingOk, narrowReason, PATH_RE, patternOf, STORAGE_LOCAL_ONLY, type Leaf, type Settable } from './narrow';

// A proxy's settings as cams-admin knows them (migration spec §8; P3 plan
// Task 4): the last reported view per proxy (proxy_config), read by
// config.get when it is missing or the heartbeat's configRevision moved
// (R3-17); changes as a dry run first, then a real write made from that dry
// run's row only (apply by preview id, R3-15); rollback the same way (R3-21).
// The view is untrusted: clamped, filtered against remote-settable.json, and
// shown as text (R3-20). Database writes: a stored view only when it differs.

export type { Settable } from './narrow';
export interface ConfigPath { v?: unknown; s: 'default' | 'file' | 'override' | 'env'; r?: 'restart' | 'process'; p?: true; n?: unknown; by?: { cmdId: string; actor: string; at: number } }
export interface ConfigView {
  revision: string; schema: number | null; cameras: string[]; omittedCameras: string[]; paths: Record<string, ConfigPath>; settable: Record<string, Settable>;
  fetchedAt: number; cmdId: string; clampedPaths?: number;
}
export interface ConfigState { view: ConfigView | null; reportedRevision: string | null; changedOnProxy: boolean; fetching: string | null; allow: string[] }
export type ConfigInput = { set: Record<string, Leaf> } | { unset: string[] };

export const PREVIEW_MAX_AGE_MS = 10 * 60_000;
export const AUTO_EVERY_MS = 60_000;
export const MAX_VIEW_BYTES = 262_144;
const VIEW_BUDGET = MAX_VIEW_BYTES - 8_192; // room for the envelope fields around the paths
const MAX_PATHS = 4096;
const REV_RE = /^sha256:[0-9a-f]{64}$/;
const CAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CMD_RE = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const SOURCES = ['default', 'file', 'override', 'env'];
const WRITES = ['config.set', 'config.unset', 'config.rollback'];
const REMOTE = new Set(REMOTE_SETTABLE.remote);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isLeaf = (x: unknown): x is Leaf => typeof x === 'boolean' || Number.isSafeInteger(x) || (typeof x === 'string' && x.length <= 512);
const isValue = (x: unknown) => x === null || typeof x === 'boolean' || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));

// {set: {path: leaf}} (1–64) or {unset: [path]} (1–64, unique); 400 invalid otherwise.
function parseInput(input: unknown): ConfigInput {
  if (!isObj(input)) throw new ApiError(400, 'invalid', 'body');
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new ApiError(400, 'invalid', 'set or unset');
  if (keys[0] === 'set' && isObj(input.set)) {
    const e = Object.entries(input.set);
    if (e.length < 1 || e.length > 64) throw new ApiError(400, 'invalid', 'set: 1 to 64 settings');
    for (const [p, v] of e) if (!isLeaf(v)) throw new ApiError(400, 'invalid', `set.${p.slice(0, 64)}`);
    return { set: Object.fromEntries(e) as Record<string, Leaf> };
  }
  if (keys[0] === 'unset' && Array.isArray(input.unset)) {
    const u = input.unset;
    if (u.length < 1 || u.length > 64 || u.some((p) => typeof p !== 'string') || new Set(u).size !== u.length) throw new ApiError(400, 'invalid', 'unset: 1 to 64 unique paths');
    return { unset: u as string[] };
  }
  throw new ApiError(400, 'invalid', 'set or unset');
}

// The settable entry of a view, kept only with known fields of the right type.
function cleanSettable(x: unknown): Settable | null {
  if (!isObj(x) || !['integer', 'boolean', 'string'].includes(x.type as string)) return null;
  const out: Settable = { type: x.type as Settable['type'] };
  if (typeof x.min === 'number' && Number.isFinite(x.min)) out.min = x.min;
  if (typeof x.max === 'number' && Number.isFinite(x.max)) out.max = x.max;
  if (Array.isArray(x.oneOf) && x.oneOf.every((n) => Number.isSafeInteger(n))) out.oneOf = x.oneOf.slice(0, 64) as number[];
  if (Array.isArray(x.enum) && x.enum.every((n) => typeof n === 'string')) out.enum = (x.enum as string[]).slice(0, 64);
  if (typeof x.pattern === 'string') out.pattern = x.pattern.slice(0, 400);
  if (typeof x.optional === 'boolean') out.optional = x.optional;
  if (x.dir === 'less' || x.dir === 'more') out.dir = x.dir;
  return out;
}

function cleanPath(x: unknown): ConfigPath | null {
  if (!isObj(x) || !SOURCES.includes(x.s as string)) return null;
  const out: ConfigPath = { s: x.s as ConfigPath['s'] };
  if ('v' in x && isValue(x.v)) out.v = x.v;
  if (x.r === 'restart' || x.r === 'process') out.r = x.r;
  if (x.p === true) out.p = true;
  if ('n' in x && isValue(x.n)) out.n = x.n;
  const by = x.by;
  if (isObj(by) && typeof by.cmdId === 'string' && CMD_RE.test(by.cmdId) && typeof by.actor === 'string' && Number.isSafeInteger(by.at)) out.by = { cmdId: by.cmdId, actor: by.actor, at: by.at as number };
  return out;
}

export interface ProxyConfigDeps { db: Db; clock: Clock; registry: Registry; commands: Commands; status: StatusStore; live: LiveHub; log: Logger }

export class ProxyConfig {
  private views = new Map<string, ConfigView | null>(); // read-through cache of proxy_config
  private lastAuto = new Map<string, number>(); // proxyId → when the last automatic config.get was queued
  private deferred = new Set<string>(); // proxies whose automatic read waits for the minute cap

  constructor(private d: ProxyConfigDeps) {
    d.commands.onFinal((r) => this.onFinal(r));
  }

  private view(proxyId: string): ConfigView | null {
    if (!this.views.has(proxyId)) {
      const r = this.d.db.prepare('SELECT view FROM proxy_config WHERE proxy_id = ?').get(proxyId) as { view: string } | undefined;
      this.views.set(proxyId, r ? (JSON.parse(r.view) as ConfigView) : null);
    }
    return this.views.get(proxyId) ?? null;
  }

  state(accountId: string, proxyId: string): ConfigState {
    this.d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
    const view = this.view(proxyId);
    const rep = this.d.status.row(proxyId)?.reported;
    const reportedRevision = rep?.configRevision ?? null;
    return {
      view, reportedRevision, changedOnProxy: !!view && !!reportedRevision && reportedRevision !== view.revision,
      fetching: this.d.commands.openId(proxyId, 'config.get'), allow: [...(rep?.commands?.allow ?? [])],
    };
  }

  // R3-17 (d): Reload.
  refresh(actor: string, accountId: string, proxyId: string): { commandId: string } {
    this.d.registry.getProxy(accountId, proxyId);
    if (this.d.commands.hasOpen(proxyId, 'config.get')) throw new ApiError(409, 'already_fetching');
    return { commandId: this.d.commands.create(actor, accountId, proxyId, 'config.get', { v: 1 }).id };
  }

  // A dry-run config.set / config.unset against the stored view (R3-16 pre-check first).
  preview(actor: string, accountId: string, proxyId: string, input: unknown): { commandId: string } {
    const st = this.state(accountId, proxyId);
    if (!st.view) throw new ApiError(409, 'no_view');
    const parsed = parseInput(input);
    const view = st.view;
    const paths = 'set' in parsed ? Object.keys(parsed.set) : parsed.unset;
    for (const p of paths) {
      if (STORAGE_LOCAL_ONLY.test(p) || /^storage$/.test(p)) throw new ApiError(400, 'not_remote_settable', 'storage settings are local only');
      if (!isRemoteSettable(p, view.settable)) throw new ApiError(400, 'not_remote_settable', p.slice(0, 200));
      if (view.paths[p]?.s === 'env') throw new ApiError(400, 'held_by_env', p);
    }
    for (const p of paths) {
      const to = 'set' in parsed ? parsed.set[p] : undefined;
      if (!narrowingOk(patternOf(p), view.paths[p]?.v, to)) throw new ApiError(400, 'widening_local_only', `${p}: ${narrowReason(patternOf(p))}`);
    }
    const base = { v: 1, dryRun: true, baseRevision: view.revision };
    const row = 'set' in parsed
      ? this.d.commands.create(actor, accountId, proxyId, 'config.set', { ...base, set: parsed.set })
      : this.d.commands.create(actor, accountId, proxyId, 'config.unset', { ...base, paths: parsed.unset });
    return { commandId: row.id };
  }

  // The dry run a real write is made from: this proxy's, this sysadmin's,
  // done (status ok), fresh, unused; its args are copied (only dryRun flips).
  private previewRow(actor: string, accountId: string, proxyId: string, previewId: unknown, commands: string[]) {
    if (typeof previewId !== 'string' || !CMD_RE.test(previewId)) throw new ApiError(400, 'invalid', 'previewId');
    const pv = this.d.commands.getRaw(accountId, proxyId, previewId); // 404 for another proxy's or account's
    if (!commands.includes(pv.command) || !pv.dryRun || pv.state !== 'done' || pv.actor !== actor) throw new ApiError(409, 'preview_required');
    if (this.d.commands.usedPreview(previewId)) throw new ApiError(409, 'preview_used');
    if (this.d.clock.now() - (pv.finishedAt ?? 0) > PREVIEW_MAX_AGE_MS) throw new ApiError(409, 'preview_stale');
    return pv;
  }

  apply(actor: string, accountId: string, proxyId: string, previewId: unknown): { commandId: string } {
    const pv = this.previewRow(actor, accountId, proxyId, previewId, ['config.set', 'config.unset']);
    if (pv.rawArgs.baseRevision !== this.view(proxyId)?.revision) throw new ApiError(409, 'preview_stale');
    const row = this.d.commands.create(actor, accountId, proxyId, pv.command as WireCommand, { ...pv.rawArgs, dryRun: false }, { reason: `apply ${pv.id}`, previewOf: pv.id });
    return { commandId: row.id };
  }

  // R3-21: only a real, successful write with at least one change.
  rollbackPreview(actor: string, accountId: string, proxyId: string, cmdId: unknown): { commandId: string } {
    if (typeof cmdId !== 'string' || !CMD_RE.test(cmdId)) throw new ApiError(400, 'invalid', 'cmdId');
    const t = this.d.commands.getRaw(accountId, proxyId, cmdId);
    const changes = (t.result as { changes?: unknown } | null)?.changes;
    if (!WRITES.includes(t.command) || t.dryRun || t.state !== 'done' || !Array.isArray(changes) || changes.length === 0) throw new ApiError(409, 'not_rollbackable');
    return { commandId: this.d.commands.create(actor, accountId, proxyId, 'config.rollback', { v: 1, dryRun: true, cmdId }).id };
  }

  // Path-level (R3-5): no baseRevision check; the proxy answers conflict for a path changed since.
  rollbackApply(actor: string, accountId: string, proxyId: string, previewId: unknown): { commandId: string } {
    const pv = this.previewRow(actor, accountId, proxyId, previewId, ['config.rollback']);
    const row = this.d.commands.create(actor, accountId, proxyId, 'config.rollback', { ...pv.rawArgs, dryRun: false }, { reason: `rollback ${pv.id}`, previewOf: pv.id });
    return { commandId: row.id };
  }

  // R3-17 (a), (b): never writes by itself; queues at most one automatic read a minute.
  onHeartbeat(proxyId: string): void {
    const rep = this.d.status.row(proxyId)?.reported;
    if (!rep?.capabilities?.includes('commands') || !rep.commands?.allow.includes('config.get') || !rep.commands.enabled || rep.commands.paused) return;
    const view = this.view(proxyId);
    if (view && (!rep.configRevision || rep.configRevision === view.revision)) {
      this.deferred.delete(proxyId);
      return;
    }
    this.autoRefresh(proxyId, true);
  }

  tick(): void {
    for (const proxyId of [...this.deferred]) {
      if (this.d.clock.now() - (this.lastAuto.get(proxyId) ?? 0) < AUTO_EVERY_MS) continue;
      this.deferred.delete(proxyId);
      this.onHeartbeat(proxyId);
    }
  }

  // capped: the heartbeat triggers, at most one a minute. After a write of
  // cams-admin's own (R3-17 c) the re-read goes at once: the command rate bounds it.
  private autoRefresh(proxyId: string, capped: boolean): void {
    if (this.d.commands.hasOpen(proxyId, 'config.get')) return;
    const now = this.d.clock.now();
    if (capped && now - (this.lastAuto.get(proxyId) ?? -Infinity) < AUTO_EVERY_MS) {
      this.deferred.add(proxyId);
      return;
    }
    const px = this.d.registry.proxyById(proxyId);
    if (!px) return;
    try {
      this.d.commands.create('system', px.accountId, proxyId, 'config.get', { v: 1 });
      this.lastAuto.set(proxyId, now);
    } catch (e) {
      if (e instanceof ApiError) this.d.log.debug({ proxyId, code: e.code }, 'config_get_skipped');
      else throw e;
    }
  }

  private onFinal(r: CommandRow): void {
    if (!r.proxyId) return;
    if (r.command === 'config.get' && r.state === 'done') this.storeView(r.proxyId, r.id, r.result);
    else if (WRITES.includes(r.command) && ((r.state === 'done' && !r.dryRun) || r.outcomeCode === 'conflict')) this.autoRefresh(r.proxyId, false);
  }

  // A proxy's config.get result: filtered, clamped, stored when it differs.
  storeView(proxyId: string, cmdId: string, result: unknown): void {
    const raw = sanitize(result);
    if (!isObj(raw) || typeof raw.revision !== 'string' || !REV_RE.test(raw.revision) || !isObj(raw.paths) || !isObj(raw.settable)) {
      this.d.log.warn({ proxyId, cmdId }, 'config_view_unreadable');
      return;
    }
    const cams = (x: unknown) => (Array.isArray(x) ? x.filter((c): c is string => typeof c === 'string' && CAM_RE.test(c)).slice(0, 256) : []);
    const settable = Object.fromEntries(Object.entries(raw.settable).flatMap(([k, v]) => {
      const s = REMOTE.has(k) ? cleanSettable(v) : null; // a hostile or newer proxy can't widen the editor
      return s ? [[k, s]] : [];
    }));
    const head: Omit<ConfigView, 'paths'> = {
      revision: raw.revision, schema: Number.isSafeInteger(raw.schema) ? (raw.schema as number) : null,
      cameras: cams(raw.cameras), omittedCameras: cams(raw.omittedCameras), settable, fetchedAt: this.d.clock.now(), cmdId,
    };
    let size = Buffer.byteLength(JSON.stringify(head));
    const entries: [string, ConfigPath][] = [];
    let clamped = 0;
    for (const [k, v] of Object.entries(raw.paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!PATH_RE.test(k)) continue;
      const p = cleanPath(v);
      if (!p) continue;
      const add = Buffer.byteLength(JSON.stringify(k)) + Buffer.byteLength(JSON.stringify(p)) + 2;
      if (entries.length >= MAX_PATHS || size + add > VIEW_BUDGET) {
        clamped++;
        continue;
      }
      size += add;
      entries.push([k, p]);
    }
    const view: ConfigView = { ...head, paths: Object.fromEntries(entries), ...(clamped ? { clampedPaths: clamped } : {}) };
    const text = JSON.stringify(view);
    if (Buffer.byteLength(text) > MAX_VIEW_BYTES) {
      this.d.log.warn({ proxyId, cmdId }, 'config_view_too_large');
      return;
    }
    const old = this.view(proxyId);
    const same = old && old.revision === view.revision && JSON.stringify({ ...old, fetchedAt: 0, cmdId: '' }) === JSON.stringify({ ...view, fetchedAt: 0, cmdId: '' });
    if (same) return;
    tx(this.d.db, () => this.d.db.prepare(`INSERT INTO proxy_config (proxy_id, revision, view, cmd_id, fetched_at) VALUES (?,?,?,?,?)
      ON CONFLICT(proxy_id) DO UPDATE SET revision = excluded.revision, view = excluded.view, cmd_id = excluded.cmd_id, fetched_at = excluded.fetched_at`)
      .run(proxyId, view.revision, text, cmdId, view.fetchedAt));
    this.views.set(proxyId, view);
    this.deferred.delete(proxyId);
    this.d.live.publishRegistry('proxy', proxyId);
  }
}
