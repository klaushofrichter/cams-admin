// The camera-move check (cams-admin camera-move plan Task 10) against the
// running local stack, started with LOCALSTACK_MOVES=1 (beta-1 and beta-2 with
// a site CA each, their cameras over HTTPS, beta-1's camera cam4 with stills):
// a real move between the two real cam-proxies of account beta, run by this
// repo's cams-admin, with the cam-sim as the camera. Never anything but
// 127.0.0.1.
//   LOCALSTACK_MOVES=1 scripts/localstack/start.sh
//   npx tsx scripts/localstack/move-check.ts
// Setup: move.send and move.receive allowed on both proxies (their local admin
// token, as on their Cams-Admin page), the registry's site, TLS name, HTTPS url
// and CA fingerprint per proxy, and two past days of content for cam4 on
// beta-1 (stills packs, clips with snapshots, events). Scenarios:
//   1. beta-1 → beta-2: targets, request on the source page, approve with a 2×
//      budget, done; the registry names beta-2 and cam4.beta-2.internal,
//      beta-2 serves the copied days, beta-1 has nothing of cam4 left (but
//      what its cleanup kept by the target's keep list, never a seeded day),
//      cams-admin's audit has move-request … move-done.
//   2. beta-2 → beta-1 with beta-2 (the source) restarted during the copy
//      (SIGTERM to its cam-proxy; the supervisor starts it again): still done.
//   3. beta-1 → beta-2, cancelled in cams-admin after the switch-over: the
//      camera comes back, the registry names beta-1 again, beta-1 serves it;
//      the copy back (the return move) ends returned before scenario 4.
//   4. beta-1 → beta-2 started from cams-admin (POST /api/v1/moves with an
//      ops token), after breaking two fixable rules (beta-2's registry site,
//      a cams route to it): fixed, approved by beta-1 itself within the
//      bounds, done; audit move-fix, move-begin, move-request … move-done.
//   5. beta-2 → beta-1, cancelled after the switch-over once beta-1 captured
//      stills of cam4 itself (a whole minute after the switch-over's): the
//      return copies them back (returned, its check complete), beta-2 serves
//      them, beta-1 has nothing of cam4 left (but its kept overlap); audit
//      move-cancel … move-return … move-check … move-return.
// Prints one line per step, exits 1 at the first failure, 2 when the stack is
// not a moves stack. Reads secrets from the run's files (mode 600), never prints them.
import { createRequire } from 'module';
import { X509Certificate, createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const WORK = (process.env.LOCALSTACK_DIR ?? join(process.env.TMPDIR ?? tmpdir(), 'cams-admin-localstack')).replace(/\/$/, '');
const RUN = join(WORK, 'run');
const ADMIN = 'http://localhost:29000';
const CAM = 'cam4';
const CAMS_ID = 'beta-1-cam4';
const DAY = 86_400_000;
const MIN = 60_000;
// The seeded days: two and three days back, UTC, inside every retention (7 days).
const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const SEED_DAYS = [3, 2].map((n) => today - n * DAY);
const STILL_MINUTES = 150; // per day, from 10:00 UTC: one pack each (12 stills at 5 s)
const CLIPS = 8; // per day

class Fail extends Error {}
const expect = (ok: unknown, what: string): void => {
  if (!ok) throw new Fail(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, what: string, ms = 60_000, every = 500): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Fail(`timeout (${Math.round(ms / 1000)} s): ${what}`);
    await sleep(every);
  }
}
const t0 = Date.now();
const say = (s: string) => console.log(`move-check [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s] ${s}`);

if (!existsSync(join(RUN, 'plan.json'))) {
  console.error(`move-check: no local stack in ${WORK} (scripts/localstack/start.sh)`);
  process.exit(2);
}
const runEnv = existsSync(join(WORK, 'run.env')) ? readFileSync(join(WORK, 'run.env'), 'utf8') : '';
if (!/^MOVES=1$/m.test(runEnv)) {
  console.error('move-check: the stack was not started with LOCALSTACK_MOVES=1 (stop.sh, then LOCALSTACK_MOVES=1 start.sh)');
  process.exit(2);
}
if (!existsSync(join(WORK, 'src-cam-proxy/dist/src/moves/source.js'))) {
  console.error('move-check: the cam-proxy build has no camera moves (LOCALSTACK_CAM_PROXY_REF)');
  process.exit(2);
}
const cookie = readFileSync(join(RUN, 'cams-admin/cookie'), 'utf8').trim();
const plan = JSON.parse(readFileSync(join(RUN, 'plan.json'), 'utf8')) as { accounts: { name: string; proxies: { name: string; port: number; cameras: { id: string }[] }[] }[] };
const secret = (proxy: string, f: string) => readFileSync(join(RUN, proxy, 'secrets', f), 'utf8').trim();
// cam-proxy's own modules (its worktree's node_modules): sharp for the seeded JPEGs; the catalog is node:sqlite as in cam-proxy.
const proxyRequire = createRequire(join(WORK, 'src-cam-proxy', 'package.json'));

