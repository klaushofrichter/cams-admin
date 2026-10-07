import express from 'express';
import type { CamsEnrollment } from './enroll';
import { requestOrigin } from '../enroll/route';
import { bodyErrors } from '../bodyErrors';

// The /cams/v1 service API (contract cams-v1). Mounted at the app root,
// before the cookie parser: no cookie, session or CSRF rule applies here.
export interface CamsRouterDeps { enrollment: CamsEnrollment }

export function camsRouter(d: CamsRouterDeps): express.Router {
  const r = express.Router();
  // Unsigned request, unsigned answer (as P1 §8.2); at most 8 KiB.
  r.post('/cams/v1/enroll', express.json({ limit: 8 * 1024, type: () => true }), (req, res) => {
    const a = d.enrollment.redeem(req.body, requestOrigin(req));
    res.status(a.status).set('Cache-Control', 'no-store').json(a.body);
  });
  r.use('/cams/v1/enroll', bodyErrors);
  return r;
}
