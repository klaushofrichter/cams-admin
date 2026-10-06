import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import type { Registry } from '../registry';
import type { LiveHub, LiveStatus } from '../live';
import { validateSummary } from '../contract';
import { cameraStates, deriveProxyState, heartbeatFresh, pinState, SKEW_PROBLEM_MS, type PinState, type ProxyState, type Reported, type StatusRow } from './derive';

// The latest state of each proxy (proxy_status) and its transitions
// (status_events), fed by the channel; spec §8.5, §8.6. Everything shown on
// the dashboard is stored, so a restart shows the last known state.

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

const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 2) : []);

export class StatusStore {
  // Proxies whose stored status predates this process (stale until they say hello).
  private seenThisRun = new Set<string>();
  constructor(private d: { db: Db; clock: Clock; registry: Registry; live: LiveHub; offlineAfterMs: number }) {}

  row(proxyId: string): StatusRow | null {
    const r = this.d.db.prepare('SELECT * FROM proxy_status WHERE proxy_id = ?').get(proxyId) as Row | undefined;
    return r ? toStatus(r) : null;
  }

  private exists(proxyId: string): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM proxies WHERE id = ?').get(proxyId);
  }

  private event(proxyId: string, kind: string, cameraRef: string | null = null, detail: Record<string, unknown> | null = null): void {
    this.d.db.prepare('INSERT INTO status_events (proxy_id, camera_ref, at, kind, detail) VALUES (?,?,?,?,?)').run(proxyId, cameraRef, this.d.clock.now(), kind, detail ? JSON.stringify(detail).slice(0, 2048) : null);
  }

  private ensureRow(proxyId: string): void {
    this.d.db.prepare('INSERT INTO proxy_status (proxy_id) VALUES (?) ON CONFLICT(proxy_id) DO NOTHING').run(proxyId);
  }

  // A proxy that was deleted while connected: nothing to write, never a throw.
  private guarded(proxyId: string, fn: () => void): void {
    if (!this.exists(proxyId)) return;
    tx(this.d.db, () => {
      this.ensureRow(proxyId);
      fn();
    });
    this.publish(proxyId);
  }

  hello(proxyId: string, version: string | null, proxyTs: number): void {
    this.seenThisRun.add(proxyId);
    this.guarded(proxyId, () => {
      const now = this.d.clock.now();
      const old = this.row(proxyId)!;
      this.d.db.prepare(`UPDATE proxy_status SET connected = 1, connected_since = ?, last_hello_at = ?, stopped = 0, closed_reason = NULL,
        proxy_version = COALESCE(?, proxy_version), clock_skew_ms = ? WHERE proxy_id = ?`).run(now, now, version, proxyTs - now, proxyId);
      this.d.db.prepare('UPDATE proxy_keys SET last_seen_at = ? WHERE proxy_id = ? AND revoked_at IS NULL').run(now, proxyId);
      this.event(proxyId, 'connected');
      if (version && old.proxyVersion && version !== old.proxyVersion) this.event(proxyId, 'version-changed', null, { from: old.proxyVersion, to: version });
    });
  }

  heartbeat(proxyId: string, body: HeartbeatBody, proxyTs: number): void {
    this.guarded(proxyId, () => {
      const now = this.d.clock.now();
      const old = this.row(proxyId)!;
      const v = validateSummary(body.summary, body.truncated === true);
      const info = (body.proxy && typeof body.proxy === 'object' ? body.proxy : {}) as Record<string, unknown>;
      const tls = (info.tls && typeof info.tls === 'object' ? info.tls : null) as Record<string, unknown> | null;
      const reportedFps = asStrArray(tls?.caFingerprint);
      const proxy = this.d.registry.proxyById(proxyId)!;
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
      };
      this.d.db.prepare(`UPDATE proxy_status SET last_heartbeat_at = ?, summary = ?, summary_at = ?, ok = ?, problem_count = ?, reported = ?, clock_skew_ms = ?,
        proxy_version = COALESCE(?, proxy_version), online = 1, stopped = 0 WHERE proxy_id = ?`)
        .run(now, JSON.stringify(summary), summaryAt, ok ? 1 : 0, problemCount, JSON.stringify(reported), proxyTs - now, version, proxyId);

      // Transitions, each once (spec §8.6).
      if (!old.online) this.event(proxyId, 'online');
      if (old.summary !== null && (old.ok !== ok || old.problemCount !== problemCount)) this.event(proxyId, 'problems-changed', null, { ok, problemCount });
      const before = new Map((old.reported?.cameras ?? []).map((c) => [c.ref, c.online]));
      for (const c of cams) {
        const was = before.get(c.ref);
        if (was !== undefined && was !== c.online) this.event(proxyId, c.online ? 'camera-online' : 'camera-offline', c.ref);
      }
      if (version && old.proxyVersion && version !== old.proxyVersion) this.event(proxyId, 'version-changed', null, { from: old.proxyVersion, to: version });
      const oldPin = old.reported?.pin ?? 'none';
      if (pin === 'mismatch' && oldPin !== 'mismatch') this.event(proxyId, 'pin-mismatch');
      if (pin === 'match' && oldPin === 'mismatch') this.event(proxyId, 'pin-match');
    });
  }

  disconnected(proxyId: string, reason: string): void {
    this.guarded(proxyId, () => {
      this.d.db.prepare('UPDATE proxy_status SET connected = 0, closed_reason = ? WHERE proxy_id = ?').run(reason.slice(0, 200), proxyId);
      this.event(proxyId, 'disconnected', null, { reason: reason.slice(0, 200) });
    });
  }

  // A deliberate stop is not an outage (spec §8.6).
  bye(proxyId: string, reason: string): void {
    if (reason !== 'shutdown' && reason !== 'restart') return;
    this.guarded(proxyId, () => {
      this.d.db.prepare(`UPDATE proxy_status SET stopped = 1, online = 0, closed_reason = ? WHERE proxy_id = ?`).run(`bye:${reason}`, proxyId);
      this.event(proxyId, 'stopped', null, { reason });
    });
  }

  // Liveness tick: online → offline when the heartbeat aged out.
  tick(): void {
    const now = this.d.clock.now();
    const rows = (this.d.db.prepare('SELECT * FROM proxy_status WHERE online = 1').all() as Row[]).map(toStatus);
    for (const s of rows) {
      if (heartbeatFresh(s, now, this.d.offlineAfterMs)) continue;
      this.guarded(s.proxyId, () => {
        this.d.db.prepare('UPDATE proxy_status SET online = 0 WHERE proxy_id = ?').run(s.proxyId);
        if (!s.stopped) this.event(s.proxyId, 'offline', null, { lastHeartbeatAt: s.lastHeartbeatAt });
      });
    }
  }

  view(proxyId: string): ProxyView {
    const p = this.d.registry.proxyById(proxyId);
    if (!p) throw new Error(`no proxy ${proxyId}`);
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

  liveStatus(proxyId: string): LiveStatus | null {
    if (!this.exists(proxyId)) return null;
    const v = this.view(proxyId);
    return { proxyId, accountId: v.accountId, state: v.state, ok: v.ok, problemCount: v.problemCount, lastHeartbeatAt: v.lastHeartbeatAt, cameras: v.cameras };
  }

  private publish(proxyId: string): void {
    const s = this.liveStatus(proxyId);
    if (s) this.d.live.publishStatus(s);
  }

  // Status events, newest first, paged by id.
  events(proxyId: string, limit = 50, cursor?: number): { items: { id: number; at: number; kind: string; cameraRef: string | null; detail: unknown }[]; nextCursor: number | null } {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = this.d.db.prepare(`SELECT * FROM status_events WHERE proxy_id = ? ${cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(cursor ? [proxyId, cursor, lim + 1] : [proxyId, lim + 1])) as Row[];
    const items = rows.slice(0, lim).map((r) => ({ id: r.id as number, at: r.at as number, kind: r.kind as string, cameraRef: r.camera_ref as string | null, detail: r.detail ? JSON.parse(r.detail as string) : null }));
    return { items, nextCursor: rows.length > lim ? items[items.length - 1].id : null };
  }

  pruneEvents(): void {
    tx(this.d.db, () => this.d.db.prepare('DELETE FROM status_events WHERE at < ?').run(this.d.clock.now() - 90 * 86400_000));
  }
}