interface Px { name: string; port: number; https: number; id: string; admin: string; client: string; dataDir: string }
const pxs: Record<string, Px> = {};
let accountId = '';
let cameraId = '';

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${ADMIN}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}
async function proxyApi(px: Px, method: string, path: string, body?: unknown, token = px.admin): Promise<{ status: number; body: any; bytes: number }> {
  const r = await fetch(`http://127.0.0.1:${px.port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  let j: any = {};
  const json = (r.headers.get('content-type') ?? '').includes('json');
  try { j = json && buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { j = {}; }
  return { status: r.status, body: j, bytes: buf.length };
}
const health = async (px: Px) => (await fetch(`http://127.0.0.1:${px.port}/health`, { signal: AbortSignal.timeout(3000) })).ok;
const proxyView = async (px: Px) => ((await api('GET', `/accounts/${accountId}/proxies`)).body.items as any[]).find((p) => p.id === px.id);
const connected = async (px: Px) => (await proxyView(px))?.status?.connected === true;
const camera = async () => ((await api('GET', `/accounts/${accountId}/cameras`)).body.items as any[]).find((c) => c.id === cameraId);
const move = async (id: string) => (await api('GET', `/moves/${id}`)).body;

// --- setup ----------------------------------------------------------------------------------------

const ALLOW = ['tokens.apply', 'tokens.apply.admin', 'move.send', 'move.receive'];
const caFingerprint = (pem: string) => `SHA256:${createHash('sha256').update(new X509Certificate(pem).raw).digest('hex').toUpperCase()}`;

async function setup(): Promise<void> {
  const acc = (await api('GET', '/accounts')).body.items.find((a: any) => a.name === 'beta');
  expect(acc, 'account beta in cams-admin');
  accountId = acc.id;
  const reg = (await api('GET', `/accounts/${accountId}/proxies`)).body.items as any[];
  for (const name of ['beta-1', 'beta-2']) {
    const p = plan.accounts.find((a) => a.name === 'beta')!.proxies.find((x) => x.name === name)!;
    const r = reg.find((x) => x.name === name);
    expect(r, `${name} in the registry`);
    pxs[name] = { name, port: p.port, https: p.port + 3, id: r.id, admin: secret(name, 'proxy_admin_token'), client: secret(name, 'proxy_tokens').split(',')[0], dataDir: join(RUN, name, 'data') };
  }
  const cam = ((await api('GET', `/accounts/${accountId}/cameras`)).body.items as any[]).find((c) => c.camsId === CAMS_ID);
  expect(cam, `camera ${CAMS_ID} in the registry`);
  cameraId = cam.id;

  for (const px of Object.values(pxs)) {
    // The allow entries, with the proxy's own (local) admin token: what its Cams-Admin page does.
    const r = await proxyApi(px, 'PUT', '/control/admin/commands', { allow: ALLOW });
    expect(r.status === 200, `${px.name}: PUT /control/admin/commands ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    // The registry: the site the proxy reports, its TLS name, its HTTPS url and its CA (the target pins it).
    const ca = await fetch(`http://127.0.0.1:${px.port}/tls/ca.pem`);
    expect(ca.status === 200, `${px.name}: GET /tls/ca.pem ${ca.status} (no site CA: was the stack started with LOCALSTACK_MOVES=1?)`);
    const fp = caFingerprint(await ca.text());
    const version = (await api('GET', `/accounts/${accountId}/proxies/${px.id}`)).body.version;
    const u = await api('PATCH', `/accounts/${accountId}/proxies/${px.id}`, { version, url: `https://127.0.0.1:${px.https}`, tlsSite: px.name, tlsServername: `proxy.${px.name}.internal`, caFingerprints: [fp] });
    expect(u.status === 200, `${px.name}: PATCH registry ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`);
  }
  for (const px of Object.values(pxs)) {
    await waitFor(async () => {
      const v = await proxyView(px);
      return v?.status?.connected && ALLOW.every((e) => v.status.allow.includes(e)) && v.status.pin === 'match' && v.status.commands === 'allowed';
    }, `${px.name}: cams-admin sees it connected, allowing ${ALLOW.join(', ')}, its CA pinned`, 60_000);
  }
  say('setup: move.send + move.receive allowed on beta-1 and beta-2; registry site, TLS name, HTTPS url and CA fingerprint set');
  // The camera on beta-1 with a site-CA certificate (the first push runs about 30 s after the start).
  await waitFor(async () => {
    const r = await proxyApi(pxs['beta-1'], 'GET', `/api/cameras/${CAM}`, undefined, pxs['beta-1'].client);
    return r.status === 200 && r.body.online && r.body.tls?.mode === 'site-ca';
  }, `beta-1: ${CAM} online with mode site-ca`, 120_000, 2000);
  say(`setup: ${CAM} online on beta-1, its certificate from beta-1's site CA`);
  seed(pxs['beta-1']);
}

// Two past days of cam4's content on beta-1, written as cam-proxy writes it:
// stills packs (JPEGs, a JSON footer, its length, "CPK1"), clips with a
// snapshot and their catalog rows, events. Once per stack (a marker in run/).
function seed(px: Px): void {
  const marker = join(RUN, 'move-check-seeded');
  if (existsSync(marker)) return say('setup: content already seeded (an earlier run): not again');
  const { DatabaseSync } = proxyRequire('node:sqlite') as typeof import('node:sqlite');
  const jpeg = makeJpeg();
  const pad = (n: number) => String(n).padStart(2, '0');
  const parts = (ts: number) => { const d = new Date(ts); return [String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())]; };
  const hhmm = (ts: number) => { const d = new Date(ts); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`; };
  const put = (path: string, data: Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
  const db = new DatabaseSync(join(px.dataDir, 'catalog.sqlite'));
  db.exec('PRAGMA busy_timeout = 10000');
  let packs = 0;
  let clips = 0;
  for (const day of SEED_DAYS) {
    for (let i = 0; i < STILL_MINUTES; i++) {
      const minute = day + 10 * 3600_000 + i * MIN;
      const slots: [number, number][] = [];
      let off = 0;
      const imgs: Buffer[] = [];
      for (let s = 0; s < 12; s++) { imgs.push(jpeg); slots.push([off, jpeg.length]); off += jpeg.length; }
      const footer = Buffer.from(JSON.stringify({ v: 1, minute, intervalS: 5, size: '896x512', quality: 5, slots }));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(footer.length);
      put(join(px.dataDir, 'stills', CAM, ...parts(minute), `${hhmm(minute)}.pack`), Buffer.concat([...imgs, footer, len, Buffer.from('CPK1')]));
      packs++;
    }
    const insClip = db.prepare("INSERT INTO clips (cam, start_ts, end_ts, path, snapshot, stream, size, received_at, origin) VALUES (?, ?, ?, ?, ?, 'sub', ?, ?, 'ftp')");
    const insEvent = db.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, end_reason) VALUES (?, 'onvif', 'person', ?, ?, 'ended')");
    db.exec('BEGIN IMMEDIATE');
    {
      for (let c = 0; c < CLIPS; c++) {
        const ts = day + 14 * 3600_000 + c * 7 * MIN;
        const path = join(px.dataDir, 'clips', CAM, ...parts(ts), `${hhmm(ts)}-1.mp4`);
        const body = randomBytes(256 * 1024);
        put(path, body);
        put(path.replace(/\.mp4$/, '.jpg'), jpeg);
        insClip.run(CAM, ts, ts + 30_000, path, path.replace(/\.mp4$/, '.jpg'), body.length, ts + 40_000);
        insEvent.run(CAM, ts - 2000, ts + 25_000);
        clips++;
      }
    }
    db.exec('COMMIT');
  }
  db.close();
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  say(`setup: seeded ${CAM} on beta-1: ${packs} stills packs, ${clips} clips with snapshots and events over ${SEED_DAYS.map((d) => new Date(d).toISOString().slice(0, 10)).join(', ')}`);
}

// One small JPEG (896x512, a gradient) made with cam-proxy's sharp, in a child process (sharp is async).
function makeJpeg(): Buffer {
  const out = execFileSync(process.execPath, ['-e', `
    const sharp = require(${JSON.stringify(proxyRequire.resolve('sharp'))});
    const w = 896, h = 512, px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; px[i] = x % 256; px[i + 1] = y % 256; px[i + 2] = (x + y) % 256; }
    sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 40 }).toBuffer().then((b) => process.stdout.write(b));
  `], { maxBuffer: 16 * 1024 * 1024 });
  expect(out.length > 1000 && out[0] === 0xff && out[1] === 0xd8, 'a seeded JPEG');
  return out;
}

// --- what a proxy has of cam4 -------------------------------------------------------------------------

// The seeded days on a proxy through its client API: clips (and one clip file) and stills (and one still).
async function serves(px: Px): Promise<{ clips: number; stills: number; clipBytes: number; stillBytes: number }> {
  const from = Math.min(...SEED_DAYS);
  const to = Math.max(...SEED_DAYS) + DAY - 1;
  const cl = await proxyApi(px, 'GET', `/api/cameras/${CAM}/clips?from=${from}&to=${to}`, undefined, px.client);
  expect(cl.status === 200, `${px.name}: GET clips ${cl.status}`);
  const list = cl.body as { url: string; size: number }[];
  let stills = 0;
  let first: number | null = null;
  for (const day of SEED_DAYS) {
    const st = await proxyApi(px, 'GET', `/api/cameras/${CAM}/stills?from=${day}&to=${day + DAY - 1}`, undefined, px.client);
    expect(st.status === 200, `${px.name}: GET stills ${st.status}`);
    stills += (st.body as number[]).length;
    first ??= (st.body as number[])[0] ?? null;
  }
  const clipBytes = list.length ? (await proxyApi(px, 'GET', list[0].url, undefined, px.client)).bytes : 0;
  const stillBytes = first !== null ? (await proxyApi(px, 'GET', `/api/cameras/${CAM}/stills/${first}.jpg`, undefined, px.client)).bytes : 0;
  return { clips: list.length, stills, clipBytes, stillBytes };
}
const SEEDED = { clips: SEED_DAYS.length * CLIPS, stills: SEED_DAYS.length * STILL_MINUTES * 12 };

// Nothing of cam4 on a proxy: not listed, its routes 404, no content files
// left (`seededOnly`: none of the seeded days). `kept`: the files the proxy's
// own cleanup says it kept (the receiver's keep list: the overlap minute of
// the switch-over stays where it was, to age out there); none of the seeded days.
async function hasNothing(px: Px, seededOnly = false, kept = 0): Promise<string | null> {
  const list = await proxyApi(px, 'GET', '/api/cameras', undefined, px.client);
  if ((list.body as { id: string }[]).some((c) => c.id === CAM)) return 'listed in /api/cameras';
  const one = await proxyApi(px, 'GET', `/api/cameras/${CAM}`, undefined, px.client);
  if (one.status !== 404) return `GET /api/cameras/${CAM} answered ${one.status}`;
  if (kept > 0) {
    const seeded = countFiles(px, true);
    if (seeded) return `${seeded} content files of ${CAM} of the seeded days left in its data dir`;
  }
  const files = countFiles(px, seededOnly);
  return files > kept ? `${files} content files of ${CAM}${seededOnly ? ' of the seeded days' : ''} left in its data dir${kept ? ` (its cleanup kept ${kept})` : ''}` : null;
}

// The files a proxy's cleanup kept for some moves (cam-proxy's audit: move-cleanup of
// a move's source, move-return step finish of a copy back's source; per kind, files).
async function keptOn(px: Px, moveIds: string[]): Promise<number> {
  let n = 0;
  for (const action of ['move-cleanup', 'move-return']) {
    const r = await fetch(`http://127.0.0.1:${px.port}/control/audit?action=${action}&limit=200`, { headers: { Authorization: `Bearer ${px.admin}` }, signal: AbortSignal.timeout(15_000) });
    expect(r.status === 200, `${px.name}: GET /control/audit?action=${action} ${r.status}`);
    for (const l of (await r.text()).split('\n').filter(Boolean)) {
      const c = JSON.parse(l).cam_proxy ?? {};
      if (!moveIds.includes(c.moveId) || c.role !== 'source' || (action === 'move-return' && c.step !== 'finish')) continue;
      n += Object.values((c.kept ?? {}) as Record<string, { files: number }>).reduce((x, k) => x + (k.files ?? 0), 0);
    }
  }
  return n;
}
function countFiles(px: Px, seededOnly: boolean): number {
  let n = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  const pad = (x: number) => String(x).padStart(2, '0');
  const days = SEED_DAYS.map((t) => { const d = new Date(t); return join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())); });
  for (const f of ['stills', 'previews', 'clips', 'analytics', 'still-checks', 'archive']) {
    if (!seededOnly) walk(join(px.dataDir, f, CAM));
    else for (const d of days) walk(join(px.dataDir, f, CAM, d));
  }
  return n;
}

