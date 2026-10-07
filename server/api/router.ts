import express from 'express';
import type { Request, Response } from 'express';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type ProxyKey, type Registry } from '../registry';
import type { Enrollment } from '../enroll/codes';
import type { Hub } from '../channel/hub';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Commands } from '../commands/service';
import type { Tokens } from '../tokens/service';
import type { CamsInstances } from '../cams/instances';
import type { Importer } from '../import/importer';
import { exportForInstance } from '../import/export';
import { snapshotRevision } from '../cams/snapshot';
import type { ProxyConfig } from '../config/service';
import type { RemoteActions } from '../actions/service';
import { SESSION_COOKIE, type Sessions } from '../auth/session';
import { requireCsrf, requireSysadmin, writeLimiter } from '../auth/middleware';
import { reconcile } from '../status/derive';
import { FieldError } from '../validate';
import { Buckets } from '../channel/limits';
import { limiter, sessionKey } from '../rateLimit';
import { monitorEventLoopDelay } from 'perf_hooks';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { writeHeapSnapshot } from 'v8';
import { readEpoch } from '../db/open';
import { bodyErrors } from '../bodyErrors';

export interface ManualBackup { at: number; ok: boolean; litestream: { ok: boolean; status?: string; error?: string }; snapshot: { ok: boolean; key?: string; bytes?: number; error?: string } }
export interface BackupState {
  lastSnapshotAt: number | null; lastSnapshotOk: boolean | null; lastSnapshotError: string | null;
  // The newest object of the Litestream replica in S3 (LastModified, ms).
  lastReplicationAt: number | null;
  // The S3 check: its last run, the last error (null after a success), the error count since start.
  lastReplicationCheckAt: number | null; lastReplicationError: string | null; replicationCheckErrors: number;
  // Litestream's own counters (null until its metrics were read).
  litestreamSyncErrors: number | null; litestreamReplicaErrors: number | null; litestreamMetricsError: string | null;
  lastManual: ManualBackup | null; alerts: string[]; configured: boolean; litestream: boolean; store: string;
}
export interface BackupService { state(): BackupState; backupNow(actor: string): Promise<ManualBackup | { busy: true }>; start?(): void; stop?(): void }

export interface ApiDeps {
  db: Db; clock: Clock; cfg: Config; audit: Audit; registry: Registry; enrollment: Enrollment; hub: Hub; status: StatusStore; live: LiveHub; sessions: Sessions; backup: BackupService;
  commands: Commands; tokens: Tokens; camsInstances: CamsInstances; serverKeyFingerprints: string[]; importer: Importer; config: ProxyConfig; actions: RemoteActions;
}

type H = (req: Request, res: Response) => unknown;
const p = (req: Request, k: string) => String(req.params[k]);
// Keys leave the API without their public key.
const keyView = ({ publicKey: _pk, ...k }: ProxyKey) => k;

