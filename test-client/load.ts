// The load test (spec §15.4):
//   npm run load -- --proxies 50 --cameras 4 --duration 60m [--heartbeat 30] [--report FILE]
// Starts the built cams-admin (dist/) on a loopback port with a fresh SQLite
// file, creates one account per 10 proxies, enrolls every proxy with a code,
// runs the test clients (realistic summaries, 1 % of heartbeats change a
// camera), keeps two dashboard SSE streams open, samples the server, and
// checks the pass criteria. Exit code 0 = pass.
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { enroll, ProxyClient } from './client';
import { makeSummary } from './summaries';
import { generateKeyPair } from '../server/crypto/ed25519';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const dur = (s: string) => { const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(s); if (!m) throw new Error(`bad duration ${s}`); return Number(m[1]) * ({ s: 1000, m: 60_000, h: 3600_000 }[m[2] as 's' | 'm' | 'h'] ?? 1000); };
const PROXIES = Number(opt('proxies', '50'));
const CAMERAS = Number(opt('cameras', '4'));
const DURATION = dur(opt('duration', '60m'));
const HB = Number(opt('heartbeat', '30'));
const REPORT = opt('report', '');
const EMAIL = 'load@example.com';
const say = (m: string) => process.stdout.write(`load: ${m}\n`);

