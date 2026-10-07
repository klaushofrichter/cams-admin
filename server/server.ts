import { createServer, type Server } from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig, type Config } from './config';
import { systemClock, type Clock } from './clock';
import { openDb, type Db } from './db/open';
import { checkEpoch, writeEpochFile } from './db/epoch';
import { Audit } from './audit';
import { Registry } from './registry';
import { LiveHub } from './live';
import { StatusStore } from './status/store';
import { Hub, CONNECT_PATH } from './channel/hub';
import { Commands } from './commands/service';
import { Tokens } from './tokens/service';
import { ProxyConfig } from './config/service';
import { RemoteActions } from './actions/service';
import { Enrollment } from './enroll/codes';
import { enrollRouter } from './enroll/route';
import { CamsInstances } from './cams/instances';
import { CamsEnrollment } from './cams/enroll';
import { camsRouter } from './cams/routes';
import { CamsAuth } from './cams/auth';
import { Importer } from './import/importer';
import { RevocationJournal } from './cams/revocations';
import { Sessions } from './auth/session';
import { authRoutes } from './auth/routes';
import { securityHeaders } from './auth/middleware';
import { apiRouter, type BackupService } from './api/router';
import { loadSigningKey, type SigningKey } from './crypto/signingKey';
import { createBackup } from './backup/service';
import { log } from './log';
import { limiter } from './rateLimit';
import { version } from './version';

export interface Built {
  cfg: Config; clock: Clock; db: Db; audit: Audit; registry: Registry; live: LiveHub; status: StatusStore; hub: Hub; commands: Commands; tokens: Tokens; actions: RemoteActions; config: ProxyConfig; enrollment: Enrollment; sessions: Sessions; backup: BackupService;
  camsInstances: CamsInstances; camsAuth: CamsAuth; importer: Importer; signing: SigningKey;
  app: express.Express; http: Server; epochFile: string;
  tick(): void;
  writeRoutes(): string[];
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function buildServer(env: Record<string, string | undefined> = {}, clock: Clock = systemClock): Built {
  const merged = { ...process.env, ...env };
  const cfg = loadConfig(merged);
  const db = openDb(cfg.dbFile);
  const audit = new Audit(db, clock);
  const epochFile = join(cfg.dataDir, 'cams-admin.epoch');
  if (checkEpoch(db, epochFile) === 'restored') {
    // The database went back in time (spec §11.4, §13.5).
    audit.write({ actorType: 'system', actor: 'system', action: 'restore-detected', outcome: 'ok' });
    log.warn('restore_detected');
  }
  writeEpochFile(db, epochFile);
  const signing = loadSigningKey(cfg.signingKeyFile);
  const registry = new Registry(db, clock, audit);
  const sessions = new Sessions(db, clock);
  const live = new LiveHub({ clock, maxPerSession: cfg.limits.sseStreamsPerSession, keepaliveMs: 25_000 });
  const status = new StatusStore({ db, clock, registry, live, offlineAfterMs: cfg.offlineAfterS * 1000, snapshotMs: cfg.statusSnapshotS * 1000 });
  const hub = new Hub({ db, clock, cfg, registry, audit, status, log, signingKey: signing.key, serverKeyFingerprint: signing.fingerprint });
  const commands = new Commands({ db, clock, audit, registry, status, live, log, hub: () => hub });
  hub.deps.commands = commands;
  const journal = new RevocationJournal(join(cfg.dataDir, 'cams-revocations.jsonl'), log);
  const tokens = new Tokens({ db, clock, audit, registry, commands, live, log, journal: (tokenIds) => journal.append({ kind: 'tokens', tokenIds }, clock.now()) });
  status.onTokens = (proxyId, t) => tokens.onHeartbeat(proxyId, t);
  const config = new ProxyConfig({ db, clock, registry, commands, status, live, log });
  status.onConfig = (proxyId) => config.onHeartbeat(proxyId);
  const actions = new RemoteActions({ db, audit, registry, commands, status, clock, config });
  const enrollment = new Enrollment({ db, clock, audit, registry, cfg, serverKeys: [signing.publicKeyB64], onKeyRevoked: (k) => hub.closeKey(k, 4401), onProxyChanged: (p) => live.publishRegistry('proxy', p) });
  const backup = createBackup({ db, clock, cfg, audit, env: merged });
  // P4: cams instances. R4-19: blocking or deleting one revokes the tokens it holds.
  const camsInstances = new CamsInstances({
    db, clock, audit, registry, cfg, serverKeys: [signing.publicKeyB64], serverKeyFingerprints: [signing.fingerprint],
    onRevoke: (instanceId, actor, scope) => { tokens.revokeHeldBy(actor, instanceId, scope); },
    journal: (r) => journal.append(r, clock.now()),
  });
  // What was revoked stays revoked, whatever a restore brought back (review M5).
  for (const r of journal.read()) {
    try { camsInstances.replay(r, (t) => tokens.revokeReplayed(t)); } catch (e) { log.error({ err: e }, 'cams_revocation_replay_failed'); }
  }
  const importer = new Importer({ db, clock, audit, registry, instances: camsInstances, status });
  const camsAuth = new CamsAuth({ db, clock, audit, instances: camsInstances, signingKey: signing.key, limits: cfg.limits, log });
  const camsEnrollment = new CamsEnrollment({ db, clock, audit, instances: camsInstances, cfg, serverKeys: [signing.publicKeyB64], serverKeyFingerprints: [signing.fingerprint] });

  const app = express();
  app.disable('x-powered-by');
  // Traefik in front: for req.secure only. No limit ever keys on req.ip.
  app.set('trust proxy', merged.TRUST_PROXY === '0' ? false : 1);
  app.use(securityHeaders(cfg));
  app.get('/health', (_req, res) => {
    const b = backup.state();
    res.set('Cache-Control', 'no-store').json({ status: 'ok', version: version(), backup: {
      lastReplicationAt: b.lastReplicationAt, lastSnapshotAt: b.lastSnapshotAt, lastManualAt: b.lastManual?.at ?? null, lastManualOk: b.lastManual?.ok ?? null,
      // Public: error names and counts only, never a message (it can name the bucket).
      replicationCheckError: b.lastReplicationError?.split(':')[0] ?? null, replicationCheckErrors: b.replicationCheckErrors,
      litestreamSyncErrors: b.litestreamSyncErrors, litestreamReplicaErrors: b.litestreamReplicaErrors,
    } });
  });
  app.use(enrollRouter(enrollment));
  app.use(camsRouter({ globalPerMin: cfg.limits.camsGlobalPerMin, enrollment: camsEnrollment, auth: camsAuth, signingKey: signing.key, testRoutes: cfg.nodeEnv === 'test', instances: camsInstances, tokens, snapshot: { db, clock, signingKey: signing.key, signingFingerprint: signing.fingerprint } }));
  app.use(cookieParser());
  app.use(authRoutes({ cfg, sessions, audit, clock, live }));
  const api = apiRouter({ db, clock, cfg, audit, registry, enrollment, hub, status, live, sessions, backup, commands, tokens, config, actions, camsInstances, serverKeyFingerprints: [signing.fingerprint], importer });
  app.use('/api/v1', api);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' }));
  // The Svelte build (npm run build:web); every other GET is the SPA.
  const web = [join(__dirname, '../web'), join(__dirname, '../../dist/web')].find((p) => existsSync(join(p, 'index.html')));
  if (web) {
    app.use(express.static(web, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
    app.get(/^\/(?!api\/|auth\/|proxy\/|cams\/).*/, limiter({ windowMs: 60_000, limit: 3000, key: () => 'pages' }), (_req, res) => res.set('Cache-Control', 'no-store').sendFile(join(web, 'index.html')));
  }
  app.use(((err, _req, res, _next) => {
    log.error({ err }, 'request_failed');
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  }) as express.ErrorRequestHandler);

  const http = createServer(app);
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== CONNECT_PATH) return void socket.destroy();
    hub.handleUpgrade(req, socket, head);
  });

