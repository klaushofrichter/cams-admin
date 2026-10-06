import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import type { Proxy, Registry } from '../registry';
import type { LiveHub } from '../live';
import { validateSummary } from '../contract';
import { cameraStates, deriveProxyState, heartbeatFresh, pinState, SKEW_PROBLEM_MS, type CommandsInfo, type PinState, type ProxyState, type Reported, type StatusRow, type TokensInfo } from './derive';

// The latest state of each proxy and its transitions, fed by the channel
// (spec §8.5, §8.6). The live state is in MEMORY (kube-setup's S3 cost rule,
// 2026-10-06): heartbeats never write the database by themselves. A
// meaningful change (online/offline, problems, a camera, the version, the
// pin, connect/stop) writes its status event and the proxy's row at once;
// everything else reaches proxy_status in a coarse snapshot every
// `snapshotMs` (10 min), so a restart shows the last known state, marked
// stale until the proxies reconnect.

export interface HeartbeatBody { summary: unknown; proxy?: Record<string, unknown> | null; truncated?: boolean }

export interface ProxyView {
  proxyId: string; accountId: string; state: ProxyState; connected: boolean; connectedSince: number | null; lastHelloAt: number | null; lastHeartbeatAt: number | null;
  closedReason: string | null; version: string | null; skewMs: number | null; skewProblem: boolean; ok: boolean | null; problemCount: number | null;
  cameras: { ref: string; online: boolean | null }[]; pin: PinState; unreadable: string | null; stale: boolean;
}

type Row = Record<string, unknown>;
const toStatus = (r: Row): StatusRow => ({
  proxyId: r.proxy_id as string, connected: r.connected === 1, connectedSince: r.connected_since as number | null, lastHelloAt: r.last_hello_at as number | null,
  lastHeartbeatAt: r.last_heartbeat_at as number | null, closedReason: r.closed_reason as string | null, stopped: r.stopped === 1, proxyVersion: r.proxy_version as string | null,
  clockSkewMs: r.clock_skew_ms as number | null, summary: r.summary ? JSON.parse(r.summary as string) : null, summaryAt: r.summary_at as number | null,
  ok: r.ok === null ? null : r.ok === 1, problemCount: r.problem_count as number | null, reported: r.reported ? JSON.parse(r.reported as string) : null, online: r.online === 1,
});

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const safeInt = (x: unknown): number | null => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : null);
const strList = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, len)) : []);

// P2 heartbeat fields, clamped whatever a proxy sends (they live in memory
// and the status snapshot; never a reason to refuse the heartbeat).
export function parseCommandsInfo(x: unknown): CommandsInfo | null {
  if (!isRecord(x)) return null;
  return {
    enabled: x.enabled === true, paused: x.paused === true, pauseReason: typeof x.pauseReason === 'string' ? x.pauseReason.slice(0, 200) : null,
    allow: strList(x.allow, 32, 64), seenWindow: safeInt(x.seenWindow) ?? 0,
  };
}
export function parseTokensInfo(x: unknown): TokensInfo | null {
  if (!isRecord(x) || safeInt(x.revision) === null) return null;
  return { revision: x.revision as number, client: safeInt(x.client) ?? 0, admin: safeInt(x.admin) ?? 0, blocked: strList(x.blocked, 64, 40) };
}
export const parseConfigRevision = (x: unknown): string | null => (typeof x === 'string' && /^sha256:[0-9a-f]{64}$/.test(x) ? x : null);

const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 2) : []);

const emptyRow = (proxyId: string): StatusRow => ({
  proxyId, connected: false, connectedSince: null, lastHelloAt: null, lastHeartbeatAt: null, closedReason: null, stopped: false, proxyVersion: null,
  clockSkewMs: null, summary: null, summaryAt: null, ok: null, problemCount: null, reported: null, online: false,
});

export class StatusStore {
  // Proxies whose stored status predates this process (stale until they say hello).
  private seenThisRun = new Set<string>();
  private mem = new Map<string, StatusRow>();
  private caps = new Map<string, string[]>(); // the last hello's capabilities
  private dirty = new Set<string>();
  private lastFlush: number;
  private snapshotMs: number;
  constructor(private d: { db: Db; clock: Clock; registry: Registry; live: LiveHub; offlineAfterMs: number; snapshotMs?: number }) {
    this.snapshotMs = d.snapshotMs ?? 600_000;
    this.lastFlush = d.clock.now();
    for (const r of d.db.prepare('SELECT * FROM proxy_status').all() as Row[]) this.mem.set(r.proxy_id as string, toStatus(r));
  }

