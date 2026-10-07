import { dirname } from 'path';

// Everything the process reads from its environment (spec §14). Secrets
// (Google client secret, S3 keys) stay in the env and are read where used;
// they are never copied into this object or logged.

export interface Limits {
  frameBytes: number; // ws maxPayload
  bytesPerMin: number; // inbound per connection
  msgPerMin: number; // per connection
  heartbeatMinGapMs: number; // faster heartbeats are dropped
  dropsBeforeClose: number;
  helloPerProxyPerMin: number;
  failedHandshakesPer10Min: number; // in total
  pendingSockets: number; // without a completed hello
  enrollPerCode: number; // per 15 min
  enrollGlobal: number; // per 15 min
  signinGlobal: number; // per 15 min
  writesPerSessionPerMin: number;
  sseStreamsPerSession: number;
  camsPerInstancePerMin: number; // signed /cams/v1 requests per instance
  camsFailedSigPer10Min: number; // per named instance, and once for unknown ids (unknown key, bad signature)
  camsGlobalPerMin: number; // /cams/v1 requests per well-formed instance id, and once for the rest (a ceiling before the check)
}

export interface Config {
  nodeEnv: string;
  port: number;
  publicUrl: string;
  publicOrigin: string;
  connectUrl: string;
  // Origins a proxy may enroll on and get its connectUrl on: PUBLIC_URL's,
  // then INTERNAL_URLS (e.g. the in-cluster service URL).
  connectOrigins: string[];
  dbFile: string;
  dataDir: string;
  signingKeyFile: string | null;
  heartbeatS: number;
  offlineAfterS: number;
  pingS: number;
  helloTimeoutMs: number;
  tickMs: number;
  statusSnapshotS: number;
  enrollCodeDefaultH: number;
  snapshotAt: string;
  snapshotRetentionDays: number;
  litestreamMetricsUrl: string | null;
  litestreamSocket: string | null;
  litestreamSyncIntervalS: number;
  replicationCheckS: number;
  backup: { bucket: string; prefix: string; region: string; endpoint: string | null } | null;
  google: { clientId: string; redirectUri: string; callbackPath: string; authUrl: string; tokenUrl: string; certsUrl: string; issuer: string };
  limits: Limits;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`config: ${key} must be a number from ${min} to ${max}`);
  return v;
}

export const DEFAULT_CALLBACK_PATH = '/auth/callback';
const CALLBACK_RE = /^\/auth(\/[a-z0-9][a-z0-9_-]{0,31}){1,3}$/;
const RESERVED_AUTH_PATHS = ['/auth/google/login', '/auth/logout', '/auth/signed-out'];

export function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/proxy/v1/connect';
  u.search = '';
  u.hash = '';
  return u.toString();
}

