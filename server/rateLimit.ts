import { createHash } from 'crypto';
import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';

// express-rate-limit with a key that is never the client address (spec §7,
// kube-setup 2026-10-06): a session, or one budget in total.
export function limiter(o: { windowMs: number; limit: number; key: (req: Request) => string; skipSuccessfulRequests?: boolean; handler?: (req: Request, res: Response) => void }): RequestHandler {
  return rateLimit({
    windowMs: o.windowMs,
    limit: o.limit,
    keyGenerator: o.key,
    skipSuccessfulRequests: o.skipSuccessfulRequests ?? false,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: false, // no IP-based keys to validate
    handler: o.handler ?? ((_req, res) => void res.status(429).json({ error: 'rate_limited' })),
  });
}

export const sessionKey = (cookie: unknown): string => (typeof cookie === 'string' ? 'session:' + createHash('sha256').update(cookie).digest('hex').slice(0, 32) : 'anonymous');