  row(proxyId: string): StatusRow | null {
    const r = this.mem.get(proxyId);
    return r ? { ...r } : null;
  }

  private persist(r: StatusRow): void {
    this.d.db.prepare(`INSERT INTO proxy_status (proxy_id, connected, connected_since, last_hello_at, last_heartbeat_at, closed_reason, stopped, proxy_version, clock_skew_ms, summary, summary_at, ok, problem_count, reported, online)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proxy_id) DO UPDATE SET connected = excluded.connected, connected_since = excluded.connected_since,
      last_hello_at = excluded.last_hello_at, last_heartbeat_at = excluded.last_heartbeat_at, closed_reason = excluded.closed_reason, stopped = excluded.stopped,
      proxy_version = excluded.proxy_version, clock_skew_ms = excluded.clock_skew_ms, summary = excluded.summary, summary_at = excluded.summary_at, ok = excluded.ok,
      problem_count = excluded.problem_count, reported = excluded.reported, online = excluded.online`)
      .run(r.proxyId, r.connected ? 1 : 0, r.connectedSince, r.lastHelloAt, r.lastHeartbeatAt, r.closedReason, r.stopped ? 1 : 0, r.proxyVersion, r.clockSkewMs,
        r.summary === null ? null : JSON.stringify(r.summary), r.summaryAt, r.ok === null ? null : r.ok ? 1 : 0, r.problemCount, r.reported ? JSON.stringify(r.reported) : null, r.online ? 1 : 0);
    // Only the active key said that hello: a pending key (redeemed, never
    // used) is not seen, whatever the proxy did with its previous key.
    if (r.lastHelloAt !== null) this.d.db.prepare('UPDATE proxy_keys SET last_seen_at = ? WHERE proxy_id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL AND confirmed_at <= ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(r.lastHelloAt, r.proxyId, r.lastHelloAt, r.lastHelloAt);
    this.dirty.delete(r.proxyId);
  }

  // The coarse snapshot: every row changed since the last one, in one
  // transaction. `force` (shutdown, tests) writes now.
  flush(force = false): void {
    const now = this.d.clock.now();
    if (!force && now - this.lastFlush < this.snapshotMs) return;
    this.lastFlush = now;
    const rows = [...this.dirty].map((id) => this.mem.get(id)).filter((r): r is StatusRow => !!r && this.exists(r.proxyId));
    this.dirty.clear();
    if (rows.length) tx(this.d.db, () => { for (const r of rows) this.persist(r); });
  }

  private exists(proxyId: string): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM proxies WHERE id = ?').get(proxyId);
  }

  private event(proxyId: string, kind: string, cameraRef: string | null, detail: Record<string, unknown> | null): void {
    this.d.db.prepare('INSERT INTO status_events (proxy_id, camera_ref, at, kind, detail) VALUES (?,?,?,?,?)').run(proxyId, cameraRef, this.d.clock.now(), kind, detail ? JSON.stringify(detail).slice(0, 2048) : null);
  }

  // Runs fn on the in-memory row, then publishes the new state. A proxy that
  // was deleted while connected: nothing happens, never a throw. Events are
  // written with the row in one transaction; without events the row is only
  // marked for the next snapshot. The proxy row is read once per call (a
  // heartbeat costs two SELECTs: this one and the active key).
  private guarded(proxyId: string, fn: (r: StatusRow, ev: (kind: string, cameraRef?: string | null, detail?: Record<string, unknown> | null) => void, p: Proxy) => void): void {
    const p = this.d.registry.proxyById(proxyId);
    if (!p) {
      this.mem.delete(proxyId);
      return;
    }
    const r = this.mem.get(proxyId) ?? emptyRow(proxyId);
    this.mem.set(proxyId, r);
    const events: [string, string | null, Record<string, unknown> | null][] = [];
    fn(r, (kind, cameraRef = null, detail = null) => events.push([kind, cameraRef, detail]), p);
    if (events.length) {
      tx(this.d.db, () => {
        for (const [k, c, det] of events) this.event(proxyId, k, c, det);
        this.persist(r);
      });
    } else this.dirty.add(proxyId);
    const v = this.viewOf(p);
    this.d.live.publishStatus({ proxyId, accountId: v.accountId, state: v.state, ok: v.ok, problemCount: v.problemCount, lastHeartbeatAt: v.lastHeartbeatAt, cameras: v.cameras });
  }

