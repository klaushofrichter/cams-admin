import express from 'express';
import type { Enrollment } from './codes';
import { ApiError } from '../registry';

// POST /proxy/v1/enroll (spec §8.2): JSON, at most 8 KiB.
export function enrollRouter(enr: Enrollment): express.Router {
  const r = express.Router();
  r.post('/proxy/v1/enroll', express.json({ limit: 8 * 1024, type: () => true }), (req, res) => {
    let a;
    try {
      a = enr.redeem(req.body);
    } catch (e) {
      if (e instanceof ApiError) a = { status: e.status, body: { error: e.code } };
      else throw e;
    }
    res.status(a.status).set('Cache-Control', 'no-store').json(a.body);
  });
  r.use('/proxy/v1/enroll', ((err, _req, res, next) => {
    const status = (err as { status?: number }).status;
    if (status === 413) return res.status(413).json({ error: 'too_large' });
    if (status === 400) return res.status(400).json({ error: 'bad_request' });
    next(err);
  }) as express.ErrorRequestHandler);
  return r;
}