// --- one move --------------------------------------------------------------------------------------

interface Run { moveId: string; budgetS: number; estimateS: number }

// The source page's flow: target list, request, the target's answer, approve with a 2× budget
// (`factor`: a larger one slows the paced copy).
async function startMove(src: Px, tgt: Px, factor = 2): Promise<Run> {
  const c = await camera();
  expect(c.proxyId === src.id, `registry: ${CAMS_ID} on ${src.name} before the move (a fresh stack: stop.sh, LOCALSTACK_MOVES=1 start.sh)`);
  const tr = await proxyApi(src, 'POST', '/control/moves/targets', { camera: CAM });
  expect(tr.status === 202, `${src.name}: POST /control/moves/targets ${tr.status} ${JSON.stringify(tr.body)}`);
  const targets = await waitFor(async () => (await proxyApi(src, 'GET', `/control/moves/targets/${tr.body.requestId}`)).body.targets as { proxyId: string; name: string; site: string }[] | null, `${src.name}: move.targets from cams-admin`, 30_000);
  expect(targets.some((t) => t.proxyId === tgt.id && t.site === tgt.name), `${src.name}: ${tgt.name} among the targets (${JSON.stringify(targets)})`);
  say(`  move.targets: ${targets.map((t) => `${t.name} (${t.site})`).join(', ')}`);
  const rq = await proxyApi(src, 'POST', '/control/moves', { camera: CAM, target: tgt.id });
  expect(rq.status === 202, `${src.name}: POST /control/moves ${rq.status} ${JSON.stringify(rq.body)}`);
  const requestId = rq.body.requestId as string;
  const item = await waitFor(async () => {
    const it = ((await proxyApi(src, 'GET', '/control/moves')).body.items as any[]).find((m) => m.requestId === requestId);
    if (it?.phase === 'rejected' || it?.answer?.accept === false) throw new Fail(`${tgt.name} refused: ${JSON.stringify(it.answer)}`);
    return it?.phase === 'awaiting-approval' && it.answer?.accept ? it : null;
  }, `${src.name}: the answer to request ${requestId}`, 60_000).catch((e) => { throw e instanceof Fail ? e : new Fail(String(e)); });
  const answer = item.answer as { estimateS: number; space: { fits: boolean; needed: number } };
  expect(answer.space?.fits, `the content fits on ${tgt.name} (${JSON.stringify(answer.space)})`);
  const kinds = (['stills', 'clips', 'events', 'checks', 'archive'] as const).filter((k) => item.summary[k].files + item.summary[k].rows > 0);
  const budgetS = Math.max(1, factor * answer.estimateS);
  const p = { transfer: true, kinds, space: 'all', targetSettings: null, budgetS, estimateS: answer.estimateS };
  const ap = await proxyApi(src, 'POST', `/control/moves/${item.id}/approve`, { plan: p });
  expect(ap.status === 202, `${src.name}: approve ${ap.status} ${JSON.stringify(ap.body)}`);
  const kb = (n: number) => `${Math.round(n / 1024)} KiB`;
  say(`  ${item.id}: ${kinds.map((k) => `${k} ${item.summary[k].files} files/${item.summary[k].rows} rows`).join(', ')}; ${kb(answer.space.needed)}; estimate ${answer.estimateS} s, approved with budget ${budgetS} s`);
  return { moveId: item.id, budgetS, estimateS: answer.estimateS };
}