  hello(proxyId: string, version: string | null, proxyTs: number, capabilities: string[] = []): void {
    this.seenThisRun.add(proxyId);
    this.guarded(proxyId, (r, ev) => {
      const now = this.d.clock.now();
      const oldVersion = r.proxyVersion;
      // A new connection: the command report is the next heartbeat's (a downgraded proxy has none).
      const caps = capabilities.slice(0, 16);
      this.caps.set(proxyId, caps);
      const reported: Reported | null = r.reported ? { ...r.reported, capabilities: caps, ...(caps.includes('commands') ? {} : { commands: null, tokens: null }) } : null;
      Object.assign(r, { connected: true, connectedSince: now, lastHelloAt: now, stopped: false, closedReason: null, proxyVersion: version ?? r.proxyVersion, clockSkewMs: proxyTs - now, reported });
      ev('connected');
      if (version && oldVersion && version !== oldVersion) ev('version-changed', null, { from: oldVersion, to: version });
    });
  }

  heartbeat(proxyId: string, body: HeartbeatBody, proxyTs: number): void {
    this.guarded(proxyId, (r, ev, proxy) => {
      const now = this.d.clock.now();
      const old = { ...r };
      const v = validateSummary(body.summary, body.truncated === true);
      const info = (body.proxy && typeof body.proxy === 'object' ? body.proxy : {}) as Record<string, unknown>;
      const tls = (info.tls && typeof info.tls === 'object' ? info.tls : null) as Record<string, unknown> | null;
      const reportedFps = asStrArray(tls?.caFingerprint);
      const pin = pinState(proxy.caFingerprints, reportedFps);
      let summary: unknown, ok: boolean, problemCount: number, version: string | null = null, summaryAt: number | null = null, cams: Reported['cameras'] = [];
      if (v.ok) {
        const s = v.summary as { ok: boolean; problemCount: number; version: string; generatedAt: number; cameras?: { camera: { id: string; online: boolean; name?: string; model?: string | null } }[] };
        summary = { ...s, $truncated: body.truncated === true };
        ok = s.ok;
        problemCount = s.problemCount;
        version = s.version;
        summaryAt = s.generatedAt;
        cams = (s.cameras ?? []).map((c) => ({ ref: c.camera.id, online: c.camera.online, name: c.camera.name, model: c.camera.model ?? null }));
      } else {
        summary = { unreadable: v.reason };
        ok = false;
        problemCount = 1;
      }
      const reported: Reported = {
        cameras: cams, caFingerprint: reportedFps, site: typeof tls?.site === 'string' ? tls.site : null,
        publicUrl: typeof info.publicUrl === 'string' ? info.publicUrl : null, startedAt: typeof info.startedAt === 'number' ? info.startedAt : null,
        uptimeS: typeof info.uptimeS === 'number' ? info.uptimeS : null, configSchema: typeof info.configSchema === 'number' ? info.configSchema : null, pin,
        capabilities: this.caps.get(proxyId) ?? old.reported?.capabilities ?? [],
        commands: parseCommandsInfo(info.commands), tokens: parseTokensInfo(info.tokens), configRevision: parseConfigRevision(info.configRevision),
      };
      Object.assign(r, { lastHeartbeatAt: now, summary, summaryAt, ok, problemCount, reported, clockSkewMs: proxyTs - now, proxyVersion: version ?? r.proxyVersion, online: true, stopped: false });

      // Transitions, each once (spec §8.6): these alone write the database.
      if (!old.online) ev('online');
      if (old.summary !== null && (old.ok !== ok || old.problemCount !== problemCount)) ev('problems-changed', null, { ok, problemCount });
      const before = new Map((old.reported?.cameras ?? []).map((c) => [c.ref, c.online]));
      for (const c of cams) {
        const was = before.get(c.ref);
        if (was !== undefined && was !== c.online) ev(c.online ? 'camera-online' : 'camera-offline', c.ref);
      }
      if (version && old.proxyVersion && version !== old.proxyVersion) ev('version-changed', null, { from: old.proxyVersion, to: version });
      const oldPin = old.reported?.pin ?? 'none';
      if (pin === 'mismatch' && oldPin !== 'mismatch') ev('pin-mismatch');
      if (pin === 'match' && oldPin === 'mismatch') ev('pin-match');
    });
  }

