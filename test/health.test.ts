import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';

describe('/health', () => {
  const app = createApp({ health: () => ({ lastReplicationAt: null, lastSnapshotAt: null }) });

  it('answers GET with status, version and the backup times', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', version: 'dev', backup: { lastReplicationAt: null, lastSnapshotAt: null } });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('answers HEAD with 200 and no body (UptimeRobot)', async () => {
    const r = await request(app).head('/health');
    expect(r.status).toBe(200);
    expect(r.text ?? '').toBe('');
  });
});