// http only where nothing leaves the host or the cluster network.
const isLoopback = (h: string) => h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
const inCluster = (h: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.svc\.cluster\.local$/.test(h);

function internalOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    let u: URL;
    try {
      u = new URL(x);
    } catch {
      throw new Error(`config: INTERNAL_URLS: ${JSON.stringify(x)} is not a URL`);
    }
    const bad = (why: string) => new Error(`config: INTERNAL_URLS: ${JSON.stringify(x)} ${why}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('must be http(s)');
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || /[?#]/.test(x)) throw bad('must be an origin (no path, query or credentials)');
    if (u.protocol === 'http:' && !isLoopback(u.hostname) && !inCluster(u.hostname)) throw bad('may use http only for *.svc.cluster.local or loopback');
    return u.origin;
  });
}

// The connect URL for an enrollment that arrived on requestOrigin: that
// origin when it is allowlisted, otherwise the public one. A Host header is
// never reflected unless it is on the list.
export function connectUrlFor(cfg: Pick<Config, 'connectUrl' | 'connectOrigins' | 'publicOrigin'>, requestOrigin: string | null): string {
  if (!requestOrigin || requestOrigin === cfg.publicOrigin || !cfg.connectOrigins.includes(requestOrigin)) return cfg.connectUrl;
  return wsUrl(requestOrigin);
}

export function loadConfig(env: Env = process.env): Config {
  const publicUrl = env.PUBLIC_URL;
  if (!publicUrl || !/^https?:\/\/[^\s/]+/.test(publicUrl)) throw new Error('config: PUBLIC_URL is required (https://host)');
  const dbFile = env.DB_FILE || '/var/lib/cams-admin/cams-admin.db';
  const heartbeatS = num(env, 'HEARTBEAT_S', 30, 1, 300);
  const snapshotAt = env.BACKUP_SNAPSHOT_AT || '03:15';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(snapshotAt)) throw new Error('config: BACKUP_SNAPSHOT_AT must be HH:MM');
  const bucket = env.BACKUP_S3_BUCKET;
  // The callback is served on the registered redirect URI's path (Klaus
  // registered /auth/callback): under /auth/, plain segments, not a route
  // the app already has.
  const redirectUri = env.GOOGLE_REDIRECT_URI || `${publicUrl.replace(/\/+$/, '')}${DEFAULT_CALLBACK_PATH}`;
  let ru: URL;
  try {
    ru = new URL(redirectUri);
  } catch {
    throw new Error('config: GOOGLE_REDIRECT_URI is not a URL');
  }
  if (ru.search || ru.hash || !CALLBACK_RE.test(ru.pathname) || RESERVED_AUTH_PATHS.includes(ru.pathname) || !/\/auth\/[^?#]*$/.test(redirectUri.replace(ru.origin, ''))) {
    throw new Error('config: GOOGLE_REDIRECT_URI must be a path under /auth/ (plain segments, no query) that the app does not use otherwise, e.g. /auth/callback');
  }
  if (ru.origin !== new URL(publicUrl).origin) throw new Error('config: GOOGLE_REDIRECT_URI must be on the PUBLIC_URL origin (the sign-in cookies are per host)');
  return {
    nodeEnv: env.NODE_ENV || 'production',
    port: num(env, 'PORT', 8080, 1, 65535),
    publicUrl: publicUrl.replace(/\/+$/, ''),
    publicOrigin: new URL(publicUrl).origin,
    connectUrl: wsUrl(env.PROXY_CONNECT_URL || publicUrl),
    connectOrigins: [...new Set([new URL(publicUrl).origin, ...internalOrigins(env.INTERNAL_URLS)])],
    dbFile,
    dataDir: dirname(dbFile),
    signingKeyFile: env.SERVER_SIGNING_KEY_FILE || null,
    heartbeatS,
    offlineAfterS: num(env, 'OFFLINE_AFTER_S', 90, 1, 3600),
    pingS: num(env, 'PING_S', 25, 1, 55),
    helloTimeoutMs: num(env, 'HELLO_TIMEOUT_MS', 10_000, 50, 60_000),
    tickMs: num(env, 'TICK_MS', 10_000, 50, 60_000),
    // kube-setup's S3 cost rule: live status in memory, a coarse snapshot to SQLite.
    statusSnapshotS: num(env, 'STATUS_SNAPSHOT_S', 600, 1, 86_400),
    enrollCodeDefaultH: num(env, 'ENROLL_CODE_DEFAULT_H', 24, 1, 168),
    snapshotAt,
    snapshotRetentionDays: num(env, 'BACKUP_SNAPSHOT_RETENTION_DAYS', 30, 1, 3650),
    litestreamMetricsUrl: env.LITESTREAM_METRICS_URL || null,
    litestreamSocket: env.LITESTREAM_SOCKET || null,
    // Must match deploy/litestream.yml's sync-interval (the lag alert uses it).
    litestreamSyncIntervalS: num(env, 'LITESTREAM_SYNC_INTERVAL_S', 3600, 1, 86_400),
    // How often lastReplicationAt is read from S3 (ListObjectsV2, spec §13.3).
    replicationCheckS: num(env, 'REPLICATION_CHECK_S', 300, 1, 3600),
    backup: bucket ? { bucket, prefix: (env.BACKUP_S3_PREFIX || 'cams-admin/prod/').replace(/\/?$/, '/'), region: env.AWS_REGION || 'us-east-1', endpoint: env.S3_ENDPOINT || null } : null,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      redirectUri,
      callbackPath: ru.pathname,
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      certsUrl: env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: env.GOOGLE_ISSUER || 'https://accounts.google.com',
    },
    limits: {
      frameBytes: 256 * 1024,
      bytesPerMin: 1024 * 1024,
      msgPerMin: num(env, 'LIMIT_MSG_PER_MIN', 20, 1, 100_000),
      heartbeatMinGapMs: num(env, 'HEARTBEAT_MIN_GAP_MS', Math.min(10_000, Math.floor((heartbeatS * 1000) / 3)), 0, 60_000),
      dropsBeforeClose: 3,
      helloPerProxyPerMin: num(env, 'LIMIT_HELLO_PER_PROXY', 6, 1, 10_000),
      failedHandshakesPer10Min: num(env, 'LIMIT_FAILED_HANDSHAKES', 300, 1, 100_000),
      pendingSockets: num(env, 'LIMIT_PENDING_SOCKETS', 50, 1, 10_000),
      enrollPerCode: 5,
      enrollGlobal: num(env, 'LIMIT_ENROLL_GLOBAL', 100, 1, 100_000),
      signinGlobal: num(env, 'LIMIT_SIGNIN_GLOBAL', 60, 1, 100_000),
      writesPerSessionPerMin: num(env, 'LIMIT_WRITES_PER_SESSION', 120, 1, 100_000),
      sseStreamsPerSession: 5,
      camsPerInstancePerMin: num(env, 'LIMIT_CAMS_PER_INSTANCE', 60, 1, 100_000),
      camsFailedSigPer10Min: num(env, 'LIMIT_CAMS_FAILED_SIG', 300, 1, 100_000),
      camsGlobalPerMin: num(env, 'LIMIT_CAMS_GLOBAL', 3000, 1, 1_000_000),
    },
  };
}
