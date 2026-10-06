import pino from 'pino';

// One logger. Never log codes, keys, cookies, tokens or client addresses
// (spec §7); the redaction is a second line of defence, not the rule.
export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  redact: { paths: ['code', 'cookie', 'token', 'privateKey', 'proof', 'sig', 'req.headers.cookie', 'req.headers.authorization', '*.code', '*.privateKey'], censor: '[redacted]' },
});
export type Logger = typeof log;
