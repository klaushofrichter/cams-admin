import { tmpdir } from 'os';
import { join } from 'path';

// The e2e's own cams-admin (built, NODE_ENV=development for dev-session),
// on localhost, with a fake Google. Ports 29190-29199.
export const PORT = 29190;
export const GOOGLE_PORT = 29191;
export const BASE = `http://localhost:${PORT}`;
export const DATA = join(tmpdir(), 'cams-admin-e2e');
export const ADMIN = 'admin@example.com';
export const ENV: Record<string, string> = {
  NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(PORT), PUBLIC_URL: BASE, DB_FILE: join(DATA, 'cams-admin.db'),
  SERVER_SIGNING_KEY_FILE: join(DATA, 'signing.pem'), ALLOWED_EMAILS: ADMIN,
  HEARTBEAT_S: '1', OFFLINE_AFTER_S: '3', TICK_MS: '200', HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '100000', LIMIT_HELLO_PER_PROXY: '1000',
  LIMIT_ENROLL_GLOBAL: '100000', LIMIT_WRITES_PER_SESSION: '100000', LIMIT_SIGNIN_GLOBAL: '1000',
  GOOGLE_CLIENT_ID: 'e2e-client', GOOGLE_CLIENT_SECRET: 'e2e-secret',
  GOOGLE_AUTH_URL: `http://127.0.0.1:${GOOGLE_PORT}/auth`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`, GOOGLE_CERTS_URL: `http://127.0.0.1:${GOOGLE_PORT}/certs`,
  TZ: 'America/Chicago',
};
