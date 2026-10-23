import type { ApiDeps } from '../api/router';
import { reconcile } from '../status/derive';
import { snapshotRevision } from '../cams/snapshot';
import { createHash } from 'crypto';
import type { AuditFilter } from '../audit';
import { chunkCounts, moveView } from '../moves/view';

// What the diagnostics API shows (issue #45). Every field is named one by
// one, nothing is spread from a row: no token, hash, code, key, password,
// e-mail address or free-text note leaves here (test/diag.test.ts fills
// those columns with a marker and greps every answer).

interface SummaryItem { id?: string; label?: string; text?: string; problem?: boolean }
interface Summary { ok?: boolean; problemCount?: number; generatedAt?: number; unreadable?: string; items?: SummaryItem[]; cameras?: { camera?: { id?: string; name?: string; online?: boolean }; items?: SummaryItem[] }[] }

const item = (i: SummaryItem) => ({ id: i.id ?? null, label: i.label ?? null, text: i.text ?? null });

// The problem items of a proxy's last summary (the proxy's own words: label and text).
function problems(s: Summary | null) {
  if (!s) return [];
  const out = (s.items ?? []).filter((i) => i.problem).map((i) => ({ camera: null as string | null, ...item(i) }));
  for (const c of s.cameras ?? []) for (const i of c.items ?? []) if (i.problem) out.push({ camera: c.camera?.id ?? null, ...item(i) });
  return out.slice(0, 100);
}

export function diagProxies(d: ApiDeps) {
  const cams = d.registry.listCameras();
  return {
    items: d.registry.listProxies().map((px) => {
      const v = d.status.viewOf(px);
      const row = d.status.row(px.id);
      const s = (row?.summary ?? null) as Summary | null;
      const rep = row?.reported ?? null;
      const accCams = cams.filter((c) => c.accountId === px.accountId);
      return {
        id: px.id, accountId: px.accountId, name: px.name, displayName: px.displayName, runsOn: px.runsOn, registryState: px.state,
        url: px.url, adminUiUrl: px.adminUiUrl, dnsName: px.dnsName, tlsSite: px.tlsSite, tlsServername: px.tlsServername, caFingerprints: px.caFingerprints,
        state: v.state, connected: v.connected, lastHeartbeatAt: v.lastHeartbeatAt, closedReason: v.closedReason, version: v.version,
        pin: v.pin, skewMs: v.skewMs, ok: v.ok, problemCount: v.problemCount, unreadable: v.unreadable, problems: problems(s), summaryAt: row?.summaryAt ?? null,
        commands: v.commands, allow: v.allow, cameras: v.cameras,
        reported: rep && {
          site: rep.site ?? null, publicUrl: rep.publicUrl ?? null, caFingerprints: rep.caFingerprint, uptimeS: rep.uptimeS ?? null, configRevision: rep.configRevision ?? null,
          capabilities: rep.capabilities ?? [], tokens: rep.tokens ? { revision: rep.tokens.revision, client: rep.tokens.client, admin: rep.tokens.admin, blocked: rep.tokens.blocked.length } : null,
          commands: rep.commands ? { enabled: rep.commands.enabled, paused: rep.commands.paused, pauseReason: rep.commands.pauseReason } : null,
        },
        reconcile: reconcile(px, accCams.filter((c) => c.proxyId === px.id), new Set(accCams.map((c) => c.camsId)), row),
      };
    }),
  };
}

const trust = (h: { accountId: string; camsId: string; fields: string[] }) => ({ accountId: h.accountId, camsId: h.camsId, fields: [...h.fields] });

export function diagCamsInstances(d: ApiDeps) {
  const fp = d.serverKeyFingerprints[0] ?? '';
  return {
    items: d.camsInstances.list().map((i) => {
      const rep = i.live.report;
      const current = snapshotRevision(d.db, i.id, fp);
      return {
        id: i.id, name: i.name, displayName: i.displayName, baseUrl: i.baseUrl, state: i.state, accounts: i.accounts, rotateBefore: i.rotateBefore,
        lastSeenAt: i.live.lastSeenAt, lastPullAt: i.live.lastPullAt, lastPullStatus: i.live.lastPullStatus, reportAt: i.live.reportAt,
        routes: d.camsInstances.routes(i.id).map((r) => ({ proxyId: r.proxyId, accountId: r.accountId, url: r.url, hidden: r.hidden })),
        report: rep && {
          mode: rep.mode, version: rep.version ?? null, appliedRevision: rep.appliedRevision ?? null, currentRevision: current, current: rep.appliedRevision === current,
          cacheVerifiedAt: rep.cacheVerifiedAt ?? null, lastPullAt: rep.lastPullAt ?? null,
          held: (rep.held ?? []).map(trust), heldProxies: (rep.heldProxies ?? []).map((h) => ({ accountId: h.accountId, proxyId: h.proxyId, fields: [...h.fields] })), keptOld: (rep.keptOld ?? []).map(trust),
          shadow: rep.shadow ? { accountId: rep.shadow.accountId, differences: rep.shadow.differences, items: [...rep.shadow.items] } : null,
          tokens: rep.tokens ? { managed: rep.tokens.managed, pending: rep.tokens.pending, legacy: rep.tokens.legacy } : null,
          problems: (rep.problems ?? []).map((p) => ({ code: p.code, accountId: p.accountId ?? null, detail: p.detail ?? null })),
        },
      };
    }),
  };
}

