// A proxy reconnecting while cams-admin shuts down must not keep close()
// waiting (the flaky restart tests: an upgrade accepted after the hub's
// shutdown left a WebSocket that http.close() never sees).
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { tmpDir } from './helpers/tmp';
import { startServer } from './helpers/server';

describe('shutdown', () => {
  const dir = tmpDir();
  it('upgrades during shutdown are refused and close() finishes', async () => {
    const s = await startServer(dir);
    // Keep upgrading in a tight loop while the server closes.
    let stop = false;
    const sockets: WebSocket[] = [];
    const loop = (async () => {
      while (!stop) {
        const ws = new WebSocket(s.wsUrl, ['cams-admin.v1']);
        ws.on('error', () => undefined);
        sockets.push(ws);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const closing = s.stop();
    const result = await Promise.race([closing.then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    stop = true;
    await loop;
    for (const w of sockets) w.terminate();
    expect(result).toBe('closed');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
