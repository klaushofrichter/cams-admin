import { createConnection, createServer, type Socket } from 'net';

// A TCP proxy between a client and the server that can blackhole traffic or
// slow it down (fault injection, spec §15.4).
export async function tcpProxy(targetPort: number) {
  let black = false;
  let latencyMs = 0;
  let bytesPerS = 0;
  const pairs = new Set<[Socket, Socket]>();
  const pipe = (from: Socket, to: Socket) => {
    from.on('data', (chunk) => {
      if (black) return; // swallowed: a half-open connection
      const delay = latencyMs + (bytesPerS ? (chunk.length / bytesPerS) * 1000 : 0);
      if (!delay) to.write(chunk);
      else {
        from.pause();
        setTimeout(() => { if (!to.destroyed) to.write(chunk); from.resume(); }, delay);
      }
    });
  };
  const server = createServer((c) => {
    const s = createConnection(targetPort, '127.0.0.1');
    const pair: [Socket, Socket] = [c, s];
    pairs.add(pair);
    pipe(c, s);
    pipe(s, c);
    const end = () => { c.destroy(); s.destroy(); pairs.delete(pair); };
    c.on('close', end); s.on('close', end); c.on('error', end); s.on('error', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    blackhole(on: boolean) { black = on; },
    slow(ms: number, bps: number) { latencyMs = ms; bytesPerS = bps; },
    async close() { for (const [a, b] of pairs) { a.destroy(); b.destroy(); } await new Promise((r) => server.close(r)); },
  };
}