  disconnected(proxyId: string, reason: string): void {
    this.guarded(proxyId, (r, ev) => {
      Object.assign(r, { connected: false, closedReason: reason.slice(0, 200) });
      ev('disconnected', null, { reason: reason.slice(0, 200) });
    });
  }

  // A deliberate stop is not an outage (spec §8.6).
  bye(proxyId: string, reason: string): void {
    if (reason !== 'shutdown' && reason !== 'restart') return;
    this.guarded(proxyId, (r, ev) => {
      Object.assign(r, { stopped: true, online: false, closedReason: `bye:${reason}` });
      ev('stopped', null, { reason });
    });
  }

  // Liveness tick: online → offline when the heartbeat aged out; then the
  // coarse snapshot when it is due.
  tick(): void {
    const now = this.d.clock.now();
    for (const s of [...this.mem.values()]) {
      if (!s.online || heartbeatFresh(s, now, this.d.offlineAfterMs)) continue;
      this.guarded(s.proxyId, (r, ev) => {
        r.online = false;
        if (!r.stopped) ev('offline', null, { lastHeartbeatAt: r.lastHeartbeatAt });
      });
    }
    this.flush();
  }

  forget(proxyId: string): void {
    this.mem.delete(proxyId);
    this.caps.delete(proxyId);
    this.dirty.delete(proxyId);
  }

  view(proxyId: string): ProxyView {
    const p = this.d.registry.proxyById(proxyId);
    if (!p) throw new Error(`no proxy ${proxyId}`);
    return this.viewOf(p);
  }

  // The view of a proxy row the caller already has.
  viewOf(p: Proxy): ProxyView {
    const proxyId = p.id;
    const s = this.row(proxyId);
    const state = deriveProxyState(p, s, !!this.d.registry.activeKey(proxyId), this.d.clock.now(), this.d.offlineAfterMs);
    const summary = s?.summary as { unreadable?: string } | null;
    return {
      proxyId, accountId: p.accountId, state, connected: s?.connected ?? false, connectedSince: s?.connectedSince ?? null, lastHelloAt: s?.lastHelloAt ?? null,
      lastHeartbeatAt: s?.lastHeartbeatAt ?? null, closedReason: s?.closedReason ?? null, version: s?.proxyVersion ?? null, skewMs: s?.clockSkewMs ?? null,
      skewProblem: s?.clockSkewMs != null && Math.abs(s.clockSkewMs) > SKEW_PROBLEM_MS, ok: s?.ok ?? null, problemCount: s?.problemCount ?? null,
      cameras: cameraStates(s, state), pin: pinState(p.caFingerprints, s?.reported?.caFingerprint ?? []), unreadable: summary?.unreadable ?? null,
      stale: !!s && s.lastHelloAt !== null && !this.seenThisRun.has(proxyId),
    };
  }

  // Status events, newest first, paged by id.
  events(proxyId: string, limit = 50, cursor?: number): { items: { id: number; at: number; kind: string; cameraRef: string | null; detail: unknown }[]; nextCursor: number | null } {
    const lim = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
    if (cursor !== undefined && !Number.isFinite(cursor)) cursor = undefined;
    const rows = this.d.db.prepare(`SELECT * FROM status_events WHERE proxy_id = ? ${cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(cursor ? [proxyId, cursor, lim + 1] : [proxyId, lim + 1])) as Row[];
    const items = rows.slice(0, lim).map((r) => ({ id: r.id as number, at: r.at as number, kind: r.kind as string, cameraRef: r.camera_ref as string | null, detail: r.detail ? JSON.parse(r.detail as string) : null }));
    return { items, nextCursor: rows.length > lim ? items[items.length - 1].id : null };
  }

  pruneEvents(): void {
    tx(this.d.db, () => this.d.db.prepare('DELETE FROM status_events WHERE at < ?').run(this.d.clock.now() - 90 * 86400_000));
  }
}
