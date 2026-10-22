import type { ApiDeps } from '../api/router';
import { reconcile } from '../status/derive';
import { snapshotRevision } from '../cams/snapshot';
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
          held: rep.held ?? [], heldProxies: rep.heldProxies ?? [], keptOld: rep.keptOld ?? [],
          shadow: rep.shadow ?? null, tokens: rep.tokens ?? null,
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
      host: c.host, protocol: c.protocol, tlsServername: c.tlsServername, cameraUser: c.cameraUser, webUiUrl: c.webUiUrl,
      moveId: moveIds.get(c.id) ?? null,
      online: c.proxyId ? (view.get(c.proxyId)?.cameras.find((x) => x.ref === c.proxyCameraId)?.online ?? null) : null,
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
