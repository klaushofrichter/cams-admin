import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import { deriveCommands } from '../status/derive';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import type { CommandRow, Commands } from '../commands/service';
import type { ProxyConfig } from '../config/service';
import { sanitize } from '../contract';
import { ANALYTICS_PROVIDER_PATTERN, ANALYTICS_PROVIDERS_MAX } from '../../contract/build';

// Vision management (design 2026-11-05-vision-management-design.md, cams-admin 1–4): what each proxy of an
// account reports of its vision providers (analytics.usage.get, stored per proxy in proxy_analytics: the
// latest answer replaces the row), Refresh, and the monthly limit as one config.set (enabled = limit > 0)
// through the config service's preview + apply, run here server side. System admin only, checked here.
// The proxy has the final word on every limit (its local ceiling); our pre-check is the config service's.

// A provider id of analytics.usage.get → its key under analytics.* in the proxy's settings. Another provider
// is one more entry here.
export const PROVIDER_CONFIG: Readonly<Record<string, string>> = { 'google-vision': 'googleVision' };
export const MONTHLY_MAX = 100_000;
const COMMAND = 'analytics.usage.get';
// Codes of a refused analytics.usage.get that mean the proxy doesn't know the command (else: not allowed).
const TOO_OLD_CODES = new Set(['unknown_command', 'not_implemented', 'unsupported', 'invalid_command']);

export interface Caller { actor: string; sysadmin: boolean }
export interface UsageProvider {
  id: string; name: string; enabled: boolean; key: string; monthlyLimit: number; remoteMaxMonthly: number; dailyCap: number;
  month: { calls: number }; today: { calls: number }; paused: { reason: string; until: number | null } | null; lastError: { at: number; message: string } | null;
  cameras: { id: string; today: number; month: number }[];
}
export interface Usage { v: 1; at: number; providers: UsageProvider[] }
export type Access = 'ok' | 'too-old' | 'not-allowed';
export interface SaveState { provider: string; monthlyLimit: number; state: 'previewing' | 'applying' | 'saved' | 'failed'; previewId: string; applyId: string | null; code: string | null; detail: string | null; at: number }
export interface VisionItem {
  proxyId: string; name: string; displayName: string; state: string; access: Access; refreshing: boolean;
  fetchedAt: number | null; result: Usage | null; saves: Record<string, SaveState>; lastRefusal: string | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown) => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : 0);
const text = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
const PROVIDER_RE = new RegExp(ANALYTICS_PROVIDER_PATTERN);
const CAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// An analytics.usage.get result, field by field (the contract's names only; strings clamped). Never a key:
// `key` is where the key comes from (env | manual | none), anything else becomes "unknown". null when unreadable.
export function cleanUsage(raw: unknown): Usage | null {
  const r = sanitize(raw);
  if (!isObj(r) || !Array.isArray(r.providers)) return null;
  const providers = r.providers.filter(isObj).filter((p) => typeof p.id === 'string' && PROVIDER_RE.test(p.id)).slice(0, ANALYTICS_PROVIDERS_MAX).map((p): UsageProvider => {
    const paused = isObj(p.paused) ? { reason: text(p.paused.reason, 64) || 'unknown', until: Number.isSafeInteger(p.paused.until) ? (p.paused.until as number) : null } : null;
    const lastError = isObj(p.lastError) ? { at: count(p.lastError.at), message: text(p.lastError.message, 200) } : null;
    const cams = Array.isArray(p.cameras) ? p.cameras.filter(isObj).filter((c) => typeof c.id === 'string' && CAM_RE.test(c.id)).slice(0, 64) : [];
    return {
      id: p.id as string, name: text(p.name, 64) || (p.id as string), enabled: p.enabled === true,
      key: ['env', 'manual', 'none'].includes(p.key as string) ? (p.key as string) : 'unknown',
      monthlyLimit: count(p.monthlyLimit), remoteMaxMonthly: count(p.remoteMaxMonthly), dailyCap: count(p.dailyCap),
      month: { calls: count(isObj(p.month) ? p.month.calls : 0) }, today: { calls: count(isObj(p.today) ? p.today.calls : 0) },
      paused, lastError, cameras: cams.map((c) => ({ id: c.id as string, today: count(c.today), month: count(c.month) })),
    };
  });
  return { v: 1, at: count(r.at), providers };
}

