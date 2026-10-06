import express from 'express';
import type { Request, Response } from 'express';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { Enrollment } from '../enroll/codes';
import type { Hub } from '../channel/hub';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import { SESSION_COOKIE, type Sessions } from '../auth/session';
import { requireCsrf, requireSysadmin, writeLimiter } from '../auth/middleware';
import { reconcile } from '../status/derive';
import { FieldError } from '../validate';
import { Buckets } from '../channel/limits';
import { monitorEventLoopDelay } from 'perf_hooks';
import { existsSync, statSync } from 'fs';
import { readEpoch } from '../db/open';

export interface ManualBackup { at: number; ok: boolean; litestream: { ok: boolean; status?: string; error?: string }; snapshot: { ok: boolean; key?: string; bytes?: number; error?: string } }
export interface BackupState {
  lastSnapshotAt: number | null; lastSnapshotOk: boolean | null; lastSnapshotError: string | null; lastReplicationAt: number | null;
  lastManual: ManualBackup | null; alerts: string[]; configured: boolean; litestream: boolean; store: string;
}
export interface BackupService { state(): BackupState; backupNow(actor: string): Promise<ManualBackup | { busy: true }> }

export interface ApiDeps {
  db: Db; clock: Clock; cfg: Config; audit: Audit; registry: Registry; enrollment: Enrollment; hub: Hub; status: StatusStore; live: LiveHub; sessions: Sessions; backup: BackupService;
}

type H = (req: Request, res: Response) => unknown;
const p = (req: Request, k: string) => String(req.params[k]);

export function apiRouter(d: ApiDeps): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: 64 * 1024 }));
  r.use(requireSysadmin(d.sessions), requireCsrf(d.cfg), writeLimiter(d.cfg, d.clock));
  const actor = (res: Response): string => res.locals.session.email;
  // Async-safe handler with the API's error mapping.
  const h = (fn: H) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) {
        if (out === undefined) res.status(204).end();
        else res.status(req.method === 'POST' && res.locals.created ? 201 : 200).json(out);
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
    r.get('/dev/metrics', h(() => {
      const out = {
        rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
        loopLagP50Ms: lag.percentile(50) / 1e6, loopLagP99Ms: lag.percentile(99) / 1e6, loopLagMaxMs: lag.max / 1e6,
        dbBytes: (() => { try { return statSync(d.cfg.dbFile).size + (existsSync(`${d.cfg.dbFile}-wal`) ? statSync(`${d.cfg.dbFile}-wal`).size : 0); } catch { return 0; } })(),
        writeEpoch: readEpoch(d.db), connections: d.hub.stats(), sseStreams: d.live.count(),
      };
      lag.reset();
      return out;
    }));
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
    return { items: d.registry.listProxies(acc.id).map((px) => ({ ...px, status: d.status.view(px.id) })) };
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
  r.get(`${proxyBase}/keys`, h((req) => ({ items: d.registry.listKeys(p(req, 'accountId'), p(req, 'proxyId')).map(({ publicKey: _pk, ...k }) => k) })));
  r.post(`${proxyBase}/keys/:keyId/revoke`, h((req, res) => {
    const k = d.registry.revokeKey({ type: 'sysadmin', id: actor(res) }, p(req, 'accountId'), p(req, 'proxyId'), p(req, 'keyId'));
    d.hub.closeKey(k.id, 4403);
    reg('proxy', p(req, 'proxyId'));
    const { publicKey: _pk, ...rest } = k;
    return rest;
  }));
  r.post(`${proxyBase}/block`, h((req, res) => {
    const px = d.registry.blockProxy(actor(res), p(req, 'accountId'), p(req, 'proxyId'));
    d.hub.closeProxy(px.id, 4403);
    reg('proxy', px.id);
    return px;
  }));
  r.get(`${proxyBase}/status`, h((req) => proxyDetail(d, p(req, 'accountId'), p(req, 'proxyId'))));
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

  // --- audit -------------------------------------------------------------------------------
  r.get('/audit', h((req) => {
    const q = req.query;
    const s = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : undefined);
    const n = (k: string) => (s(k) !== undefined && Number.isFinite(Number(s(k))) ? Number(s(k)) : undefined);
    return d.audit.list({ account: s('account'), actorType: s('actorType'), action: s('action'), from: n('from'), to: n('to'), limit: n('limit'), cursor: s('cursor') });
  }));

  r.use('/', ((err, _req, res, next) => {
    const status = (err as { status?: number }).status;
    if (status === 413) return void res.status(413).json({ error: 'too_large' });
    if (status === 400) return void res.status(400).json({ error: 'bad_request' });
    next(err);
  }) as express.ErrorRequestHandler);
  r.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  return r;
}

