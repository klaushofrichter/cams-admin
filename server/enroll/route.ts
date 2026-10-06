import express from 'express';
import type { Enrollment } from './codes';
import { ApiError } from '../registry';
import { bodyErrors } from '../bodyErrors';

// The origin the request came in on. req.protocol and req.host follow the
// app's 'trust proxy' setting (TRUST_PROXY): X-Forwarded-Proto/-Host count
// only when trusted; a direct in-cluster request has its own Host. The
// result is only ever compared with the allowlist (connectUrlFor).
export function requestOrigin(req: express.Request): string | null {
  const host = req.host;
  if (!host || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return null;
  try {
    return new URL(`${req.protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

// POST /proxy/v1/enroll (spec §8.2): JSON, at most 8 KiB.
export function enrollRouter(enr: Enrollment): express.Router {
  const r = express.Router();
  r.post('/proxy/v1/enroll', express.json({ limit: 8 * 1024, type: () => true }), (req, res) => {
    let a;
    try {
      a = enr.redeem(req.body, requestOrigin(req));
    } catch (e) {
      if (e instanceof ApiError) a = { status: e.status, body: { error: e.code } };
      else throw e;
    }
    res.status(a.status).set('Cache-Control', 'no-store').json(a.body);
  });
  // A plain GET (no upgrade) on the channel path says which subprotocols
  // exist: a client that can't read the upgrade's status (Node's WebSocket
  // can't) learns of a 426 this way (spec §8.1, §8.8).
  r.get('/proxy/v1/connect', (_req, res) => {
    res.status(426).set('Cache-Control', 'no-store').json({ error: 'unsupported_protocol', supported: ['cams-admin.v1'] });
  });
  r.use('/proxy/v1/enroll', bodyErrors);
  return r;
}
