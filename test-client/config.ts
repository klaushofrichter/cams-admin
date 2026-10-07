// A reference proxy for the P3 commands (config.get, config.set,
// config.unset, config.rollback, camera.action, camera.name.set,
// proxy.restart), written from "The P3 contract" only
// (docs/superpowers/plans/2026-10-07-migration-p3-cams-admin.md). No cam-proxy
// code: it is what cams-admin's tests and e2e run against. In memory: a base
// layer (default or file values), the overrides (remote or local), env-held
// values, the backups for rollback and the camera actions it was asked to run.
import { createHash } from 'crypto';
import { jcs } from '../server/crypto/jcs';
import { REMOTE_SETTABLE } from '../contract/build';

type Leaf = boolean | number | string;
type Source = 'default' | 'file' | 'override' | 'env';
interface Base { v: Leaf; s: 'default' | 'file' }
interface Settable { type: 'integer' | 'boolean' | 'string'; min?: number; max?: number; optional?: boolean; dir?: 'less' | 'more' }
export interface RefOutcome { status: 'ok' | 'failed' | 'conflict'; code?: string; result?: Record<string, unknown> }
// One path's override before and after a write (absent = no override).
interface Step { before?: Leaf; after?: Leaf }
interface Backup { paths: Record<string, Step>; rolledBack: boolean }

const CAMERA_WRITES = ['camera-ftp-setup', 'camera-ntp-set', 'camera-cert-push'];
const LESS_REASON = 'a remote change may only lower spending';
const MORE_REASON = 'a remote change may only keep data longer';
// Google Vision caps where 0 means "no cap".
const ZERO_IS_NO_CAP = ['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap'];

export const patternOf = (path: string): string => path.replace(/^cameras\.[^.]+\./, 'cameras.*.');
const under = (p: string, d: string) => p === d || p.startsWith(`${d}.`);

// The contract's narrow rule: may `from` → `to` happen remotely on this path?
export function narrowOk(pattern: string, from: Leaf | undefined, to: Leaf | undefined): boolean {
  const dir = REMOTE_SETTABLE.narrow[pattern];
  if (!dir) return true;
  if (typeof from === 'boolean' || typeof to === 'boolean') return dir === 'less' ? to === false || to === from : to === true || to === from;
  const inf = (x: Leaf | undefined) => (x === undefined || (ZERO_IS_NO_CAP.includes(pattern) && x === 0) ? Infinity : Number(x));
  return dir === 'less' ? inf(to) <= inf(from) : inf(to) >= inf(from);
}

export class RefProxyConfig {
  readonly cameras: string[];
  actions = { calls: [] as { action: string; camera: string | null }[] };
  onChange: (() => void) | null = null; // the client's early heartbeat
  private base = new Map<string, Base>();
  private overrides = new Map<string, Leaf>();
  private env = new Map<string, Leaf>();
  private by = new Map<string, { cmdId: string; actor: string; at: number }>();
  private backups = new Map<string, Backup>();
  // Optional settings with no value (a size cap unset = no cap).
  private optional = ['stills.maxGB', 'ftp.maxGB'];
  private settableBounds: Record<string, Partial<Settable>> = { 'sse.pingS': { min: 5, max: 300 }, 'sse.maxClients': { min: 1, max: 1000 }, 'stills.quality': { min: 1, max: 31 } };