const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  const root = join(__dirname, '..');
  const serverJs = [join(root, 'dist/server/server.js'), join(root, '../server/server.js')].find(existsSync);
  if (!serverJs) throw new Error('build first: npm run build:server');
  const work = mkdtempSync(join(tmpdir(), 'cams-admin-load-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const keyFile = join(work, 'signing.pem');
  writeFileSync(keyFile, `-----BEGIN PRIVATE KEY-----\n${generateKeyPair().privateKeyPkcs8B64}\n-----END PRIVATE KEY-----\n`);
  chmodSync(keyFile, 0o600);
  const env = {
    ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(port), PUBLIC_URL: url, DB_FILE: join(work, 'cams-admin.db'),
    SERVER_SIGNING_KEY_FILE: keyFile, ALLOWED_EMAILS: EMAIL, HEARTBEAT_S: String(HB), OFFLINE_AFTER_S: String(HB * 3),
    LIMIT_ENROLL_GLOBAL: '100000', LIMIT_WRITES_PER_SESSION: '100000', TICK_MS: '1000',
  };
  const srv = spawn(process.execPath, [serverJs], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  let stopping = false;
  srv.on('exit', (c) => { if (!stopping) { say(`server exited (${c})`); process.exit(1); } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }

  // A sysadmin session straight into the file (scripts/dev-session.ts's way).
  const cookie = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', join(root, 'scripts/dev-session.ts'), EMAIL], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error('dev-session failed'))));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json()) as Record<string, unknown>;
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };

  say(`server :${port}; enrolling ${PROXIES} proxies × ${CAMERAS} cameras`);
  const clients: { c: ProxyClient; proxyId: string; offline: Set<string> }[] = [];
  let accountId = '';
  for (let i = 0; i < PROXIES; i++) {
    if (i % 10 === 0) accountId = (await api('POST', '/accounts', { name: `load-${i / 10}`, displayName: `Load ${i / 10}` })).id;
    const p = await api('POST', `/accounts/${accountId}/proxies`, { name: `p${i}`, displayName: `P${i}`, runsOn: 'local-host' });
    const code = (await api('POST', `/accounts/${accountId}/proxies/${p.id}/enrollment-codes`, {})).code;
    const key = await enroll(url, code, { version: 'load', cameraIds: [] });
    const offline = new Set<string>();
    const c = new ProxyClient({ key, heartbeatS: HB, jitterS: Math.min(2, HB / 10), summary: () => makeSummary({ cameras: CAMERAS, now: Date.now(), offline: [...offline] }), version: 'load' });
    clients.push({ c, proxyId: p.id, offline });
  }

  // Two dashboards.
  type Ev = { at: number; proxyId: string; state: string; cameras: { ref: string; online: boolean | null }[] };
  const streams: Ev[][] = [[], []];
  const ctl = new AbortController();
  for (const evs of streams) {
    const r = await fetch(`${url}/api/v1/live`, { headers: { Cookie: `__Host-cams_admin=${cookie}` }, signal: ctl.signal });
    void (async () => {
      const rd = r.body!.getReader();
      let buf = '';
      for (;;) {
        const x = await rd.read().catch(() => ({ done: true, value: undefined }));
        if (x.done) break;
        buf += new TextDecoder().decode(x.value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('event: status')) evs.push({ at: Date.now(), ...JSON.parse(chunk.split('\ndata: ')[1]) });
        }
      }
    })();
  }

  // Start everyone, spread over one heartbeat interval.
  for (const [i, x] of clients.entries()) setTimeout(() => x.c.start(), (i / clients.length) * Math.min(HB * 1000, 5000));
  const t0 = Date.now();
  const changes: { at: number; proxyId: string; ref: string; online: boolean }[] = [];
  for (const x of clients) {
    x.c.on('ack', () => {
      if (Math.random() < 0.01) {
        const ref = `cam${1 + Math.floor(Math.random() * CAMERAS)}`;
        const online = x.offline.has(ref);
        if (online) x.offline.delete(ref); else x.offline.add(ref);
        changes.push({ at: Date.now(), proxyId: x.proxyId, ref, online });
      }
    });
  }
  const samples: { t: number; rss: number; lagP99: number; db: number; writes: number }[] = [];
  const sample = async () => {
    const m = await api('GET', '/dev/metrics');
    samples.push({ t: Date.now() - t0, rss: m.rssBytes, lagP99: m.loopLagP99Ms, db: m.dbBytes, writes: m.writeEpoch });
  };
  const sampler = setInterval(() => void sample().catch(() => undefined), Math.max(2000, Math.min(60_000, DURATION / 60)));
  const progress = setInterval(() => say(`${Math.round((Date.now() - t0) / 1000)} s: ${clients.filter((x) => x.c.state === 'connected').length}/${clients.length} connected, ${clients.reduce((n, x) => n + x.c.stats.acked, 0)} acks`), Math.max(10_000, DURATION / 12));
  await new Promise((r) => setTimeout(r, DURATION));
  clearInterval(sampler);
  clearInterval(progress);
  await sample();
  // Let the last heartbeats' acks land, then measure.
  await new Promise((r) => setTimeout(r, 1500));
  const dash = await api('GET', '/dashboard');

  // --- the criteria ---------------------------------------------------------------
  const sent = clients.reduce((n, x) => n + x.c.stats.sent, 0);
  const acked = clients.reduce((n, x) => n + x.c.stats.acked, 0);
  const lat = clients.flatMap((x) => x.c.stats.ackLatencyMs);
  const reconnects = clients.reduce((n, x) => n + x.c.stats.reconnects, 0);
  const startedAt = Math.min(HB * 1000, 5000) + 3000;
  const offlineSeen = streams[0].filter((e) => e.at - t0 > startedAt && e.state !== 'online').length;
  const settled = changes.filter((c) => Date.now() - c.at > 2000);
  const missedSse = streams.map((evs) => settled.filter((c) => !evs.some((e) => e.at >= c.at && e.proxyId === c.proxyId && e.cameras.some((k) => k.ref === c.ref && k.online === c.online))).length);
  const second = samples.filter((x) => x.t >= DURATION / 2);
  const rssMax = Math.max(...samples.map((x) => x.rss));
  const rssGrowth = second.length > 1 ? (second[second.length - 1].rss - second[0].rss) / second[0].rss : 0;
  const lagP99 = Math.max(...samples.slice(1).map((x) => x.lagP99));
  const db = samples[samples.length - 1].db;
  const writes = samples[samples.length - 1].writes - samples[0].writes;
  const online = dash.summary.proxiesOnline;
  const MiB = 1024 * 1024;
  const checks: [string, boolean, string][] = [
    ['every heartbeat acknowledged', sent - acked <= clients.length, `${acked}/${sent} (in flight at the end ≤ ${clients.length})`],
    ['no reconnects', reconnects === 0, String(reconnects)],
    ['no proxy shown offline while sending', offlineSeen === 0 && online === PROXIES, `${offlineSeen} non-online events; ${online}/${PROXIES} online at the end`],
    ['p99 heartbeat→ack under 50 ms', pct(lat, 99) < 50, `p50 ${pct(lat, 50)} ms, p99 ${pct(lat, 99)} ms, max ${Math.max(...lat)} ms`],
    ['server RSS under 200 MiB', rssMax < 200 * MiB, `max ${(rssMax / MiB).toFixed(1)} MiB`],
    ['RSS flat over the second half (< 10 % growth)', rssGrowth < 0.1, `${(rssGrowth * 100).toFixed(1)} %`],
    ['database under 50 MiB', db < 50 * MiB, `${(db / MiB).toFixed(2)} MiB`],
    ['event loop lag p99 under 20 ms', lagP99 < 20, `${lagP99.toFixed(1)} ms`],
    ['SSE: both dashboards saw every camera change', missedSse.every((m) => m === 0), `${settled.length} changes; missed ${missedSse.join(', ')}`],
  ];
  const report = {
    proxies: PROXIES, cameras: CAMERAS, durationS: DURATION / 1000, heartbeatS: HB, heartbeatsSent: sent, acked, ackLatencyMs: { p50: pct(lat, 50), p99: pct(lat, 99), max: Math.max(...lat) },
    rssMiB: { start: samples[0].rss / MiB, max: rssMax / MiB, end: samples[samples.length - 1].rss / MiB }, loopLagP99Ms: lagP99, dbMiB: db / MiB, dbWriteTransactions: writes,
    cameraChanges: changes.length, sseEvents: streams.map((s) => s.length), checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
  };
  for (const [name, ok, detail] of checks) say(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  say(`database write transactions during the run: ${writes}`);
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));

  ctl.abort();
  await Promise.all(clients.map((x) => x.c.stop()));
  stopping = true;
  srv.kill('SIGTERM');
  await new Promise((r) => srv.once('exit', r));
  rmSync(work, { recursive: true, force: true });
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`load: ${(e as Error).stack}\n`); process.exit(1); });
