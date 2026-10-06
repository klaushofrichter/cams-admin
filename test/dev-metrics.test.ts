import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

describe('/api/v1/dev/metrics', () => {
  const dir = tmpDir();
  const dev = testApp(dir, { NODE_ENV: 'development' });
  const prod = testApp(dir, { NODE_ENV: 'production' });
  afterAll(async () => { await dev.close(); await prod.close(); });

  it('answers in development only, for a signed-in sysadmin', async () => {
    const r = await dev.api('get', '/dev/metrics');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rssBytes: expect.any(Number), loopLagP99Ms: expect.any(Number), dbBytes: expect.any(Number), connections: { open: 0, live: 0 } });
    expect((await prod.api('get', '/dev/metrics')).status).toBe(404);
  });
});