export function diagCameras(d: ApiDeps) {
  const view = new Map(d.registry.listProxies().map((px) => [px.id, d.status.viewOf(px)]));
  const moveIds = new Map((d.db.prepare('SELECT id, move_id FROM cameras WHERE move_id IS NOT NULL').all() as { id: string; move_id: string }[]).map((r) => [r.id, r.move_id]));
  return {
    items: d.registry.listCameras().map((c) => ({
      id: c.id, accountId: c.accountId, camsId: c.camsId, name: c.name, kind: c.kind, model: c.model, proxyId: c.proxyId, proxyCameraId: c.proxyCameraId,
      host: c.host, protocol: c.protocol, tlsServername: c.tlsServername,
      moveId: moveIds.get(c.id) ?? null,
      online: c.proxyId ? (view.get(c.proxyId)?.cameras.find((x) => x.ref === c.proxyCameraId)?.online ?? null) : null,
    })),
  };
}

// Every proxy's managed tokens: who holds each (a cams instance by name, or
// "manual"), its state and age. No hash, not even a prefix; the creator's
// e-mail is masked like the audit's.
export function diagTokens(d: ApiDeps) {
  const names = new Map(d.camsInstances.list().map((i) => [i.id, i.name]));
  return {
    items: d.registry.listProxies().map((px) => {
      const t = d.tokens.list(px.accountId, px.id);
      return {
        proxyId: px.id, proxyName: px.name, revision: t.revision, appliedRevision: t.appliedRevision,
        tokens: t.items.map((x) => ({
          id: x.id, kind: x.kind, holder: x.holder, holderName: names.get(x.holder) ?? null, label: mask(x.label), state: x.state, onProxy: x.onProxy,
          createdAt: x.createdAt, createdBy: mask(x.createdBy), retireAt: x.retireAt, revokedAt: x.revokedAt,
          lastCommand: x.lastCommand && { state: x.lastCommand.state, outcomeCode: x.lastCommand.outcomeCode },
        })),
      };
    }),
  };
}

// The operations tokens: name, scopes, state and age. Only the 8-hex hash
// prefix, never the token; e-mail addresses are masked like the audit's.
export function diagOpsTokens(d: ApiDeps) {
  return {
    items: d.ops.list().items.map((t) => ({
      id: t.id, name: t.name, scopes: t.scopes, hashPrefix: t.hashPrefix, state: t.state,
      createdAt: t.createdAt, createdBy: mask(t.createdBy), expiresAt: t.expiresAt,
      revokedAt: t.revokedAt, revokedBy: t.revokedBy === null ? null : mask(t.revokedBy), lastUsedAt: t.lastUsedAt,
    })),
  };
}

export function diagMoves(d: ApiDeps, accountId: string | undefined) {
  return {
    items: d.moves.store.list(accountId).map((m) => {
      const cur = d.moves.current(m.id) ?? m;
      return { ...moveView(d.db, cur), chunks: chunkCounts(d.moves.chunkStates(cur.id)) };
    }),
  };
}

// The audit log without e-mail addresses (sysadmins as actors, users as
// targets or in details): each becomes "email:" + 8 hex of its SHA-256, so
// records of one person still match each other.
const EMAIL_RE = /[^\s@"<>()]+@[^\s@"<>()]+\.[^\s@"<>()]+/g;
const mask = (s: string) => s.replace(EMAIL_RE, (e) => `email:${createHash('sha256').update(e.toLowerCase()).digest('hex').slice(0, 8)}`);
function redact(v: unknown): unknown {
  if (typeof v === 'string') return mask(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
}
export function diagAudit(d: ApiDeps, f: AuditFilter) {
  const r = d.audit.list(f);
  return { items: r.items.map((i) => redact(i)), nextCursor: r.nextCursor };
}
