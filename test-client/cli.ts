// The protocol test client on the command line (spec §15.5).
//   enroll  --url U --key FILE            the code from stdin (never an argument)
//   run     --key FILE [--cameras N] [--offline cam2,cam3] [--heartbeat S]
//   bridge  --key FILE --health URL       forwards a real cam-proxy's GET /api/local/health
//   ws-hold --key FILE [--minutes 5]      holds one connection; fails on any drop
import { readFileSync } from 'fs';
import { enroll, ProxyClient } from './client';
import { readKeyFile, writeKeyFile } from './keyfile';
import { makeSummary } from './summaries';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, def?: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  if (def === undefined) fail(`--${name} is required`);
  return def;
};
function fail(msg: string): never {
  process.stderr.write(`test-client: ${msg}\n`);
  process.exit(1);
}
const say = (m: string) => process.stdout.write(`${m}\n`);

async function main() {
  if (cmd === 'enroll') {
    if (args.includes('--code')) fail('the code is read from stdin, never an argument');
    const code = readFileSync(0, 'utf8').trim();
    const k = await enroll(opt('url'), code, { version: 'test-client', cameraIds: [] });
    writeKeyFile(opt('key'), k);
    say(`enrolled ${k.proxyId} in account ${k.account}`);
    return;
  }
  const key = readKeyFile(opt('key'));
  const stopOn = (c: ProxyClient) => {
    const stop = () => c.stop('shutdown').then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  };
  const logAll = (c: ProxyClient) => {
    c.on('state', (s) => say(`state ${s}`));
    c.on('log', (e, d) => say(`${e}${d ? ' ' + JSON.stringify(d) : ''}`));
  };
  if (cmd === 'run') {
    const cameras = Number(opt('cameras', '1'));
    const offline = opt('offline', '').split(',').filter(Boolean);
    const hb = args.includes('--heartbeat') ? Number(opt('heartbeat')) : undefined;
    const c = new ProxyClient({ key, summary: () => makeSummary({ cameras, now: Date.now(), offline }), heartbeatS: hb, minIntervalS: hb });
    logAll(c);
    stopOn(c);
    c.start();
    return;
  }
  if (cmd === 'bridge') {
    const health = opt('health');
    const c = new ProxyClient({
      key, version: 'bridge',
      summary: async () => {
        const r = await fetch(health, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`health ${r.status}`);
        return r.json();
      },
    });
    logAll(c);
    stopOn(c);
    c.start();
    return;
  }
  if (cmd === 'ws-hold') {
    const minutes = Number(opt('minutes', '5'));
    const c = new ProxyClient({ key, summary: () => makeSummary({ cameras: 1, now: Date.now() }), version: 'ws-hold' });
    let connects = 0;
    c.on('state', (s) => {
      if (s === 'connected') connects++;
      if (connects > 1 || s === 'rejected' || s === 'incompatible') {
        say(`ws-hold: connection dropped (${s}) after ${connects} connect(s)`);
        process.exit(1);
      }
    });
    c.start();
    setTimeout(async () => {
      const ok = c.state === 'connected' && connects === 1;
      say(`ws-hold: ${ok ? 'held' : 'failed'} for ${minutes} min, ${c.stats.acked} acks`);
      await c.stop('shutdown');
      process.exit(ok ? 0 : 1);
    }, minutes * 60_000);
    return;
  }
  fail('usage: enroll | run | bridge | ws-hold');
}

main().catch((e) => fail((e as Error).message));
