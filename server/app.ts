import express from 'express';
import { version } from './version';

export interface BackupHealth { lastReplicationAt: number | null; lastSnapshotAt: number | null }
export interface AppDeps { health: () => BackupHealth }

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // GET and HEAD (Express answers HEAD from the GET route): the release smoke
  // test, the probes, UptimeRobot (HEAD) and the Grafana dead-man alert.
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', version: version(), backup: d.health() });
  });
  return app;
}