export interface VisionDeps { db: Db; clock: Clock; registry: Registry; status: StatusStore; commands: Commands; config: ProxyConfig; live: LiveHub; log: Logger }

export class Vision {
  // In memory: the last save per proxy and provider (row-level state on the tab), and the last refusal of the command.
  private saves = new Map<string, Map<string, SaveState & { actor: string; accountId: string }>>();
  private refusals = new Map<string, string>();

  constructor(private d: VisionDeps) {
    d.commands.onFinal((r) => {
      try {
        this.onFinal(r);
      } catch (e) {
        d.log.error({ err: e, cmdId: r.id }, 'vision_final_failed');
      }
    });
  }

  private guard(c: Caller): void {
    if (!c.sysadmin) throw new ApiError(403, 'forbidden');
  }

  // The stored figures of one proxy (the diagnostics API and the tab).
  stored(proxyId: string): { fetchedAt: number; result: Usage } | null {
    const r = this.d.db.prepare('SELECT fetched_at, result FROM proxy_analytics WHERE proxy_id = ?').get(proxyId) as { fetched_at: number; result: string } | undefined;
    return r ? { fetchedAt: r.fetched_at, result: JSON.parse(r.result) as Usage } : null;
  }

  // Can this proxy answer the command? From its reported command policy; a proxy that lacks the allow entry
  // but reports the ceiling setting (or refused the command as not allowed) is new enough: Not allowed.
  access(proxyId: string): Access {
    const rep = this.d.status.row(proxyId)?.reported;
    const pol = deriveCommands(rep);
    if (pol === 'unsupported') return 'too-old';
    const refused = this.refusals.get(proxyId);
    if (refused && TOO_OLD_CODES.has(refused)) return 'too-old';
    if (pol !== 'allowed' || !rep!.commands!.allow.includes(COMMAND)) {
      const view = this.d.config.peek(proxyId);
      if (view && !Object.keys(PROVIDER_CONFIG).some((id) => `analytics.${PROVIDER_CONFIG[id]}.remoteMaxMonthly` in view.paths)) return 'too-old';
      return 'not-allowed';
    }
    return 'ok';
  }

  get(c: Caller, accountId: string): { items: VisionItem[] } {
    this.guard(c);
    this.d.registry.getAccount(accountId);
    const rows = this.d.db.prepare(`SELECT p.id FROM proxies p WHERE p.account_id = ? AND p.state = 'enrolled' ORDER BY p.name`).all(accountId) as { id: string }[];
    return {
      items: rows.map(({ id }) => {
        const px = this.d.registry.getProxy(accountId, id);
        const st = this.stored(id);
        const saves = Object.fromEntries([...(this.saves.get(id) ?? new Map()).entries()].map(([k, { actor: _a, accountId: _c, ...v }]) => [k, v]));
        return {
          proxyId: id, name: px.name, displayName: px.displayName, state: this.d.status.viewOf(px).state, access: this.access(id),
          refreshing: this.d.commands.hasOpen(id, COMMAND), fetchedAt: st?.fetchedAt ?? null, result: st?.result ?? null, saves, lastRefusal: this.refusals.get(id) ?? null,
        };
      }),
    };
  }

  // Queue the command for every online proxy of the account that can answer it; one in flight per proxy.
  refresh(c: Caller, accountId: string): { queued: string[] } {
    this.guard(c);
    this.d.registry.getAccount(accountId);
    const queued: string[] = [];
    for (const px of this.d.registry.listProxies(accountId)) {
      if (px.state !== 'enrolled' || this.d.status.viewOf(px).state !== 'online') continue;
      if (this.refreshOne(c.actor, accountId, px.id)) queued.push(px.id);
    }
    return { queued };
  }