export function proxyDetail(d: ApiDeps, accountId: string, proxyId: string) {
  const px = d.registry.getProxy(accountId, proxyId);
  const view = d.status.view(proxyId);
  const row = d.status.row(proxyId);
  const cams = d.registry.listCameras(accountId);
  const mine = cams.filter((c) => c.proxyId === proxyId);
  return {
    proxy: px,
    view,
    summary: row?.summary ?? null,
    reported: row?.reported ?? null,
    reconcile: reconcile(px, mine, new Set(cams.map((c) => c.camsId)), row, px.caFingerprints),
    keys: d.registry.listKeys(accountId, proxyId).map(({ publicKey: _pk, ...k }) => k),
    enrollment: d.enrollment.liveCode(proxyId),
    connected: d.hub.connected(proxyId),
  };
}

export function dashboard(d: ApiDeps) {
  const accounts = d.registry.listAccounts();
  const allCams = d.registry.listCameras();
  let proxies = 0, proxiesOnline = 0, cameras = 0, camerasOnline = 0, problems = 0;
  const out = accounts.map((a) => {
    const pxs = d.registry.listProxies(a.id).map((px) => {
      const v = d.status.view(px.id);
      const row = d.status.row(px.id);
      const mine = allCams.filter((c) => c.proxyId === px.id);
      const rec = reconcile(px, mine, new Set(allCams.filter((c) => c.accountId === a.id).map((c) => c.camsId)), row, px.caFingerprints);
      proxies++;
      if (v.state === 'online') proxiesOnline++;
      if (v.state === 'online' && (v.problemCount ?? 0) > 0) problems += v.problemCount ?? 0;
      return { id: px.id, name: px.name, displayName: px.displayName, runsOn: px.runsOn, state: v.state, connected: v.connected, lastHeartbeatAt: v.lastHeartbeatAt, ok: v.ok, problemCount: v.problemCount, version: v.version, pin: v.pin, skewMs: v.skewMs, skewProblem: v.skewProblem, stale: v.stale, unreadable: v.unreadable, cameras: v.cameras, reconcile: rec };
    });
    const accCams = allCams.filter((c) => c.accountId === a.id).map((c) => {
      const px = pxs.find((x) => x.id === c.proxyId);
      const live = px?.cameras.find((x) => x.ref === c.proxyCameraId);
      const online = live ? live.online : null;
      cameras++;
      if (online) camerasOnline++;
      return { id: c.id, camsId: c.camsId, name: c.name, kind: c.kind, proxyId: c.proxyId, proxyCameraId: c.proxyCameraId, online };
    });
    return { id: a.id, name: a.name, displayName: a.displayName, users: a.users, proxies: pxs, cameras: accCams, warnings: a.admins === 0 ? ['no-admin'] : [] };
  });
  return {
    accounts: out,
    summary: { accounts: accounts.length, proxies, proxiesOnline, cameras, camerasOnline, problems },
    backup: d.backup.state(),
    refusedProxyIds: [...d.hub.refusedIds.entries()].map(([id, v]) => ({ id, ...v })),
    serverTime: d.clock.now(),
  };
}
