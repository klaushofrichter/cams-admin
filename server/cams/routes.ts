import express from 'express';
import type { KeyObject } from 'crypto';
import type { CamsEnrollment } from './enroll';
import type { CamsInstances } from './instances';
import type { Tokens } from '../tokens/service';
import { buildSnapshot, encodeSnapshot, snapshotRevision, type SnapshotDeps } from './snapshot';
import { ApiError } from '../registry';
import { FieldError } from '../validate';
import { validateCams } from '../contract';
import { fieldOf } from '../tokens/service';
import { log } from '../log';
import { NONCE_RE, sendSigned, type CamsAuth, type CamsRequest } from './auth';
import { limiter } from '../rateLimit';
import { requestOrigin } from '../enroll/route';
import { bodyErrors } from '../bodyErrors';

// The /cams/v1 service API (contract cams-v1). Mounted at the app root,
// before the cookie parser: no cookie, session or CSRF rule applies here.
export interface CamsRouterDeps { globalPerMin?: number; enrollment: CamsEnrollment; auth?: CamsAuth; signingKey?: KeyObject; testRoutes?: boolean; instances?: CamsInstances; snapshot?: SnapshotDeps; tokens?: Tokens }

export function camsRouter(d: CamsRouterDeps): express.Router {
  const r = express.Router();
  // A ceiling for every /cams/v1 request in total, before anything is read
  // (one budget, never the client address); far above what the instances
  // send (60 a minute each). Signed when the nonce is well-formed.
  r.use('/cams/v1', limiter({
    // Per well-formed instance id (one bucket for the rest): a flood naming
    // made-up ids can't starve the real instances (review M1).
    windowMs: 60_000, limit: d.globalPerMin ?? 3000,
    key: (req) => { const h = req.headers['x-cams-instance']; return typeof h === 'string' && /^cms_[0-9A-HJKMNP-TV-Z]{20}$/.test(h) ? `cams:${h}` : 'cams:anon'; },
    handler: (req, res) => {
      const nonce = typeof req.headers['x-cams-nonce'] === 'string' ? req.headers['x-cams-nonce'] : '';
      if (d.signingKey && NONCE_RE.test(nonce)) return sendSigned(res, d.signingKey, nonce, 429, { error: 'rate_limited', retryAfterS: 60 });
      res.status(429).set('Cache-Control', 'no-store').json({ error: 'rate_limited', retryAfterS: 60 });
    },
  }));
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
  // Step 9 errors (ApiError) as signed answers.
  const route = (fn: (req: express.Request, res: express.Response, c: CamsRequest) => void): express.RequestHandler => (req, res) => {
    const c = cams(res);
    try {
      fn(req, res, c);
    } catch (err) {
      const e = err instanceof FieldError ? new ApiError(400, 'invalid', err.field) : err;
      if (!(e instanceof ApiError)) throw e;
      if (e.status >= 500) log.error({ instanceId: c.instanceId, code: e.code }, 'cams_route_failed');
      sendSigned(res, key, c.nonce, e.status, { error: e.code, ...(e.field ? { field: e.field } : {}), ...((e as ApiError & { extra?: object }).extra ?? {}) });
    }
  };
  const inst = d.instances, snap = d.snapshot;
  if (inst && snap) {
    r.get('/cams/v1/config', route((req, res, c) => {
      const rev = snapshotRevision(snap.db, c.instanceId, snap.signingFingerprint);
      const now = snap.clock.now();
      if (req.headers['if-none-match'] === `"${rev}"`) {
        inst.touch(c.instanceId, { lastPullAt: now, lastPullStatus: 304 });
        return sendSigned(res, key, c.nonce, 304, null, { ETag: `"${rev}"` });
      }
      // Same synchronous call: the body's revision equals the ETag.
      const s = buildSnapshot(snap, c.instanceId);
      const bytes = encodeSnapshot(s);
      inst.touch(c.instanceId, { lastPullAt: now, lastPullStatus: 200 });
      sendSigned(res, key, c.nonce, 200, bytes, { ETag: `"${s.revision}"` });
    }));
    r.post('/cams/v1/report', route((_req, res, c) => sendSigned(res, key, c.nonce, 200, inst.report(c.instanceId, c.json, snap.clock.now()))));
  }
  const tokens = d.tokens;
  if (inst && tokens) {
    const me = (c: CamsRequest) => inst.getRaw(c.instanceId)!;
    r.post('/cams/v1/tokens', route((_req, res, c) => {
      const out = tokens.registerForInstance(me(c), inst.servedAccountIds(c.instanceId), c.json);
      sendSigned(res, key, c.nonce, out.status, out.body);
    }));
    r.post('/cams/v1/tokens/:tokenId/retire', route((req, res, c) => {
      const v = validateCams('retire-request', c.json);
      if (!v.ok) throw new ApiError(400, 'invalid', fieldOf(v.detail));
      const out = tokens.retireForInstance(me(c), inst.servedAccountIds(c.instanceId), String(req.params.tokenId), (c.json as { hours?: unknown }).hours);
      sendSigned(res, key, c.nonce, 200, out);
    }));
  }
  r.use('/cams/v1', (_req, res) => sendSigned(res, key, cams(res).nonce, 404, { error: 'not_found' }));
  r.use('/cams/v1', d.auth.errorHandler());
  return r;
}