  constructor(o: { cameras?: string[]; settings?: Record<string, Leaf>; envHeld?: string[] } = {}) {
    this.cameras = o.cameras ?? ['cam1'];
    const d = (p: string, v: Leaf) => this.base.set(p, { v, s: 'default' });
    const f = (p: string, v: Leaf) => this.base.set(p, { v, s: 'file' });
    d('sse.pingS', 30); d('sse.maxClients', 20); f('stills.quality', 5);
    d('retention.stillsDays', 30); d('retention.eventsDays', 30); d('retention.auditDays', 90); d('retention.clipsDays', 30);
    d('analytics.googleVision.monthlyLimit', 1000); d('analytics.googleVision.enabled', false);
    d('storage.maxPercent', 90); f('camsAdmin.url', 'https://cams-admin.example.org');
    for (const c of this.cameras) {
      f(`cameras.${c}.name`, c === 'cam1' ? 'Front door' : c);
      f(`cameras.${c}.host`, '192.0.2.10');
      d(`cameras.${c}.storage.sharePercent`, 100);
    }
    for (const [p, v] of Object.entries(o.settings ?? {})) f(p, v);
    // retention.clipsDays is held as an override above its default.
    this.overrides.set('retention.clipsDays', 90);
    this.env.set('ftp.publicHost', 'proxy.example.net');
    for (const p of o.envHeld ?? []) this.env.set(p, this.base.get(p)?.v ?? '');
  }

  revision(): string {
    const o = Object.fromEntries([...this.overrides].sort(([a], [b]) => (a < b ? -1 : 1)));
    return `sha256:${createHash('sha256').update(jcs(o), 'utf8').digest('hex')}`;
  }

  current(path: string): Leaf | undefined {
    return this.env.get(path) ?? this.overrides.get(path) ?? this.base.get(path)?.v;
  }

  private state(path: string): { v?: Leaf; s: Source } {
    if (this.env.has(path)) return { v: this.env.get(path), s: 'env' };
    if (this.overrides.has(path)) return { v: this.overrides.get(path), s: 'override' };
    const b = this.base.get(path);
    return b ? { v: b.v, s: b.s } : { s: 'default' };
  }

  // A local edit (the proxy's own Settings page or PUT /control/config).
  localEdit(set: Record<string, Leaf>): void {
    for (const [p, v] of Object.entries(set)) {
      this.overrides.set(p, v);
      this.by.delete(p);
    }
    this.onChange?.();
  }

  private settable(): Record<string, Settable> {
    const out: Record<string, Settable> = {};
    for (const p of this.optional) out[p] = { type: 'integer', min: 1, max: 100_000, optional: true, ...(REMOTE_SETTABLE.narrow[p] ? { dir: REMOTE_SETTABLE.narrow[p] } : {}) };
    for (const [p, b] of this.base) {
      const pat = patternOf(p);
      if (!REMOTE_SETTABLE.remote.includes(pat) || out[pat]) continue;
      const type = typeof b.v === 'boolean' ? 'boolean' : typeof b.v === 'number' ? 'integer' : 'string';
      out[pat] = { type, ...this.settableBounds[pat], ...(REMOTE_SETTABLE.narrow[pat] ? { dir: REMOTE_SETTABLE.narrow[pat] } : {}) };
    }
    return out;
  }

  // A proxy whose redaction regressed (tests, I2): CAMPROXY_TEST_SECRET leaks
  // into secret-named settings and into action answers.
  private leak(): string | undefined {
    return process.env.CAMPROXY_TEST_SECRET;
  }

  private view(): Record<string, unknown> {
    const paths: Record<string, unknown> = {};
    const leak = this.leak();
    if (leak) Object.assign(paths, { 'camsAdmin.token': { v: leak, s: 'env' }, 'ftp.password': { v: leak, s: 'env' } });
    const all = new Set([...this.base.keys(), ...this.overrides.keys(), ...this.env.keys(), ...this.optional]);
    for (const p of [...all].sort()) paths[p] = { ...this.state(p), ...(this.by.has(p) && this.overrides.has(p) ? { by: this.by.get(p) } : {}) };
    return { revision: this.revision(), schema: 1, cameras: [...this.cameras], omittedCameras: [], paths, settable: this.settable() };
  }

  private valueOk(pattern: string, v: Leaf): string | null {
    const s = this.settable()[pattern];
    if (!s) return 'unknown setting';
    if (s.type === 'boolean' ? typeof v !== 'boolean' : s.type === 'integer' ? !Number.isSafeInteger(v) : typeof v !== 'string') return `must be ${s.type === 'integer' ? 'an integer' : `a ${s.type}`}`;
    if (typeof v === 'number' && ((s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max))) return `must be between ${s.min} and ${s.max}`;
    return null;
  }