  let lastDaily = 0;
  const tick = () => {
    try {
      status.tick();
      commands.tick();
      tokens.tick();
      camsAuth.sweep();
      config.tick();
      audit.flushThrottled();
      writeEpochFile(db, epochFile);
      if (clock.now() - lastDaily > 86400_000) {
        lastDaily = clock.now();
        audit.prune();
        status.pruneEvents();
        sessions.prune();
      }
    } catch (e) {
      log.error({ err: e }, 'tick_failed');
    }
  };
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  return {
    cfg, clock, db, audit, registry, live, status, hub, commands, tokens, actions, config, enrollment, sessions, backup, camsInstances, camsAuth, importer, signing, app, http, epochFile, tick,
    writeRoutes() {
      const out: string[] = [];
      for (const layer of (api as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
        if (!layer.route) continue;
        for (const m of Object.keys(layer.route.methods)) if (!['get', 'head', 'options'].includes(m)) out.push(`${m.toUpperCase()} ${layer.route.path}`);
      }
      return out;
    },
    async listen(port = cfg.port, host?: string) {
      // An error (EADDRINUSE) rejects instead of hanging.
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve();
        });
      });
      timer = setInterval(tick, cfg.tickMs);
      timer.unref();
      backup.start?.();
      return (http.address() as { port: number }).port;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      backup.stop?.();
      await hub.shutdown();
      live.close();
      try { status.flush(true); } catch (e) { log.error({ err: e }, 'status_flush_failed'); }
      // close() waits for every connection: idle keep-alive ones would hold
      // it forever, so they are cut first (a request in flight still ends).
      const httpClosed = new Promise((r) => (http.listening ? http.close(r) : r(undefined)));
      http.closeIdleConnections();
      setTimeout(() => http.closeAllConnections(), 2000).unref();
      await httpClosed;
      try { writeEpochFile(db, epochFile); } catch { /* closing */ }
      db.close();
    },
  };
}

if (require.main === module) {
  const s = buildServer();
  // HOST: e.g. 127.0.0.1 for the local stack; all interfaces by default (the pod).
  s.listen(undefined, process.env.HOST || undefined).then((port) => log.info({ port, version: version() }, 'cams_admin_listening'));
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'cams_admin_stopping');
    const t = setTimeout(() => process.exit(1), 15_000);
    s.close().then(() => { clearTimeout(t); process.exit(0); });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