export function apiRouter(d: ApiDeps): express.Router {
  const r = express.Router();
  // Every API request, per session (CodeQL-visible; the write limit below is tighter).
  r.use(limiter({ windowMs: 60_000, limit: 1200, key: (req) => sessionKey(req.cookies?.[SESSION_COOKIE]) }));
  // P4: an import carries a whole cams export (≤ 1 MiB); only a signed-in sysadmin's body is read that far.
  r.use('/accounts/:accountId/import', requireSysadmin(d.sessions), express.json({ limit: 1024 * 1024 }));
  r.use(express.json({ limit: 64 * 1024 }));
  r.use(requireSysadmin(d.sessions), requireCsrf(d.cfg), writeLimiter(d.cfg, d.clock));
  const actor = (res: Response): string => res.locals.session.email;
  // Async-safe handler with the API's error mapping.
  const h = (fn: H) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) {
        if (out === undefined) res.status(204).end();
        else res.status(res.locals.status ?? (req.method === 'POST' && res.locals.created ? 201 : 200)).json(out);
      }
    } catch (e) {
      if (e instanceof ApiError) return void res.status(e.status).json({ error: e.code, ...(e.field ? { field: e.field } : {}) });
      if (e instanceof FieldError) return void res.status(400).json({ error: 'invalid', field: e.field });
      throw e;
    }
  };
  const created = (res: Response) => (res.locals.created = true);
  const reg = (type: string, id: string) => d.live.publishRegistry(type, id);
  // At most 6 manual backups an hour, in total (each one is a full copy).
  const backupNowLimit = new Buckets({ capacity: 6, windowMs: 3600_000 });
  const limit = (req: Request) => (req.query.limit === undefined ? undefined : Number(req.query.limit));

  // --- session and live ---------------------------------------------------------------
  r.get('/me', h((_q, res) => ({ email: actor(res), expiresAt: res.locals.session.expiresAt })));
  r.get('/live', (req, res) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (!d.live.subscribe(res.locals.session.idHash, res, () => d.sessions.get(cookie) !== null)) res.status(429).json({ error: 'too_many_streams' });
  });
  r.post('/sessions/end', h((_q, res) => {
    const n = d.sessions.endAll();
    d.audit.write({ actorType: 'sysadmin', actor: actor(res), action: 'sessions-ended', outcome: 'ok', detail: { count: n } });
    return { ended: n };
  }));
  r.get('/dashboard', h(() => dashboard(d)));
  // The load test's view of the process (NODE_ENV=development only).
  if (d.cfg.nodeEnv === 'development') {
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    r.get('/dev/metrics', h((req) => {
      // ?gc=1 with --expose-gc: the live heap after a full GC (what a leak grows).
      const gc = (globalThis as { gc?: () => void }).gc;
      let heapAfterGcBytes: number | null = null;
      if (req.query.gc === '1' && typeof gc === 'function') {
        gc();
        heapAfterGcBytes = process.memoryUsage().heapUsed;
      }
      const out = {
        rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, heapAfterGcBytes,
        loopLagP50Ms: lag.percentile(50) / 1e6, loopLagP99Ms: lag.percentile(99) / 1e6, loopLagMaxMs: lag.max / 1e6,
        dbBytes: (() => { try { return statSync(d.cfg.dbFile).size + (existsSync(`${d.cfg.dbFile}-wal`) ? statSync(`${d.cfg.dbFile}-wal`).size : 0); } catch { return 0; } })(),
        writeEpoch: readEpoch(d.db), connections: d.hub.stats(), sseStreams: d.live.count(),
      };
      lag.reset();
      return out;
    }));
    // A V8 heap snapshot into the data folder (the load test's start/end diff).
    r.post('/dev/heap-snapshot', h(() => ({ file: writeHeapSnapshot(join(d.cfg.dataDir, `heap-${Date.now()}.heapsnapshot`)) })));
  }
  // "Backup now" (Klaus 2026-10-06): a Litestream sync + a manual snapshot.
  r.get('/backup', h(() => d.backup.state()));
  r.post('/backup/now', h(async (_q, res) => {
    const t = backupNowLimit.take('global', d.clock.now());
    if (!t.ok) throw new ApiError(429, 'rate_limited');
    return d.backup.backupNow(actor(res));
  }));

  // --- accounts and users ---------------------------------------------------------------
  r.get('/accounts', h(() => ({ items: d.registry.listAccounts() })));
  r.post('/accounts', h((req, res) => { created(res); const a = d.registry.createAccount(actor(res), req.body); reg('account', a.id); return a; }));
  r.get('/accounts/:accountId', h((req) => d.registry.getAccount(p(req, 'accountId'))));
  r.patch('/accounts/:accountId', h((req, res) => { const a = d.registry.updateAccount(actor(res), p(req, 'accountId'), req.body); reg('account', a.id); return a; }));
  r.delete('/accounts/:accountId', h((req, res) => {
    const id = p(req, 'accountId');
    // The typed name first: a mistake must disconnect nobody.
    if (req.body?.confirmName !== d.registry.getAccount(id).name) throw new ApiError(400, 'confirm_mismatch', 'confirmName');
    // Every live connection of its proxies closes before the rows go (4403).
    for (const px of d.registry.listProxies(id)) d.hub.closeProxy(px.id, 4403);
    d.registry.deleteAccount(actor(res), id, req.body?.confirmName);
    reg('account', id);
  }));
  r.get('/accounts/:accountId/users', h((req) => ({ items: d.registry.listUsers(p(req, 'accountId')) })));
  r.post('/accounts/:accountId/users', h((req, res) => { created(res); const u = d.registry.createUser(actor(res), p(req, 'accountId'), req.body); reg('user', u.id); return u; }));
  r.patch('/accounts/:accountId/users/:userId', h((req, res) => { const u = d.registry.updateUser(actor(res), p(req, 'accountId'), p(req, 'userId'), req.body); reg('user', u.id); return u; }));
  r.delete('/accounts/:accountId/users/:userId', h((req, res) => { d.registry.deleteUser(actor(res), p(req, 'accountId'), p(req, 'userId')); reg('user', p(req, 'userId')); }));
  r.get('/users', h((req) => ({ items: d.registry.usersByEmail(String(req.query.email ?? '')) })));

  // --- proxies --------------------------------------------------------------------------
  const proxyBase = '/accounts/:accountId/proxies/:proxyId';
  r.get('/accounts/:accountId/proxies', h((req) => {
    const acc = d.registry.getAccount(p(req, 'accountId'));
    return { items: d.registry.listProxies(acc.id).map((px) => ({ ...px, status: d.status.viewOf(px) })) };
  }));
  r.post('/accounts/:accountId/proxies', h((req, res) => { created(res); const px = d.registry.createProxy(actor(res), p(req, 'accountId'), req.body); reg('proxy', px.id); return px; }));
  r.get(proxyBase, h((req) => d.registry.getProxy(p(req, 'accountId'), p(req, 'proxyId'))));
  r.patch(proxyBase, h((req, res) => { const px = d.registry.updateProxy(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body); reg('proxy', px.id); return px; }));
  r.delete(proxyBase, h((req, res) => {
    const { keyIds } = d.registry.deleteProxy(actor(res), p(req, 'accountId'), p(req, 'proxyId'));
    for (const k of keyIds) d.hub.closeKey(k, 4403);
    reg('proxy', p(req, 'proxyId'));
  }));
  r.post(`${proxyBase}/enrollment-codes`, h((req, res) => {
    created(res);
    const c = d.enrollment.createCode(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body?.lifetimeH);
    reg('proxy', p(req, 'proxyId'));
    return c;
  }));
  r.delete(`${proxyBase}/enrollment-codes/:codeId`, h((req, res) => { d.enrollment.cancelCode(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'codeId')); reg('proxy', p(req, 'proxyId')); }));
  r.get(`${proxyBase}/keys`, h((req) => ({ items: d.registry.listKeys(p(req, 'accountId'), p(req, 'proxyId')).map(keyView) })));
  r.post(`${proxyBase}/keys/:keyId/revoke`, h((req, res) => {
    const k = d.registry.revokeKey({ type: 'sysadmin', id: actor(res) }, p(req, 'accountId'), p(req, 'proxyId'), p(req, 'keyId'));
    d.hub.closeKey(k.id, 4403);
    reg('proxy', p(req, 'proxyId'));
    return keyView(k);
  }));
  r.post(`${proxyBase}/block`, h((req, res) => {
    const px = d.registry.blockProxy(actor(res), p(req, 'accountId'), p(req, 'proxyId'));
    d.hub.closeProxy(px.id, 4403);
    reg('proxy', px.id);
    return px;
  }));
  r.get(`${proxyBase}/status`, h((req) => proxyDetail(d, p(req, 'accountId'), p(req, 'proxyId'))));

  // --- P2: command history and managed tokens (shown once, stored as hashes) -----------
  const tokenBase = `${proxyBase}/tokens`;
  r.get(`${proxyBase}/commands`, h((req) => d.commands.list(p(req, 'accountId'), p(req, 'proxyId'), { limit: limit(req), cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined })));
  r.get(`${proxyBase}/commands/:cmdId`, h((req) => d.commands.get(p(req, 'accountId'), p(req, 'proxyId'), p(req, 'cmdId'))));
  r.get(tokenBase, h((req) => d.tokens.list(p(req, 'accountId'), p(req, 'proxyId'))));
  r.post(tokenBase, h((req, res) => {
    // The token's only appearance: never cached, never repeated.
    res.set('Cache-Control', 'no-store');
    const out = d.tokens.issue(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body);
    created(res);
    return { ...out, shownOnce: true };
  }));
  r.post(`${tokenBase}/apply`, h((req, res) => {
    const out = d.tokens.reapply(actor(res), p(req, 'accountId'), p(req, 'proxyId'));
    res.locals.status = 202;
    return out;
  }));
  r.post(`${tokenBase}/confirm-restore`, h((req, res) => d.tokens.confirmRestore(actor(res), p(req, 'accountId'), p(req, 'proxyId'))));
  r.post(`${tokenBase}/:tokenId/retire`, h((req, res) => d.tokens.retire(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'tokenId'), req.body?.hours)));
  r.post(`${tokenBase}/:tokenId/revoke`, h((req, res) => d.tokens.revoke(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'tokenId'))));

  // --- P3: remote configuration (migration spec §8). Writes answer 202 with the
  // command id; a settings change exists only as a dry run, then an apply of
  // that dry run (R3-15). Inputs come from the JSON body only.
  const accepted = (res: Response, out: { commandId: string }) => {
    res.locals.status = 202;
    return out;
  };
  const cfgBase = `${proxyBase}/config`;
  r.get(cfgBase, h((req) => d.config.state(p(req, 'accountId'), p(req, 'proxyId'))));
  r.post(`${cfgBase}/refresh`, h((req, res) => accepted(res, d.config.refresh(actor(res), p(req, 'accountId'), p(req, 'proxyId')))));
  r.post(`${cfgBase}/preview`, h((req, res) => accepted(res, d.config.preview(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body))));
  r.post(`${cfgBase}/apply`, h((req, res) => accepted(res, d.config.apply(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body?.previewId))));
  r.post(`${cfgBase}/rollback/preview`, h((req, res) => accepted(res, d.config.rollbackPreview(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body?.cmdId))));
  r.post(`${cfgBase}/rollback/apply`, h((req, res) => accepted(res, d.config.rollbackApply(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body?.previewId))));
  r.get(`${proxyBase}/actions`, h((req) => d.actions.available(p(req, 'accountId'), p(req, 'proxyId'))));
  r.post(`${proxyBase}/actions`, h((req, res) => accepted(res, d.actions.cameraAction(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body))));
  r.post(`${proxyBase}/cameras/:camera/name`, h((req, res) => accepted(res, d.actions.rename(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'camera'), req.body))));
  r.post(`${proxyBase}/restart`, h((req, res) => accepted(res, d.actions.restart(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body))));

  r.get(`${proxyBase}/status-events`, h((req) => {
    d.registry.getProxy(p(req, 'accountId'), p(req, 'proxyId'));
    return d.status.events(p(req, 'proxyId'), limit(req), req.query.cursor ? Number(req.query.cursor) : undefined);
  }));
  r.post(`${proxyBase}/adopt`, h((req, res) => {
    created(res);
    const accountId = p(req, 'accountId');
    const px = d.registry.getProxy(accountId, p(req, 'proxyId'));
    const ref = String(req.body?.proxyCameraId ?? '');
    const detail = proxyDetail(d, accountId, px.id);
    const rep = detail.reconcile.reportedNotRegistered.find((c) => c.ref === ref);
    if (!rep) throw new ApiError(400, 'not_reported', 'proxyCameraId');
    const reported = detail.reported?.cameras.find((c) => c.ref === ref);
    const cam = d.registry.createCamera(actor(res), accountId, {
      camsId: req.body?.camsId ?? rep.proposedCamsId, name: req.body?.name ?? reported?.name ?? ref, kind: req.body?.kind ?? 'camera',
      proxyId: px.id, proxyCameraId: ref, model: reported?.model ?? null, host: 'from-proxy',
    }, 'camera-adopt');
    reg('camera', cam.id);
    return cam;
  }));

  // --- cameras ---------------------------------------------------------------------------
  const camBase = '/accounts/:accountId/cameras/:cameraId';
  r.get('/accounts/:accountId/cameras', h((req) => { d.registry.getAccount(p(req, 'accountId')); return { items: d.registry.listCameras(p(req, 'accountId')) }; }));
  r.post('/accounts/:accountId/cameras', h((req, res) => { created(res); const c = d.registry.createCamera(actor(res), p(req, 'accountId'), req.body); reg('camera', c.id); return c; }));
  r.get(camBase, h((req) => d.registry.getCamera(p(req, 'accountId'), p(req, 'cameraId'))));
  r.patch(camBase, h((req, res) => { const c = d.registry.updateCamera(actor(res), p(req, 'accountId'), p(req, 'cameraId'), req.body); reg('camera', c.id); return c; }));
  r.delete(camBase, h((req, res) => { d.registry.deleteCamera(actor(res), p(req, 'accountId'), p(req, 'cameraId')); reg('camera', p(req, 'cameraId')); }));
  r.put(`${camBase}/sim`, h((req, res) => { const s = d.registry.setSim(actor(res), p(req, 'accountId'), p(req, 'cameraId'), req.body); reg('camera', p(req, 'cameraId')); return s; }));
  r.delete(`${camBase}/sim`, h((req, res) => { d.registry.deleteSim(actor(res), p(req, 'accountId'), p(req, 'cameraId')); reg('camera', p(req, 'cameraId')); }));

  // --- P4: cams instances (migration spec §9.1, §9.6) -------------------------------------
  const cmsBase = '/cams-instances/:instanceId';
  const ci = d.camsInstances;
  const cms = (req: Request) => p(req, 'instanceId');
  r.get('/cams-instances', h(() => ({ items: ci.list(), serverKeyFingerprints: d.serverKeyFingerprints })));
  r.post('/cams-instances', h((req, res) => { created(res); const i = ci.create(actor(res), req.body); reg('cams-instance', i.id); return i; }));
  r.get(cmsBase, h((req) => {
    const i = ci.get(cms(req));
    return { ...i, live: ci.live(i.id), enrollment: ci.liveCode(i.id), serverKeyFingerprints: d.serverKeyFingerprints, revision: snapshotRevision(d.db, i.id, d.serverKeyFingerprints[0] ?? '') };
  }));
  r.patch(cmsBase, h((req, res) => { const i = ci.update(actor(res), cms(req), req.body); reg('cams-instance', i.id); return i; }));
  r.delete(cmsBase, h((req, res) => { ci.remove(actor(res), cms(req), req.body?.confirmName); reg('cams-instance', cms(req)); }));
  r.post(`${cmsBase}/block`, h((req, res) => { const i = ci.block(actor(res), cms(req)); reg('cams-instance', i.id); return i; }));
  r.post(`${cmsBase}/rotate`, h((req, res) => { const i = ci.rotateNow(actor(res), cms(req)); reg('cams-instance', i.id); return i; }));
  r.get(`${cmsBase}/routes`, h((req) => ({ items: ci.routes(cms(req)) })));
  r.put(`${cmsBase}/routes/:proxyId`, h((req, res) => { const x = ci.setRoute(actor(res), cms(req), p(req, 'proxyId'), req.body); reg('cams-instance', cms(req)); return x; }));
  r.delete(`${cmsBase}/routes/:proxyId`, h((req, res) => { ci.deleteRoute(actor(res), cms(req), p(req, 'proxyId')); reg('cams-instance', cms(req)); }));
  r.post(`${cmsBase}/enrollment-codes`, h((req, res) => {
    // The code's only appearance.
    res.set('Cache-Control', 'no-store');
    created(res);
    const c = ci.createCode(actor(res), cms(req), req.body?.lifetimeH);
    reg('cams-instance', cms(req));
    return c;
  }));
  r.delete(`${cmsBase}/enrollment-codes/:codeId`, h((req, res) => { ci.cancelCode(actor(res), cms(req), p(req, 'codeId')); reg('cams-instance', cms(req)); }));
  r.get(`${cmsBase}/keys`, h((req) => ({ items: ci.keys(cms(req)) })));
  r.post(`${cmsBase}/keys/:keyId/revoke`, h((req, res) => { const k = ci.revokeKey(actor(res), cms(req), p(req, 'keyId')); reg('cams-instance', cms(req)); return k; }));

  // --- P4: import a cams export, export a file-mode fallback (M §11.2, §11.6) ----------------
  r.post('/accounts/:accountId/import', h((req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accept = Array.isArray(b.acceptMismatch) ? b.acceptMismatch.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
    if (typeof b.instanceId !== 'string') throw new ApiError(400, 'invalid', 'instanceId');
    const out = d.importer.run(actor(res), p(req, 'accountId'), b.instanceId, b.file, {
      apply: b.apply === true, acceptMismatch: accept, createProxies: b.createProxies === true, hideUnlisted: b.hideUnlisted === true,
      planId: typeof b.planId === 'string' ? b.planId.slice(0, 64) : undefined,
    });
    if (out.applied) reg('account', p(req, 'accountId'));
    return out;
  }));
  r.get('/accounts/:accountId/export', h((req, res) => {
    const accountId = p(req, 'accountId');
    const instanceId = String(req.query.instance ?? '');
    const out = exportForInstance({ db: d.db, registry: d.registry, instances: d.camsInstances }, accountId, instanceId);
    const a = d.registry.getAccount(accountId);
    const i = d.camsInstances.get(instanceId);
    d.audit.write({ actorType: 'sysadmin', actor: actor(res), action: 'export-run', accountId, targetType: 'cams-instance', targetId: instanceId, targetLabel: i.name, outcome: 'ok', detail: { cameras: out.cameras.length, tokens: out.tokens.length } });
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="cameras-${a.name}-${i.name}.json"` });
    return out;
  }));

  // --- audit -------------------------------------------------------------------------------
  r.get('/audit', h((req) => {
    const q = req.query;
    const s = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : undefined);
    const n = (k: string) => (s(k) !== undefined && Number.isFinite(Number(s(k))) ? Number(s(k)) : undefined);
    return d.audit.list({ account: s('account'), actorType: s('actorType'), action: s('action'), from: n('from'), to: n('to'), limit: n('limit'), cursor: s('cursor') });
  }));

  r.use('/', bodyErrors);
  r.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  return r;
}

export function proxyDetail(d: ApiDeps, accountId: string, proxyId: string) {
  const px = d.registry.getProxy(accountId, proxyId);
  const view = d.status.viewOf(px);
  const row = d.status.row(proxyId);
  const cams = d.registry.listCameras(accountId);
  const mine = cams.filter((c) => c.proxyId === proxyId);
  return {
    proxy: px,
    view,
    summary: row?.summary ?? null,
    reported: row?.reported ?? null,
    reconcile: reconcile(px, mine, new Set(cams.map((c) => c.camsId)), row),
    keys: d.registry.listKeys(accountId, proxyId).map(keyView),
    enrollment: d.enrollment.liveCode(proxyId),
    connected: d.hub.connected(proxyId),
  };
}

export function dashboard(d: ApiDeps) {
  const accounts = d.registry.listAccounts();
  // Three queries in all, grouped here (not one per account).
  const proxiesOf = groupBy(d.registry.listProxies(), (px) => px.accountId);
  const camerasOf = groupBy(d.registry.listCameras(), (c) => c.accountId);
  let proxies = 0, proxiesOnline = 0, cameras = 0, camerasOnline = 0, problems = 0;
  const out = accounts.map((a) => {
    const accCams = camerasOf.get(a.id) ?? [];
    const camsIds = new Set(accCams.map((c) => c.camsId));
    const pxs = (proxiesOf.get(a.id) ?? []).map((px) => {
      const v = d.status.viewOf(px);
      const rec = reconcile(px, accCams.filter((c) => c.proxyId === px.id), camsIds, d.status.row(px.id));
      proxies++;
      if (v.state === 'online') proxiesOnline++;
      if (v.state === 'online' && (v.problemCount ?? 0) > 0) problems += v.problemCount ?? 0;
      return { id: px.id, name: px.name, displayName: px.displayName, runsOn: px.runsOn, state: v.state, connected: v.connected, lastHeartbeatAt: v.lastHeartbeatAt, ok: v.ok, problemCount: v.problemCount, version: v.version, pin: v.pin, skewMs: v.skewMs, skewProblem: v.skewProblem, stale: v.stale, unreadable: v.unreadable, cameras: v.cameras, commands: v.commands, allow: v.allow, reconcile: rec };
    });
    const camRows = accCams.map((c) => {
      const px = pxs.find((x) => x.id === c.proxyId);
      const live = px?.cameras.find((x) => x.ref === c.proxyCameraId);
      const online = live ? live.online : null;
      cameras++;
      if (online) camerasOnline++;
      return { id: c.id, camsId: c.camsId, name: c.name, kind: c.kind, proxyId: c.proxyId, proxyCameraId: c.proxyCameraId, online };
    });
    return { id: a.id, name: a.name, displayName: a.displayName, users: a.users, proxies: pxs, cameras: camRows, warnings: a.admins === 0 ? ['no-admin'] : [] };
  });
  // P4: one row per cams instance (its pulls and reports live in memory).
  const fp = d.serverKeyFingerprints[0] ?? '';
  const cams = d.camsInstances.list().map((i) => {
    const rep = i.live.report;
    const current = snapshotRevision(d.db, i.id, fp);
    return {
      id: i.id, name: i.name, displayName: i.displayName, state: i.state, lastSeenAt: i.live.lastSeenAt, lastPullAt: i.live.lastPullAt, lastPullStatus: i.live.lastPullStatus,
      mode: rep?.mode ?? null, version: rep?.version ?? null, appliedRevision: rep?.appliedRevision ?? null, current: !!rep && rep.appliedRevision === current,
      held: rep?.held?.length ?? 0, keptOld: rep?.keptOld?.length ?? 0, diverged: (rep?.keptOld?.length ?? 0) > 0,
      shadowDifferences: rep?.shadow ? rep.shadow.differences : null, shadowZeroSince: i.live.shadowZeroSince, problems: rep?.problems?.length ?? 0,
      tokens: rep?.tokens ?? null,
    };
  });
  return {
    accounts: out,
    cams,
    summary: { accounts: accounts.length, proxies, proxiesOnline, cameras, camerasOnline, problems },
    backup: d.backup.state(),
    refusedProxyIds: [...d.hub.refusedIds.entries()].map(([id, v]) => ({ id, ...v })),
    serverTime: d.clock.now(),
  };
}

// Items by key, in their original order.
function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}