  private refreshOne(actor: string, accountId: string, proxyId: string): boolean {
    if (this.access(proxyId) !== 'ok' || this.d.commands.hasOpen(proxyId, COMMAND)) return false;
    try {
      this.d.commands.create(actor, accountId, proxyId, COMMAND, { v: 1 });
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      this.d.log.debug({ proxyId, code: e.code }, 'vision_refresh_skipped');
      return false;
    }
  }

  // The monthly limit of one provider: enabled and monthlyLimit together (0 = off) as a dry run; the apply
  // follows when the dry run comes back done. A pre-check refusal is this call's error (the row shows it).
  setLimit(c: Caller, accountId: string, proxyId: string, provider: string, body: unknown): { commandId: string } {
    this.guard(c);
    this.d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
    if (!Object.hasOwn(PROVIDER_CONFIG, provider)) throw new ApiError(404, 'unknown_provider');
    const limit = isObj(body) ? body.monthlyLimit : undefined;
    if (!Number.isSafeInteger(limit) || (limit as number) < 0 || (limit as number) > MONTHLY_MAX) throw new ApiError(400, 'invalid', 'monthlyLimit');
    const key = `analytics.${PROVIDER_CONFIG[provider]}`;
    const n = limit as number;
    const { commandId } = this.d.config.preview(c.actor, accountId, proxyId, { set: { [`${key}.enabled`]: n > 0, [`${key}.monthlyLimit`]: n } });
    const per = this.saves.get(proxyId) ?? new Map();
    this.saves.set(proxyId, per);
    per.set(provider, { provider, monthlyLimit: n, state: 'previewing', previewId: commandId, applyId: null, code: null, detail: null, at: this.d.clock.now(), actor: c.actor, accountId });
    return { commandId };
  }

  private onFinal(r: CommandRow): void {
    if (!r.proxyId) return;
    if (r.command === COMMAND) {
      if (r.state === 'done') {
        this.refusals.delete(r.proxyId);
        this.store(r.proxyId, r.id, r.result);
      } else if (r.outcomeCode) this.refusals.set(r.proxyId, r.outcomeCode);
      return;
    }
    const per = this.saves.get(r.proxyId);
    if (!per || r.command !== 'config.set') return;
    for (const s of per.values()) {
      if (s.previewId === r.id && s.state === 'previewing') {
        if (r.state !== 'done') return this.fail(s, r);
        // Outside the final listeners (the apply queues a command of its own).
        queueMicrotask(() => {
          try {
            s.applyId = this.d.config.apply(s.actor, s.accountId, r.proxyId!, s.previewId).commandId;
            s.state = 'applying';
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            Object.assign(s, { state: 'failed', code: e.code, detail: e.field ?? null });
          }
          this.d.live.publishRegistry('proxy', r.proxyId!);
        });
        return;
      }
      if (s.applyId === r.id && s.state === 'applying') {
        if (r.state !== 'done') return this.fail(s, r);
        s.state = 'saved';
        s.at = this.d.clock.now();
        queueMicrotask(() => this.refreshOne(s.actor, s.accountId, r.proxyId!));
        return;
      }
    }
  }

  private fail(s: SaveState, r: CommandRow): void {
    const paths = (r.result as { paths?: unknown } | null)?.paths;
    const first = Array.isArray(paths) ? paths.find((p) => isObj(p) && typeof p.detail === 'string') : null;
    Object.assign(s, { state: 'failed', code: r.outcomeCode ?? r.state, detail: first ? text((first as Record<string, unknown>).detail, 200) : null, at: this.d.clock.now() });
  }

  private store(proxyId: string, cmdId: string, result: unknown): void {
    const u = cleanUsage(result);
    if (!u) {
      this.d.log.warn({ proxyId, cmdId }, 'vision_usage_unreadable');
      return;
    }
    const at = this.d.clock.now();
    tx(this.d.db, () => this.d.db.prepare(`INSERT INTO proxy_analytics (proxy_id, fetched_at, result) VALUES (?,?,?)
      ON CONFLICT(proxy_id) DO UPDATE SET fetched_at = excluded.fetched_at, result = excluded.result`).run(proxyId, at, JSON.stringify(u)));
    this.d.live.publishRegistry('proxy', proxyId);
  }
}
