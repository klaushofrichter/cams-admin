import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

describe('/health', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());

  it('answers GET with status, version and the backup times', async () => {
    const r = await request(a.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', version: 'dev', backup: { lastReplicationAt: null, lastSnapshotAt: null, lastManualAt: null, lastManualOk: null } });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('answers HEAD with 200 and no body (UptimeRobot)', async () => {
    const r = await request(a.app).head('/health');
    expect(r.status).toBe(200);
    expect(r.text ?? '').toBe('');
  });
});

describe('listen', () => {
  const dir = tmpDir();
  it('rejects on a port in use instead of hanging', async () => {
    const a = testApp(dir);
    const b = testApp(dir);
    const port = await a.listen(0, '127.0.0.1');
    await expect(b.listen(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    await a.close();
    await b.close();
  });
});