const phaseOf = async (id: string) => (await move(id)).phase as string;
async function waitPhase(run: Run, phases: string[], what: string, extraMs = 120_000): Promise<any> {
  return waitFor(async () => {
    const m = await move(run.moveId);
    if (['failed', 'rejected', 'expired'].includes(m.phase) && !phases.includes(m.phase)) throw new Fail(`${run.moveId}: ${m.phase} (${m.reason})`);
    return phases.includes(m.phase) ? m : null;
  }, `${run.moveId}: ${what}`, run.budgetS * 3000 + extraMs, 1000).catch((e) => { throw e instanceof Fail ? e : new Fail(String(e)); });
}

async function auditOf(moveId: string): Promise<string[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = (await api('GET', `/audit?account=${accountId}&limit=200${cursor ? `&cursor=${cursor}` : ''}`)).body;
    out.push(...(r.items as any[]).filter((a) => a.detail?.moveId === moveId));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out.reverse().map((a) => `${a.action}${a.detail?.phase ? `:${a.detail.phase}` : ''}${a.outcome !== 'ok' ? `(${a.outcome})` : ''}`);
}

// cams-admin's audit of the account, newest first (all pages up to 2000 rows), optionally one action.
async function auditRows(action?: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = (await api('GET', `/audit?account=${accountId}&limit=200${action ? `&action=${action}` : ''}${cursor ? `&cursor=${cursor}` : ''}`)).body;
    out.push(...(r.items as any[]));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

// `moveIds`: the moves whose cleanup on `other` may have kept files (its keep list).
async function assertOn(px: Px, other: Px, label: string, moveIds: string[], otherSeededOnly = false): Promise<void> {
  const c = await camera();
  expect(c.proxyId === px.id && c.proxyCameraId === CAM && c.tlsServername === `${CAM}.${px.name}.internal`, `registry: ${CAMS_ID} on ${px.name} as ${CAM}.${px.name}.internal (is ${c.proxyId}, ${c.tlsServername})`);
  await waitFor(async () => {
    const r = await proxyApi(px, 'GET', `/api/cameras/${CAM}`, undefined, px.client);
    return r.status === 200 && r.body.online && r.body.tls?.mode === 'site-ca' && r.body.tls?.servername === `${CAM}.${px.name}.internal`;
  }, `${px.name}: ${CAM} online, its certificate from ${px.name}'s site CA`, 60_000, 1000);
  const s = await serves(px);
  expect(s.clips === SEEDED.clips && s.stills >= SEEDED.stills && s.clipBytes === 256 * 1024 && s.stillBytes > 1000,
    `${px.name} serves the seeded days: ${JSON.stringify(s)} (want ${SEEDED.clips} clips, ${SEEDED.stills} stills)`);
  say(`  ${label}: registry ${CAMS_ID} → ${px.name} (${CAM}.${px.name}.internal); ${px.name} serves ${s.clips} clips and ${s.stills} stills of the seeded days (one clip ${s.clipBytes} B, one still ${s.stillBytes} B)`);
  const kept = await keptOn(other, moveIds);
  const left = await waitFor(async () => ((await hasNothing(other, otherSeededOnly, kept)) === null ? 'nothing' : null), `${other.name} has nothing of ${CAM}`, 60_000, 1000)
    .catch(async (e) => { throw new Fail(`${(e as Error).message}: ${await hasNothing(other, otherSeededOnly, kept)}`); });
  say(`  ${other.name}: ${left} of ${CAM} (not listed, 404, no content files${otherSeededOnly ? ' of the seeded days' : ''}${kept ? `; its cleanup kept ${kept} files of the overlap, none of the seeded days` : ''})`);
}

// The copy back of a move cancelled after the switch-over: its return move, until it ends returned.
async function waitReturn(cancelledId: string): Promise<any> {
  const returnId = await waitFor(async () => (await move(cancelledId)).returnId as string | null, `${cancelledId}: its return move`, 60_000, 1000);
  const r = await move(returnId);
  expect(r.returnOf === cancelledId && r.source.id === (await move(cancelledId)).target.id, `${returnId}: the return of ${cancelledId}, roles swapped (${JSON.stringify({ returnOf: r.returnOf, source: r.source, target: r.target })})`);
  const m = await waitPhase({ moveId: returnId, budgetS: 60, estimateS: 0 }, ['returned'], 'returned');
  say(`  ${returnId} (copy back of ${cancelledId}): ${m.phase}, ${m.bytesDone}/${m.bytesTotal} B, check ${JSON.stringify(m.check)}`);
  return m;
}

// cams-admin's audit rows of some moves, oldest first, as action[:phase|:step](outcome).
async function auditOfMoves(ids: string[]): Promise<{ name: string; at: number }[]> {
  const rows = (await auditRows()).filter((a) => ids.includes(a.detail?.moveId)).reverse();
  return rows.map((a) => ({ name: `${a.action}${a.detail?.phase ? `:${a.detail.phase}` : ''}${a.detail?.step ? `/${a.detail.step}` : ''}${a.outcome !== 'ok' ? `(${a.outcome})` : ''}`, at: a.at as number }));
}

// The cam-proxy process under beta-2's supervisor (its child): its PID, checked by its command line.
function proxyChild(px: Px): number {
  const sup = readFileSync(join(WORK, 'pids'), 'utf8').split('\n').map((l) => l.trim().split(' ')).find((f) => f[1] === px.name)?.[0];
  expect(sup, `${px.name}: in the pids file`);
  const kids = execFileSync('pgrep', ['-P', sup!], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  for (const k of kids) {
    const cmd = execFileSync('ps', ['-p', String(k), '-o', 'command='], { encoding: 'utf8' });
    if (cmd.includes(join(WORK, 'src-cam-proxy/dist/src/cli.js'))) return k;
  }
  throw new Fail(`${px.name}: no cam-proxy child of the supervisor ${sup}`);
}

// --- the scenarios ----------------------------------------------------------------------------------------

const scenarios: [string, () => Promise<void>][] = [
  ['beta-1 → beta-2: request on the source page, approve (2× budget), done; registry, content, audit', async () => {
    const [src, tgt] = [pxs['beta-1'], pxs['beta-2']];
    const run = await startMove(src, tgt);
    const m = await waitPhase(run, ['done'], 'done');
    expect(!m.cleanupPending && m.reason === null, `done cleanly (cleanupPending ${m.cleanupPending}, reason ${m.reason})`);
    const d = await move(run.moveId);
    say(`  done: ${m.bytesDone}/${m.bytesTotal} B, chunks ${JSON.stringify(d.chunks)}`);
    expect(d.chunks.failed === 0 && d.chunks.abandoned === 0 && d.chunks.pending === 0, `no chunk failed, abandoned or pending: ${JSON.stringify(d.chunks)}`);
    await assertOn(tgt, src, 'after the move', [run.moveId]);
    const a = await auditOf(run.moveId);
    say(`  cams-admin audit: ${a.join(' → ')}`);
    expect(a[0] === 'move-request:requested' && a.at(-1) === 'move-done:done', `audit from move-request to move-done (${a.join(', ')})`);
    for (const want of ['move-offer:offered', 'move-offer:awaiting-approval', 'move-approve:approved', 'move-phase:switching', 'move-phase:copying', 'move-phase:released', 'move-phase:cleaning']) expect(a.includes(want), `audit has ${want}`);
  }],
  ['beta-2 → beta-1 with beta-2 (the source) restarted during the copy: still done', async () => {
    const [src, tgt] = [pxs['beta-2'], pxs['beta-1']];
    const run = await startMove(src, tgt);
    await waitPhase(run, ['copying', 'cleaning', 'done'], 'copying');
    expect((await phaseOf(run.moveId)) === 'copying', 'still copying when the restart comes (raise the seeded content if the copy is too quick)');
    const pid = proxyChild(src);
    process.kill(pid, 'SIGTERM');
    say(`  ${src.name}: SIGTERM to its cam-proxy (PID ${pid}) while copying`);
    await waitFor(async () => !(await health(src).catch(() => false)), `${src.name} goes away`, 30_000);
    await waitFor(() => health(src), `${src.name} is back (the supervisor started it again)`, 90_000);
    const again = proxyChild(src);
    expect(again !== pid, `${src.name}: a new cam-proxy process`);
    await waitFor(() => connected(src), `${src.name} reconnects to cams-admin`, 90_000);
    say(`  ${src.name}: back (PID ${again}), connected; the move is ${await phaseOf(run.moveId)}`);
    const m = await waitPhase(run, ['done'], 'done after the restart');
    expect(!m.cleanupPending && m.reason === null, `done cleanly (cleanupPending ${m.cleanupPending}, reason ${m.reason})`);
    const d = await move(run.moveId);
    say(`  done: ${m.bytesDone}/${m.bytesTotal} B, chunks ${JSON.stringify(d.chunks)}`);
    expect(d.chunks.failed === 0 && d.chunks.abandoned === 0, `no chunk failed or abandoned: ${JSON.stringify(d.chunks)}`);
    await assertOn(tgt, src, 'after the move', [run.moveId]);
    const a = await auditOf(run.moveId);
    expect(a[0] === 'move-request:requested' && a.at(-1) === 'move-done:done', `audit from move-request to move-done (${a.join(', ')})`);
  }],
  ['beta-1 → beta-2, cancelled in cams-admin after the switch-over: the camera back on beta-1', async () => {
    const [src, tgt] = [pxs['beta-1'], pxs['beta-2']];
    const run = await startMove(src, tgt);
    await waitPhase(run, ['copying', 'cleaning', 'done'], 'copying');
    expect((await phaseOf(run.moveId)) === 'copying', 'still copying when the cancel comes');
    const c = await camera();
    expect(c.proxyId === tgt.id, `registry: switched over to ${tgt.name} before the cancel`);
    const r = await api('POST', `/moves/${run.moveId}/cancel`, { confirm: 'cancel', copied: 'delete' });
    expect(r.status === 202 && r.body.phase === 'cancelling', `cancel: ${r.status} ${JSON.stringify(r.body)}`);
    say(`  cancelled in cams-admin while copying (copied: delete): ${r.body.phase}`);
    const m = await waitPhase(run, ['cancelled'], 'cancelled');
    say(`  ${m.phase}`);
    // The copy back of what beta-2 captured since the switch-over: it ends before scenario 4 starts.
    const ret = await waitReturn(run.moveId);
    expect(ret.check?.complete === true, `${ret.id}: check complete (${JSON.stringify(ret.check)})`);
    // beta-2 keeps nothing of the seeded days; what it captured itself is copied back (scenario 5 checks that strictly).
    await assertOn(src, tgt, 'after the cancel and its copy back', [run.moveId, ret.id], true);
    const a = await auditOf(run.moveId);
    say(`  cams-admin audit: ${a.join(' → ')}`);
    expect(a.includes('move-cancel:cancelling') && a.includes('move-phase:cancelled'), `audit has the cancel (${a.join(', ')})`);
  }],
  ['beta-1 → beta-2 started from cams-admin (POST /moves with an ops token), fixes made, approved automatically', async () => {
    const [src, tgt] = [pxs['beta-1'], pxs['beta-2']];
    const c0 = await camera();
    expect(c0.proxyId === src.id, `registry: ${CAMS_ID} on ${src.name} before the move (scenario 3 left it there)`);
    const before = new Set(((await api('GET', `/diag/moves?accountId=${accountId}`)).body.items as any[]).map((m) => m.id));
    // An operations token with scope moves, as a script would use; it is revoked at the end.
    const issued = await api('POST', '/ops-tokens', { name: 'move-check', days: 1, scopes: ['moves'] });
    expect(issued.status === 201 && typeof issued.body.token === 'string', `POST /ops-tokens ${issued.status}`);
    const token = issued.body.token as string;
    const tokenId = issued.body.item.id as string;
    try {
      // Break two fixable rules: the target's registry site, and (if any) a cams route to the target.
      // caFingerprints and tlsServername stay as they are (the fixers never write them).
      const proxy = (await api('GET', `/accounts/${accountId}/proxies/${tgt.id}`)).body;
      const un = await api('PATCH', `/accounts/${accountId}/proxies/${tgt.id}`, { version: proxy.version, tlsSite: null });
      expect(un.status === 200 && un.body.tlsSite === null, `${tgt.name}: PATCH tlsSite null ${un.status} ${JSON.stringify(un.body).slice(0, 200)}`);
      let routedFrom: string | null = null;
      for (const i of (await api('GET', '/cams-instances')).body.items as { id: string; name: string }[]) {
        const routes = (await api('GET', `/cams-instances/${i.id}/routes`)).body.items as { proxyId: string; hidden: boolean }[];
        if (!routes.some((r) => r.proxyId === src.id) || !routes.some((r) => r.proxyId === tgt.id && !r.hidden)) continue;
        const del = await api('DELETE', `/cams-instances/${i.id}/routes/${tgt.id}`);
        expect(del.status === 204 || del.status === 200, `DELETE route ${i.name} → ${tgt.name} ${del.status}`);
        routedFrom = i.id;
        say(`  broken: ${tgt.name}'s registry site removed, no route from ${i.name} to ${tgt.name}`);
        break;
      }
      if (routedFrom === null) say(`  broken: ${tgt.name}'s registry site removed (no cams route to ${tgt.name} to delete)`);

      const bounds = { transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'fit', maxBudgetS: 3600 };
      const r = await fetch(`${ADMIN}/api/v1/moves`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceProxyId: src.id, targetProxyId: tgt.id, cameraId: CAMS_ID, bounds }), signal: AbortSignal.timeout(15_000) });
      const body = (await r.json().catch(() => ({}))) as any;
      expect(r.status === 202, `POST /moves ${r.status} ${JSON.stringify(body).slice(0, 400)}`);
      const fixed = body.fixed as { rule: string; proxyId?: string; instanceId?: string; site?: string }[];
      expect(fixed.some((f) => f.rule === 'site_ca' && f.proxyId === tgt.id && f.site === tgt.name), `fixed has site_ca for ${tgt.name}: ${JSON.stringify(fixed)}`);
      if (routedFrom !== null) expect(fixed.some((f) => f.rule === 'routed' && f.instanceId === routedFrom && f.proxyId === tgt.id), `fixed has routed: ${JSON.stringify(fixed)}`);
      say(`  POST /moves: 202, command ${body.commandId}, fixed ${fixed.map((f) => f.rule).join(', ')}, precheck ok ${body.report.ok}`);
      // The registry and the route are back.
      const after = (await api('GET', `/accounts/${accountId}/proxies/${tgt.id}`)).body;
      expect(after.tlsSite === tgt.name, `registry: ${tgt.name} tlsSite ${after.tlsSite}`);
      if (routedFrom !== null) {
        const route = ((await api('GET', `/cams-instances/${routedFrom}/routes`)).body.items as any[]).find((x) => x.proxyId === tgt.id);
        expect(route && route.url === null && route.hidden === false, `route to ${tgt.name} is visible with url null: ${JSON.stringify(route)}`);
      }
      // The move of that command: the source's request id is in the move-begin audit row.
      const begin = await waitFor(async () => (await auditRows('move-begin')).find((a) => a.detail?.cmdId === body.commandId && a.outcome === 'ok' && a.detail?.requestId), 'the move-begin audit row with the request id', 60_000);
      const requestId = begin.detail.requestId as string;
      const m0 = await waitFor(async () => ((await api('GET', `/diag/moves?requestId=${requestId}`)).body.items as any[])[0], `the move of request ${requestId} in /diag/moves`, 60_000);
      expect(!before.has(m0.id), 'a new move');
      expect(m0.autoApprove === true && JSON.stringify(m0.bounds) === JSON.stringify(bounds), `/diag/moves: autoApprove ${m0.autoApprove}, bounds ${JSON.stringify(m0.bounds)}`);
      say(`  ${m0.id}: autoApprove ${m0.autoApprove}, bounds ${JSON.stringify(m0.bounds)} (never approved here: no call to ${src.name}'s /control/moves/:id/approve)`);
      const run: Run = { moveId: m0.id, budgetS: 60, estimateS: 0 };
      const m = await waitPhase(run, ['done'], 'done');
      expect(!m.cleanupPending && m.reason === null, `done cleanly (cleanupPending ${m.cleanupPending}, reason ${m.reason})`);
      const d = await move(run.moveId);
      say(`  done: ${m.bytesDone}/${m.bytesTotal} B, chunks ${JSON.stringify(d.chunks)}`);
      expect(d.chunks.failed === 0 && d.chunks.abandoned === 0 && d.chunks.pending === 0, `no chunk failed, abandoned or pending: ${JSON.stringify(d.chunks)}`);
      await assertOn(tgt, src, 'after the move', [run.moveId]);
      // cams-admin's audit: the fixes, the command, then the move.
      const rows = [...(await auditRows())].reverse().filter((a) =>
        (a.action === 'move-fix' && a.detail?.source === src.id && a.detail?.target === tgt.id) || (a.action === 'move-begin' && a.detail?.cmdId === body.commandId && a.outcome === 'ok') || a.detail?.moveId === run.moveId);
      const names = rows.map((a) => `${a.action}${a.detail?.rule ? `:${a.detail.rule}` : ''}${a.detail?.phase ? `:${a.detail.phase}` : ''}${a.outcome !== 'ok' ? `(${a.outcome})` : ''}`);
      say(`  cams-admin audit: ${names.join(' → ')}`);
      const at = (n: string) => names.indexOf(n);
      expect(at('move-fix:site_ca') >= 0 && (routedFrom === null || at('move-fix:routed') >= 0), `audit has the fixes (${names.join(', ')})`);
      expect(at('move-begin') > Math.max(at('move-fix:site_ca'), at('move-fix:routed')), `move-begin after the fixes (${names.join(', ')})`);
      expect(at('move-request:requested') > at('move-begin') && names.at(-1) === 'move-done:done', `move-request … move-done after move-begin (${names.join(', ')})`);
      // The source approved its own offer (cam-proxy's audit, NDJSON).
      const ar = await fetch(`http://127.0.0.1:${src.port}/control/audit?action=move-approve&limit=50`, { headers: { Authorization: `Bearer ${src.admin}` }, signal: AbortSignal.timeout(15_000) });
      expect(ar.status === 200, `${src.name}: GET /control/audit ${ar.status}`);
      const recs = (await ar.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // cam-proxy's ECS records keep their fields under cam_proxy.
      const appr = recs.find((x) => x.cam_proxy?.moveId === run.moveId);
      expect(appr && appr.cam_proxy.label === 'cams-admin auto-approval', `${src.name}: move-approve record with label "cams-admin auto-approval": ${JSON.stringify(appr?.cam_proxy ?? recs.map((x) => x.cam_proxy?.moveId)).slice(0, 400)}`);
      say(`  ${src.name} audit: move-approve by "${appr.cam_proxy.label}" (origin ${appr.cam_proxy.origin})`);
    } finally {
      const rv = await api('POST', `/ops-tokens/${tokenId}/revoke`);
      say(`  ops token revoked: ${rv.status}`);
    }
  }],
  ['beta-2 → beta-1, cancelled after the switch-over with stills captured on beta-1: copied back', async () => {
    // It starts where scenario 4 left the camera, on beta-2. A 4× budget: the paced copy runs long enough for the stills.
    const [from, to] = [pxs['beta-2'], pxs['beta-1']];
    const run = await startMove(from, to, 4);
    await waitPhase(run, ['copying', 'cleaning', 'done'], 'copying');
    expect((await phaseOf(run.moveId)) === 'copying', 'still copying when the stills come');
    const c = await camera();
    expect(c.proxyId === to.id, `registry: switched over to ${to.name}`);
    const switchAt = (await auditOfMoves([run.moveId])).find((a) => a.name === 'move-phase:copying')?.at;
    expect(switchAt, 'the move-phase:copying audit row (the switch-over)');
    // Stills of cam4 that the new proxy captured itself (named by their time, after the switch-over),
    // in the first whole minute after the switch-over's, and that minute over before the cancel: the
    // minutes of the switch-over and of the cancel are captured by both proxies (a pack per minute),
    // and such a minute stays where it is (the new proxy's cleanup keeps it, to age out there).
    const minute = Math.floor(switchAt! / MIN) * MIN + MIN;
    const captured = await waitFor(async () => {
      if (Date.now() < minute + MIN + 2000) return null;
      const st = await proxyApi(to, 'GET', `/api/cameras/${CAM}/stills?from=${minute}&to=${minute + MIN - 1}`, undefined, to.client);
      const mine = st.status === 200 ? (st.body as number[]).filter((t) => t > switchAt! && t >= minute && t < minute + MIN) : [];
      return mine.length >= 3 ? mine : null;
    }, `${to.name}: 3 stills of ${CAM} newer than the switch-over, in the minute from ${new Date(minute).toISOString()}`, 180_000, 1000);
    expect((await phaseOf(run.moveId)) === 'copying', 'still copying when the cancel comes (raise the seeded content if the copy is too quick)');
    say(`  ${to.name} captured ${captured.length} stills of ${CAM} since the switch-over (${new Date(captured[0]).toISOString()} …)`);
    const r = await api('POST', `/moves/${run.moveId}/cancel`, { confirm: 'cancel' });
    expect(r.status === 202 && r.body.phase === 'cancelling', `cancel: ${r.status} ${JSON.stringify(r.body)}`);
    say(`  cancelled in cams-admin while copying: ${r.body.phase}`);
    const m = await waitPhase(run, ['cancelled'], 'cancelled');
    say(`  ${m.phase}`);
    const ret = await waitReturn(run.moveId);
    expect(ret.check?.complete === true, `${ret.id}: check complete (${JSON.stringify(ret.check)})`);
    // The original serves what the new proxy captured; the new proxy has nothing of cam4 left.
    const back = await proxyApi(from, 'GET', `/api/cameras/${CAM}/stills?from=${captured[0]}&to=${captured.at(-1)}`, undefined, from.client);
    expect(back.status === 200 && captured.every((t) => (back.body as number[]).includes(t)), `${from.name} serves the ${captured.length} stills captured on ${to.name} (${back.status}, ${captured.filter((t) => !(back.body as number[]).includes?.(t)).length} missing)`);
    const one = await proxyApi(from, 'GET', `/api/cameras/${CAM}/stills/${captured[0]}.jpg`, undefined, from.client);
    expect(one.status === 200 && one.bytes > 1000, `${from.name}: GET still ${captured[0]} ${one.status} ${one.bytes} B`);
    say(`  ${from.name} serves the ${captured.length} stills captured on ${to.name} (one ${one.bytes} B)`);
    await assertOn(from, to, 'after the copy back', [run.moveId, ret.id]);
    const a = (await auditOfMoves([run.moveId, ret.id])).map((x) => x.name);
    say(`  cams-admin audit: ${a.join(' → ')}`);
    const at = (p: string, after = -1) => a.findIndex((n, i) => i > after && n.startsWith(p));
    const iCancel = at('move-cancel');
    const iReturn = at('move-return', iCancel);
    const iCheck = at('move-check', iReturn);
    const iReturned = at('move-return', iCheck);
    expect(iCancel >= 0 && iReturn > iCancel && iCheck > iReturn && iReturned > iCheck, `audit move-cancel … move-return … move-check … move-return (${a.join(', ')})`);
    expect(a[iReturned] === 'move-return:returned/returned', `the last move-return is returned (${a[iReturned]})`);
  }],
];

(async () => {
  await setup();
  let ok = 0;
  // The scenarios run in order: each starts where the one before left the camera.
  for (const [i, [name, fn]] of scenarios.entries()) {
    say(`scenario ${i + 1}: ${name}`);
    const t = Date.now();
    await fn();
    ok++;
    say(`scenario ${i + 1}: ok (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  console.log(`move-check: ${ok}/${scenarios.length} scenarios ok`);
})().catch((e) => {
  console.log(`move-check: FAIL ${e instanceof Fail ? e.message : (e as Error).stack}`);
  process.exit(1);
});
