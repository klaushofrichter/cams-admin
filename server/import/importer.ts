import type { Clock } from '../clock';
import type { Audit } from '../audit';
import { tx, type Db } from '../db/open';
import { ApiError, type Proxy, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { CamsInstances } from '../cams/instances';
import { sha256hex } from '../crypto/ed25519';
import { newId } from '../ids';
import { groupKey, parseCamsExport, trimUrl, type ExportCamera, type ExportProxy } from './export-format';
export { parseCamsExport } from './export-format';

// The importer of M §11.2 (plan Task 8, ruling R4-6): a cams export into one
// account, for one cams instance. Dry run by default; apply writes it all in
// one transaction. It never deletes, never changes a proxy's registered URL
// (another instance's URL becomes this instance's route), and cross-checks
// against what the live proxies report (heartbeat cameras and CA pin; never
// a command, R4-17). Hashes leave only as 8-hex prefixes.

export type ImportChange =
  | { kind: 'proxy-matched'; proxyId: string; name: string; by: 'token' | 'url' | 'route'; fileUrl: string }
  | { kind: 'proxy-new'; name: string; url: string }
  // url null: the proxy's registered URL (the file uses it).
  | { kind: 'route-add' | 'route-change'; proxyId: string; name: string; url: string | null; was?: string | null }
  | { kind: 'route-hide'; proxyId: string; name: string }
  | { kind: 'camera-new'; camsId: string; fields: Record<string, unknown> }
  | { kind: 'camera-change'; cameraId: string; camsId: string; fields: Record<string, { from: unknown; to: unknown }> }
  | { kind: 'pins-set'; proxyId: string; name: string; from: string[]; to: string[] }
  | { kind: 'proxy-tls-name'; proxyId: string; name: string; from: string | null; to: string | null }
  | { kind: 'token-external'; proxyId: string; name: string; tokenKind: 'client' | 'admin'; hashPrefix: string }
  | { kind: 'registry-only'; camsId: string };
export interface ImportMismatch { id: string; camsId?: string; proxyId?: string; what: 'camera-not-on-proxy' | 'pin-differs' | 'pin-unverified' | 'proxy-offline' | 'proxy-not-enrolled' | 'proxy-ambiguous' | 'token-in-other-account'; detail: string }
export interface ImportResult {
  dryRun: boolean; account: string; instance: string; changes: ImportChange[]; mismatches: ImportMismatch[]; blockers: string[];
  blocked: boolean; applied: boolean; noChanges: boolean;
}
export interface ImportOptions { apply: boolean; acceptMismatch: string[]; createProxies: boolean; hideUnlisted: boolean }
export interface ImporterDeps { db: Db; clock: Clock; audit: Audit; registry: Registry; instances: CamsInstances; status: StatusStore }

const INFO = new Set(['proxy-matched', 'registry-only']);
const prefix = (hex: string) => `sha256:${hex.slice(0, 8)}`;
const mismatchId = (what: string, proxyId: string, camsId = '') => sha256hex(`${what}|${proxyId}|${camsId}`).slice(0, 12);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

interface Group { key: string; url: string; proxy: ExportProxy; cameras: ExportCamera[]; target: Proxy | null; newName: string | null }

// A proxy name from a URL host: its first label, as a proxy name.
function nameFromUrl(url: string, taken: Set<string>): string {
  const host = new URL(url).hostname;
  const base = (host.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'proxy').slice(0, 28);
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}-${i++}`;
  taken.add(n);
  return n;
}

export class Importer {
  constructor(private d: ImporterDeps) {}

  run(actor: string, accountId: string, instanceId: string, raw: unknown, o: ImportOptions): ImportResult {
    const file = parseCamsExport(raw);
    const account = this.d.registry.getAccount(accountId);
    const instance = this.d.instances.get(instanceId);
    if (!instance.accounts.includes(accountId)) throw new ApiError(400, 'invalid', 'instanceId');
    const q = (sql: string) => this.d.db.prepare(sql);
    const proxies = this.d.registry.listProxies(accountId);
    const byId = new Map(proxies.map((p) => [p.id, p]));
    // Only this account's routes (review I2: a route of another served account must never match).
    const routes = new Map(this.d.instances.routes(instanceId).filter((r) => byId.has(r.proxyId)).map((r) => [r.proxyId, r]));
    const changes: ImportChange[] = [];
    const mismatches: ImportMismatch[] = [];
    const blockers: string[] = [];
    const takenNames = new Set(proxies.map((p) => p.name));

    // --- proxy groups and their match (R4-6: token hash, registered URL, this instance's route) ---
    const groups = new Map<string, Group>();
    for (const c of file.cameras) {
      if (!c.proxy) continue;
      const k = groupKey(c.proxy);
      const g = groups.get(k);
      if (g) g.cameras.push(c);
      else groups.set(k, { key: k, url: trimUrl(c.proxy.url)!, proxy: c.proxy, cameras: [c], target: null, newName: null });
    }
    const byHash = (hex: string) => (q('SELECT proxy_id FROM proxy_tokens WHERE hash = ? AND account_id = ?').get(`sha256:${hex}`, accountId) as { proxy_id: string } | undefined)?.proxy_id;
    for (const g of groups.values()) {
      const tokenIds = [byHash(g.proxy.token.sha256), g.proxy.adminToken ? byHash(g.proxy.adminToken.sha256) : undefined].filter((x): x is string => !!x);
      let by: 'token' | 'url' | 'route' | null = null;
      let ids: string[] = [...new Set(tokenIds)];
      if (ids.length) by = 'token';
      else {
        ids = proxies.filter((p) => trimUrl(p.url) === g.url).map((p) => p.id);
        if (ids.length) by = 'url';
        else {
          ids = [...routes.values()].filter((r) => !r.hidden && trimUrl(r.url) === g.url).map((r) => r.proxyId);
          if (ids.length) by = 'route';
        }
      }
      if (ids.length > 1) {
        // A blocker, never an acceptable mismatch (review I2): no proxy is guessed.
        mismatches.push({ id: mismatchId('proxy-ambiguous', ids.join(','), g.url), what: 'proxy-ambiguous', detail: `${g.url} matches ${ids.length} proxies` });
        if (!blockers.includes('proxy_ambiguous')) blockers.push('proxy_ambiguous');
        continue;
      }
      if (ids.length === 1 && by) {
        g.target = byId.get(ids[0]) ?? null;
        if (g.target) changes.push({ kind: 'proxy-matched', proxyId: g.target.id, name: g.target.name, by, fileUrl: g.url });
        continue;
      }
      g.newName = nameFromUrl(g.url, takenNames);
      changes.push({ kind: 'proxy-new', name: g.newName, url: g.url });
      if (!o.createProxies && !blockers.includes('unknown_proxy')) blockers.push('unknown_proxy');
    }

    // --- per matched proxy: route, pins, TLS name, cross-checks ------------------------------
    const matched = new Set<string>();
    for (const g of groups.values()) {
      const px = g.target;
      if (!px) continue;
      if (matched.has(px.id)) continue; // a second group of the same proxy (another token): routes and pins once
      matched.add(px.id);
      // Routes are default-deny (review I1): every proxy the file uses gets a
      // visible route for this instance; null = the registered URL.
      const route = routes.get(px.id);
      const want = trimUrl(px.url) === g.url ? null : g.url;
      if (!route) changes.push({ kind: 'route-add', proxyId: px.id, name: px.name, url: want });
      else if (route.hidden || trimUrl(route.url ?? px.url) !== g.url) changes.push({ kind: 'route-change', proxyId: px.id, name: px.name, url: want, was: route.hidden ? null : route.url ?? px.url });
      if (g.proxy.caFingerprint && !sameList(g.proxy.caFingerprint, px.caFingerprints)) changes.push({ kind: 'pins-set', proxyId: px.id, name: px.name, from: px.caFingerprints, to: g.proxy.caFingerprint });
      if (g.proxy.tlsServername && g.proxy.tlsServername !== px.tlsServername) changes.push({ kind: 'proxy-tls-name', proxyId: px.id, name: px.name, from: px.tlsServername, to: g.proxy.tlsServername });
    }
    for (const g of groups.values()) {
      const px = g.target;
      if (!px) continue;
      const row = this.d.status.row(px.id);
      if (px.state !== 'enrolled') {
        mismatches.push({ id: mismatchId('proxy-not-enrolled', px.id), proxyId: px.id, what: 'proxy-not-enrolled', detail: `${px.name} is ${px.state}` });
        continue;
      }
      if (!row?.online || !row.reported) {
        if (!mismatches.some((m) => m.what === 'proxy-offline' && m.proxyId === px.id)) mismatches.push({ id: mismatchId('proxy-offline', px.id), proxyId: px.id, what: 'proxy-offline', detail: `${px.name} is offline: nothing to compare with` });
        continue;
      }
      const refs = new Set(row.reported.cameras.map((c) => c.ref));
      for (const c of g.cameras) {
        const ref = c.proxy?.camera ?? c.id;
        if (!refs.has(ref)) mismatches.push({ id: mismatchId('camera-not-on-proxy', px.id, c.id), camsId: c.id, proxyId: px.id, what: 'camera-not-on-proxy', detail: `${px.name} does not report camera ${ref}` });
      }
      const filePin = g.proxy.caFingerprint?.[0];
      if (filePin) {
        const rep = row.reported.caFingerprint[0];
        let repN: string | null = null;
        try { repN = rep ? 'SHA256:' + rep.replace(/^sha256:/i, '').replace(/:/g, '').toUpperCase() : null; } catch { repN = null; }
        if (repN !== filePin && !mismatches.some((m) => m.what === 'pin-differs' && m.proxyId === px.id)) {
          mismatches.push({ id: mismatchId('pin-differs', px.id), proxyId: px.id, what: 'pin-differs', detail: `${px.name} reports ${repN ? repN.slice(0, 15) + '…' : 'no CA'}, the file pins ${filePin.slice(0, 15)}…` });
        }
      }
      // Every further pin must be one the proxy reports, else it is an unverified CA (review M9).
      const reported = new Set(row.reported.caFingerprint.map((x) => 'SHA256:' + x.replace(/^sha256:/i, '').replace(/:/g, '').toUpperCase()));
      for (const extra of (g.proxy.caFingerprint ?? []).slice(1)) {
        const id = mismatchId('pin-unverified', px.id, extra.slice(7, 23));
        if (!reported.has(extra) && !mismatches.some((m) => m.id === id)) mismatches.push({ id, proxyId: px.id, what: 'pin-unverified', detail: `${px.name} does not report the file's second CA ${extra.slice(0, 15)}…` });
      }
    }

    // --- hidden routes for the account's other proxies --------------------------------------
    if (o.hideUnlisted) {
      // Without a route a proxy is already invisible: only visible routes the file doesn't use are hidden.
      for (const p of proxies) if (!matched.has(p.id) && routes.has(p.id) && !routes.get(p.id)!.hidden) changes.push({ kind: 'route-hide', proxyId: p.id, name: p.name });
    }

    // --- tokens the registry doesn't know: external (never in a tokens.apply) -----------------
    const owner = (hex: string) => (q('SELECT account_id FROM proxy_tokens WHERE hash = ?').get(`sha256:${hex}`) as { account_id: string } | undefined)?.account_id;
    const known = (hex: string) => {
      const acc = owner(hex);
      if (acc && acc !== accountId) {
        // Held in another account: not recorded here, and said so (review M4).
        const id = mismatchId('token-in-other-account', '', hex.slice(0, 8));
        if (!mismatches.some((m) => m.id === id)) mismatches.push({ id, what: 'token-in-other-account', detail: `the token ${prefix(hex)} is registered in another account: not recorded as external here` });
      }
      return !!acc;
    };
    const externals: { g: Group; kind: 'client' | 'admin'; hex: string }[] = [];
    const seenHex = new Set<string>();
    for (const g of groups.values()) {
      if (!g.target && !g.newName) continue;
      for (const [kind, h] of [['client', g.proxy.token], ['admin', g.proxy.adminToken]] as const) {
        if (!h || known(h.sha256) || seenHex.has(h.sha256)) continue;
        seenHex.add(h.sha256);
        externals.push({ g, kind, hex: h.sha256 });
        changes.push({ kind: 'token-external', proxyId: g.target?.id ?? `new:${g.newName}`, name: g.target?.name ?? g.newName!, tokenKind: kind, hashPrefix: prefix(h.sha256) });
      }
    }

    // --- cameras: matched by (account, camsId); never deleted ----------------------------------
    const registry = new Map(this.d.registry.listCameras(accountId).map((c) => [c.camsId, c]));
    const groupOf = (c: ExportCamera) => (c.proxy ? groups.get(groupKey(c.proxy)) : undefined);
    const fieldsOf = (c: ExportCamera) => {
      const g = groupOf(c);
      return {
        name: c.name, host: c.host, protocol: c.protocol, tlsServername: c.tlsServername ?? null, cameraUser: c.user, webUiUrl: c.webUiUrl ?? null, webUiNote: c.webUiNote ?? null,
        // A camera with a proxy in the file never becomes a direct camera (review I2).
        proxyId: c.proxy ? g?.target?.id ?? (g?.newName ? `new:${g.newName}` : `unresolved:${g?.url ?? c.proxy.url}`) : null, proxyCameraId: c.proxy ? c.proxy.camera ?? c.id : null,
      };
    };
    for (const c of file.cameras) {
      const f = fieldsOf(c);
      const old = registry.get(c.id);
      if (!old) {
        changes.push({ kind: 'camera-new', camsId: c.id, fields: f });
        continue;
      }
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, v] of Object.entries(f)) {
        const was = (old as unknown as Record<string, unknown>)[k] ?? null;
        if (was !== v) diff[k] = { from: was, to: v };
      }
      if (Object.keys(diff).length) changes.push({ kind: 'camera-change', cameraId: old.id, camsId: c.id, fields: diff });
    }
    const inFile = new Set(file.cameras.map((c) => c.id));
    for (const c of registry.values()) if (!inFile.has(c.camsId)) changes.push({ kind: 'registry-only', camsId: c.camsId });

    const accepted = new Set(o.acceptMismatch);
    const blocked = blockers.length > 0 || mismatches.some((m) => !accepted.has(m.id));
    const noChanges = changes.every((c) => INFO.has(c.kind));
    const result: ImportResult = { dryRun: !o.apply, account: account.name, instance: instance.name, changes, mismatches, blockers, blocked, applied: false, noChanges };
    const counts: Record<string, number> = {};
    for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    const record = (action: 'import-run' | 'import-apply', extra: Record<string, unknown> = {}) => this.d.audit.write({
      actorType: 'sysadmin', actor, action, accountId, targetType: 'cams-instance', targetId: instanceId, targetLabel: instance.name, outcome: 'ok',
      detail: { instance: instance.name, changes: counts, mismatches: mismatches.length, blocked: result.blocked, ...extra },
    });

    // Defense in depth: nothing unresolved reaches the registry.
    const unresolved = changes.some((c) => (c.kind === 'camera-new' && String(c.fields.proxyId).startsWith('unresolved:')) || (c.kind === 'camera-change' && String(c.fields.proxyId?.to).startsWith('unresolved:')));
    if (unresolved && !blockers.includes('unresolved_proxy')) { blockers.push('unresolved_proxy'); result.blocked = true; }
    if (!o.apply || result.blocked || noChanges) {
      record('import-run', { apply: o.apply, ...(o.apply && noChanges ? { noChanges: true } : {}) });
      return result;
    }

    tx(this.d.db, () => {
      // New proxies first (their ids are needed below).
      for (const g of groups.values()) {
        if (g.target || !g.newName) continue;
        g.target = this.d.registry.createProxy(actor, accountId, {
          name: g.newName, displayName: g.newName, runsOn: 'local-host', url: g.url,
          ...(g.proxy.caFingerprint ? { caFingerprints: g.proxy.caFingerprint } : {}), ...(g.proxy.tlsServername ? { tlsServername: g.proxy.tlsServername } : {}),
        });
      }
      const newIds = new Map([...groups.values()].filter((g) => g.newName && g.target).map((g) => [`new:${g.newName}`, g.target!.id]));
      const real = (id: unknown) => (typeof id === 'string' && newIds.has(id) ? newIds.get(id)! : id);
      for (const c of changes) {
        if (c.kind === 'route-add' || c.kind === 'route-change') this.d.instances.setRoute(actor, instanceId, c.proxyId, { url: c.url, hidden: false });
        else if (c.kind === 'route-hide') this.d.instances.setRoute(actor, instanceId, c.proxyId, { url: null, hidden: true });
        else if (c.kind === 'pins-set' || c.kind === 'proxy-tls-name') {
          const p = this.d.registry.getProxy(accountId, c.proxyId);
          this.d.registry.updateProxy(actor, accountId, c.proxyId, { ...(c.kind === 'pins-set' ? { caFingerprints: c.to } : { tlsServername: c.to }), version: p.version });
        }
      }
      for (const e of externals) {
        const proxyId = e.g.target!.id;
        const rev = (q('SELECT revision FROM proxy_token_state WHERE proxy_id = ?').get(proxyId) as { revision: number } | undefined)?.revision ?? 0;
        q(`INSERT INTO proxy_tokens (id, account_id, proxy_id, kind, holder, label, hash, state, issued_revision, created_at, created_by) VALUES (?,?,?,?, 'manual', ?, ?, 'external', ?, ?, ?)`)
          .run(newId('tok'), accountId, proxyId, e.kind, `imported ${new URL(e.g.url).host}`.slice(0, 64), `sha256:${e.hex}`, rev, this.d.clock.now(), actor);
      }
      for (const c of changes) {
        if (c.kind === 'camera-new') {
          const f = { ...c.fields, proxyId: real(c.fields.proxyId) };
          this.d.registry.createCamera(actor, accountId, { camsId: c.camsId, kind: 'camera', ...f });
        } else if (c.kind === 'camera-change') {
          const cam = this.d.registry.getCamera(accountId, c.cameraId);
          const patch: Record<string, unknown> = { version: cam.version };
          for (const [k, v] of Object.entries(c.fields)) patch[k] = real(v.to);
          this.d.registry.updateCamera(actor, accountId, c.cameraId, patch);
        }
      }
      record('import-apply', { accepted: [...accepted].filter((id) => mismatches.some((m) => m.id === id)), externalTokens: externals.length });
    });
    result.applied = true;
    return result;
  }
}
