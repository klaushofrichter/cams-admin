import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { existsSync } from 'fs';

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

  it('?gc=1: heap after a forced GC when the process has --expose-gc (null otherwise)', async () => {
    const g = globalThis as { gc?: () => void };
    const had = g.gc;
    try {
      g.gc = undefined;
      expect((await dev.api('get', '/dev/metrics?gc=1')).body.heapAfterGcBytes).toBeNull();
      let called = 0;
      g.gc = () => { called++; };
      const r = (await dev.api('get', '/dev/metrics?gc=1')).body;
      expect(called).toBe(1);
      expect(r.heapAfterGcBytes).toEqual(expect.any(Number));
      expect((await dev.api('get', '/dev/metrics')).body.heapAfterGcBytes).toBeNull();
      expect(called).toBe(1);
    } finally {
      g.gc = had;
    }
  });

  it('POST /dev/heap-snapshot writes a heap snapshot into the data folder (development only)', async () => {
    const r = await dev.api('post', '/dev/heap-snapshot', {});
    expect(r.status).toBe(200);
    expect(r.body.file).toMatch(/\.heapsnapshot$/);
    expect(existsSync(r.body.file)).toBe(true);
    expect(r.body.file.startsWith(dev.cfg.dataDir)).toBe(true);
    expect((await prod.api('post', '/dev/heap-snapshot', {})).status).toBe(404);
  });
});