  private remoteOk(path: string): boolean {
    const pat = patternOf(path);
    if (REMOTE_SETTABLE.denied.some((d) => under(pat, d))) return false;
    return REMOTE_SETTABLE.remote.includes(pat) && (this.base.has(path) || this.optional.includes(path));
  }

  private conflict(paths: string[]): RefOutcome {
    return { status: 'conflict', result: { revision: this.revision(), current: Object.fromEntries(paths.map((p) => [p, this.state(p)])) } };
  }

  // config.set / config.unset: the path checks in the contract's order, then the plan.
  private write(args: { dryRun: boolean; baseRevision: string; set?: Record<string, Leaf>; paths?: string[] }, cmd: { cmdId: string; actor: string }): RefOutcome {
    const target: [string, Leaf | undefined][] = args.set ? Object.entries(args.set) : (args.paths ?? []).map((p) => [p, undefined]);
    const fail = (code: string, list: { path: string; code: string; detail?: string }[]): RefOutcome => ({ status: 'failed', code, result: { paths: list } });
    const step = (code: string, bad: (p: string, v: Leaf | undefined) => string | false | null) => {
      const list = target.flatMap(([p, v]) => {
        const d = bad(p, v);
        return d === false || d === null ? [] : [{ path: p, code, ...(d ? { detail: d } : {}) }];
      });
      return list.length ? fail(code, list) : null;
    };
    const camOf = (p: string) => /^cameras\.([^.]+)\./.exec(p)?.[1];
    const resetTo = (p: string) => this.base.get(p);
    const r = step('unknown_camera', (p) => { const c = camOf(p); return c !== undefined && !this.cameras.includes(c) ? '' : false; })
      ?? step('not_remote_settable', (p) => (this.remoteOk(p) ? false : patternOf(p).startsWith('storage') || /^cameras\.\*\.storage/.test(patternOf(p)) ? 'storage settings are local only' : ''))
      ?? step('held_by_env', (p) => (this.env.has(p) ? '' : false));
    if (r) return r;
    if (args.baseRevision !== this.revision()) return this.conflict(target.map(([p]) => p));
    const narrow = step('widening_local_only', (p, v) => {
      const to = v === undefined ? resetTo(p)?.v : v;
      return narrowOk(patternOf(p), this.current(p), to) ? false : REMOTE_SETTABLE.narrow[patternOf(p)] === 'less' ? LESS_REASON : MORE_REASON;
    });
    if (narrow) return narrow;
    if (args.set) {
      const bad = step('invalid_value', (p, v) => this.valueOk(patternOf(p), v as Leaf));
      if (bad) return bad;
    }
    // The plan: a value equal to what Reset restores drops the override.
    const changes: Record<string, unknown>[] = [];
    const unchanged: string[] = [];
    const steps: Record<string, Step> = {};
    for (const [p, v] of target) {
      const before = this.overrides.get(p);
      const base = resetTo(p);
      const after = v === undefined || (base && base.v === v) ? undefined : v;
      if (before === after) { unchanged.push(p); continue; }
      const from = this.state(p);
      const toV = after ?? base?.v;
      changes.push({ path: p, ...(from.v !== undefined ? { from: from.v } : {}), ...(toV !== undefined ? { to: toV } : {}), sourceFrom: from.s, sourceTo: after !== undefined ? 'override' : (base?.s ?? 'default') });
      steps[p] = { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
    }
    const baseRevision = this.revision();
    if (!args.dryRun && changes.length) this.apply(steps, 'after', cmd);
    return { status: 'ok', result: { dryRun: args.dryRun, baseRevision, revision: this.revision(), changes, unchanged } };
  }

  private apply(steps: Record<string, Step>, side: 'before' | 'after', cmd: { cmdId: string; actor: string }): void {
    for (const [p, s] of Object.entries(steps)) {
      const v = s[side];
      if (v === undefined) {
        this.overrides.delete(p);
        this.by.delete(p);
      } else {
        this.overrides.set(p, v);
        this.by.set(p, { cmdId: cmd.cmdId, actor: cmd.actor, at: Date.now() });
      }
    }
    this.backups.set(cmd.cmdId, { paths: side === 'after' ? steps : Object.fromEntries(Object.entries(steps).map(([p, s]) => [p, { before: s.after, after: s.before }])), rolledBack: false });
    this.onChange?.();
  }

  // config.rollback: path-level; a path changed since → conflict; a restore that
  // would widen (lower a raise-only value, raise spending) → widening_local_only.
  private rollback(args: { dryRun: boolean; cmdId: string }, cmd: { cmdId: string; actor: string }): RefOutcome {
    const b = this.backups.get(args.cmdId);
    if (!b) return { status: 'failed', code: 'no_backup', result: { paths: [] } };
    if (b.rolledBack) return { status: 'failed', code: 'already_rolled_back', result: { paths: [] } };
    const since = Object.entries(b.paths).filter(([p, s]) => this.overrides.get(p) !== s.after).map(([p]) => p);
    if (since.length) return this.conflict(since);
    const widening = Object.entries(b.paths).filter(([p, st]) => !narrowOk(patternOf(p), this.current(p), st.before ?? this.base.get(p)?.v));
    if (widening.length) return { status: 'failed', code: 'widening_local_only', result: { paths: widening.map(([p]) => ({ path: p, code: 'widening_local_only', detail: REMOTE_SETTABLE.narrow[patternOf(p)] === 'less' ? LESS_REASON : MORE_REASON })) } };
    const baseRevision = this.revision();
    const changes = Object.entries(b.paths).map(([p, s]) => {
      const base = this.base.get(p);
      const from = this.state(p);
      const toV = s.before ?? base?.v;
      return { path: p, ...(from.v !== undefined ? { from: from.v } : {}), ...(toV !== undefined ? { to: toV } : {}), sourceFrom: from.s, sourceTo: s.before !== undefined ? 'override' : (base?.s ?? 'default') };
    });
    if (!args.dryRun) {
      this.apply(Object.fromEntries(Object.entries(b.paths).map(([p, s]) => [p, s])), 'before', cmd);
      b.rolledBack = true;
    }
    return { status: 'ok', result: { dryRun: args.dryRun, baseRevision, revision: this.revision(), changes, unchanged: [], of: args.cmdId } };
  }

  handle(command: string, args: any, cmd: { cmdId: string; actor: string }): RefOutcome {
    switch (command) {
      case 'config.get':
        return { status: 'ok', result: this.view() };
      case 'config.set':
      case 'config.unset':
        return this.write(args, cmd);
      case 'config.rollback':
        return this.rollback(args, cmd);
      case 'camera.action': {
        if (args.camera !== null && !this.cameras.includes(args.camera)) return { status: 'failed', code: 'unknown_camera' };
        this.actions.calls.push({ action: args.action, camera: args.camera });
        const writes = CAMERA_WRITES.includes(args.action);
        const leak = this.leak();
        const answer = leak ? { ok: true, token: leak, nested: { apiKey: leak } } : { ok: true };
        return { status: 'ok', result: { action: args.action, camera: args.camera, httpStatus: 200, answer, ...(writes ? { verified: true, mismatch: [] } : {}) } };
      }
      case 'camera.name.set': {
        if (!this.cameras.includes(args.camera)) return { status: 'failed', code: 'unknown_camera' };
        this.base.set(`cameras.${args.camera}.name`, { v: args.name, s: 'file' });
        return { status: 'ok', result: { camera: args.camera, requested: args.name, name: args.name, verified: true } };
      }
      case 'proxy.restart':
        return { status: 'ok', result: { restartAt: Date.now() + 1000 } };
    }
    return { status: 'failed', code: 'not_implemented' };
  }
}
