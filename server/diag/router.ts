import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { ApiDeps } from '../api/router';
import { ApiError } from '../registry';
import { SESSION_COOKIE } from '../auth/session';
import { limiter } from '../rateLimit';
import { precheckReport } from '../moves/precheck';
import { version } from '../version';
import type { DiagTokens } from './tokens';
import { diagCameras, diagCamsInstances, diagMoves, diagProxies } from './views';

// The read-only diagnostics API (issue #45), mounted at /api/v1/diag: a
// diagnostics token (Authorization: Bearer cad_…) or a sysadmin session.
// GET only; the token opens nothing outside this router.

const ROUTES = ['/diag', '/diag/proxies', '/diag/cams-instances', '/diag/cameras', '/diag/moves?accountId=', '/diag/moves/precheck?source=&target=&camera=', '/diag/audit?account=&actorType=&action=&from=&to=&limit=&cursor='];

export function diagAuth(d: Pick<ApiDeps, 'sessions' | 'audit'> & { diag: DiagTokens }): RequestHandler {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      const m = /^Bearer (\S+)$/.exec(auth);
      const id = m ? d.diag.verify(m[1]) : null;
      if (!id) {
        // Never keyed on the client address: one throttled record for all refusals.
        d.audit.throttled('diag-auth-refused', { actorType: 'system', actor: 'system', action: 'diag-auth-refused', outcome: 'refused' });
        return void res.status(401).json({ error: 'unauthorized' });
      }
      res.locals.diagKey = `diag:${id}`;
      return next();
    }
    const s = d.sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!s) return void res.status(401).json({ error: 'unauthorized' });
    res.locals.diagKey = `session:${s.idHash}`;
    next();
  };
}

export function diagRouter(d: ApiDeps & { diag: DiagTokens }): express.Router {
  const r = express.Router();
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.status(405).set('Allow', 'GET, HEAD').json({ error: 'method_not_allowed' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  r.use(diagAuth(d));
  r.use(limiter({ windowMs: 60_000, limit: 120, key: (req) => String(req.res?.locals.diagKey) }));
  const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    try {
      res.json(fn(req, res));
    } catch (e) {
      if (e instanceof ApiError) return void res.status(e.status).json({ error: e.code, ...(e.field ? { field: e.field } : {}) });
      throw e;
    }
  };
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? (req.query[k] as string) : undefined);
  const n = (req: Request, k: string) => (q(req, k) !== undefined && Number.isFinite(Number(q(req, k))) ? Number(q(req, k)) : undefined);

  r.get('/', h(() => ({ version: version(), serverTime: d.clock.now(), routes: ROUTES })));
  r.get('/proxies', h(() => diagProxies(d)));
  r.get('/cams-instances', h(() => diagCamsInstances(d)));
  r.get('/cameras', h(() => diagCameras(d)));
  r.get('/moves', h((req) => {
    const acc = q(req, 'accountId');
    if (acc !== undefined) d.registry.getAccount(acc);
    return diagMoves(d, acc);
  }));
  // Every precheck rule for a candidate move, with pass/fail and a detail.
  r.get('/moves/precheck', h((req) => {
    const source = q(req, 'source'), target = q(req, 'target'), camera = q(req, 'camera');
    if (!source) throw new ApiError(400, 'invalid', 'source');
    if (!target) throw new ApiError(400, 'invalid', 'target');
    const src = d.registry.proxyById(source);
    if (!src) throw new ApiError(404, 'not_found', 'source');
    // camera: the registry id or the cams id within the source's account.
    let cameraId: string | null = null;
    if (camera) {
      const c = d.registry.listCameras(src.accountId).find((x) => x.id === camera || x.camsId === camera);
      if (!c) throw new ApiError(404, 'not_found', 'camera');
      cameraId = c.id;
    }
    return { source, target, cameraId, ...precheckReport({ db: d.db, registry: d.registry, status: d.status, store: d.moves.store }, { accountId: src.accountId, sourceProxyId: source, targetProxyId: target, cameraId }) };
  }));
  r.get('/audit', h((req) => d.audit.list({ account: q(req, 'account'), actorType: q(req, 'actorType'), action: q(req, 'action'), from: n(req, 'from'), to: n(req, 'to'), limit: n(req, 'limit'), cursor: q(req, 'cursor') })));
  r.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  return r;
}
