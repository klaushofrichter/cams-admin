import express from 'express';
import type { KeyObject } from 'crypto';
import type { CamsEnrollment } from './enroll';
import { sendSigned, type CamsAuth, type CamsRequest } from './auth';
import { requestOrigin } from '../enroll/route';
import { bodyErrors } from '../bodyErrors';

// The /cams/v1 service API (contract cams-v1). Mounted at the app root,
// before the cookie parser: no cookie, session or CSRF rule applies here.
export interface CamsRouterDeps { enrollment: CamsEnrollment; auth?: CamsAuth; signingKey?: KeyObject; testRoutes?: boolean }

export function camsRouter(d: CamsRouterDeps): express.Router {
  const r = express.Router();
  // Unsigned request, unsigned answer (as P1 §8.2); at most 8 KiB.
  r.post('/cams/v1/enroll', express.json({ limit: 8 * 1024, type: () => true }), (req, res) => {
    const a = d.enrollment.redeem(req.body, requestOrigin(req));
    res.status(a.status).set('Cache-Control', 'no-store').json(a.body);
  });
  r.use('/cams/v1/enroll', bodyErrors);
  if (!d.auth || !d.signingKey) return r;
  const key = d.signingKey;
  const cams = (res: express.Response) => res.locals.cams as CamsRequest;

  // Everything else is signed: the raw bytes (≤ 64 KiB) are what the signature covers.
  r.use('/cams/v1', express.raw({ type: () => true, limit: 64 * 1024 }), d.auth.middleware());
  if (d.testRoutes) r.get('/cams/v1/ping', (_req, res) => sendSigned(res, key, cams(res).nonce, 200, { ok: true }));
  r.use('/cams/v1', (_req, res) => sendSigned(res, key, cams(res).nonce, 404, { error: 'not_found' }));
  r.use('/cams/v1', d.auth.errorHandler());
  return r;
}
