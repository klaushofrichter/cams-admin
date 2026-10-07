// The P3 two-proxy check (plan Task 8) against the running local stack
// (start.sh with real admin-enroll): cams-admin's remote configuration
// against real cam-proxies and cam-sims. Never anything but 127.0.0.1.
// Prints one line per check, exits 1 on the first failure, 2 when the
// cam-proxy build has no P3 (config.get not implemented).
//   npx tsx scripts/localstack/p3-check.ts
// Changes only the local cam-sims and proxies; reads secrets from the run's
// files (mode 600) and never prints them.
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const WORK = (process.env.LOCALSTACK_DIR ?? join(process.env.TMPDIR ?? tmpdir(), 'cams-admin-localstack')).replace(/\/$/, '');
const RUN = join(WORK, 'run');
const ADMIN = 'http://localhost:29000';
const cookie = readFileSync(join(RUN, 'cams-admin/cookie'), 'utf8').trim();
const plan = JSON.parse(readFileSync(join(RUN, 'plan.json'), 'utf8')) as { accounts: { name: string; proxies: { name: string; port: number; cameras: { id: string; name: string; controlPort: number }[] }[] }[] };
const secret = (proxy: string, f: string) => readFileSync(join(RUN, proxy, 'secrets', f), 'utf8').trim();

interface Px { name: string; port: number; acc: string; id: string; base: string; admin: string; client: string; cameras: { id: string; name: string; controlPort: number }[] }
const pxs: Record<string, Px> = {};

class Fail extends Error {}
function expect(ok: unknown, what: string): void {
  if (!ok) throw new Fail(what);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Fail(`timeout: ${what}`);
    await sleep(500);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${ADMIN}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}
async function proxyApi(px: Px, method: string, path: string, body?: unknown, token = px.admin): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${px.port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  let j: any = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { text: t.slice(0, 200) }; }
  return { status: r.status, body: j };
}
const cfg = async (px: Px) => (await api('GET', `${px.base}/config`)).body;
const proxyCfg = async (px: Px) => (await proxyApi(px, 'GET', '/control/config')).body as Record<string, { value: unknown; source: string; by?: { cmdId: string } }>;
// start.sh allows tokens.apply(.admin) on every proxy (the P4 rehearsal); P3 entries come on top.
const BASE_ALLOW = ['tokens.apply', 'tokens.apply.admin'];
const allow = async (px: Px, p3: string[]) => {
  const entries = [...BASE_ALLOW, ...p3];
  const r = await proxyApi(px, 'PUT', '/control/admin/commands', { allow: entries });
  expect(r.status === 200, `${px.name}: PUT /control/admin/commands ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  // cams-admin learns it from the next heartbeat.
  await waitFor(async () => { const a = (await cfg(px)).allow as string[]; return entries.every((e) => a.includes(e)) && a.length === entries.length; }, `${px.name} reports allow ${entries.join(',')}`);
};
async function finalOf(px: Px, id: string) {
  return waitFor(async () => { const r = (await api('GET', `${px.base}/commands/${id}`)).body; return ['queued', 'sent', 'received'].includes(r.state) ? false : r; }, `command ${id} final`);
}
async function viewCurrent(px: Px) {
  await waitFor(async () => { const c = await cfg(px); return c.view && !c.changedOnProxy && !c.fetching ? c : false; }, `${px.name}: view current`, 90_000);
}
async function preview(px: Px, input: unknown) {
  await viewCurrent(px);
  const r = await api('POST', `${px.base}/config/preview`, input);
  expect(r.status === 202, `preview ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.commandId as string, row: await finalOf(px, r.body.commandId) };
}
async function applyPreview(px: Px, previewId: string) {
  const r = await api('POST', `${px.base}/config/apply`, { previewId });
  expect(r.status === 202, `apply ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.commandId as string, row: await finalOf(px, r.body.commandId) };
}
// GET /control/audit answers ECS JSON lines (newest first).
const proxyAudit = async (px: Px, action: string) => {
  const r = await fetch(`http://127.0.0.1:${px.port}/control/audit?action=${action}&limit=50`, { headers: { Authorization: `Bearer ${px.admin}` }, signal: AbortSignal.timeout(15_000) });
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)) as Record<string, any>[];
};
const adminAudit = async (action: string) => ((await api('GET', `/audit?action=${action}&limit=100`)).body.items ?? []) as Record<string, any>[];
const camSim = async (port: number, token: string) => {
  const r = await fetch(`http://127.0.0.1:${port}/sim/api/state`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  return (await r.json()) as { name: string; settings: Record<string, any> };
};
const health = (px: Px) => fetch(`http://127.0.0.1:${px.port}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
const connected = async (px: Px) => ((await api('GET', `/accounts/${px.acc}/proxies`)).body.items as any[]).find((p) => p.id === px.id)?.status?.connected === true;

const state: Record<string, string> = {};
const A = () => pxs['alpha-1'];
const B = () => pxs['beta-2'];

const checks: [string, () => Promise<void>][] = [
  ['both proxies are connected with commands on and no P3 entry allowed; Reload is refused', async () => {
    for (const px of [A(), B()]) {
      expect(await connected(px), `${px.name} connected`);
      const c = await cfg(px);
      expect(!c.allow.some((e: string) => !BASE_ALLOW.includes(e)), `${px.name}: no P3 entry allowed yet (${c.allow})`);
      expect((await api('POST', `${px.base}/config/refresh`, {})).status === 409, `${px.name}: refresh 409`);
    }
    const impl = (await proxyApi(A(), 'GET', '/control/admin/commands')).body.implemented as string[] | undefined;
    if (!impl?.includes('config.get')) { console.log('cam-proxy has no P3 (config.get not implemented)'); process.exit(2); }
  }],
  ['config.get allowed on both with their LOCAL admin tokens → the views arrive and equal the proxies\' own /control/config', async () => {
    for (const px of [A(), B()]) await allow(px, ['config.get']);
    for (const px of [A(), B()]) {
      await viewCurrent(px);
      const mine = (await cfg(px)).view.paths as Record<string, { v?: unknown; s: string }>;
      const theirs = await proxyCfg(px);
      let compared = 0;
      for (const [p, e] of Object.entries(theirs)) {
        if (!mine[p] || (typeof e.value === 'string' && e.value.length > 200)) continue;
        expect(JSON.stringify([mine[p].v, mine[p].s]) === JSON.stringify([e.value ?? undefined, e.source]), `${px.name} ${p}: cams-admin ${JSON.stringify(mine[p])} vs proxy ${JSON.stringify({ v: e.value, s: e.source })}`);
        compared++;
      }
      expect(compared > 20, `${px.name}: compared only ${compared} settings`);
      for (const p of Object.keys(mine)) expect(!/pem|key|password|passwd|secret|token|cookie/i.test(p), `${px.name}: secret-shaped path ${p} stored`);
    }
  }],
  ['config.set on alpha-1: preview, apply, visible on the proxy with the marker, audited on both sides with the same cmdId', async () => {
    await allow(A(), ['config.get', 'config.set', 'config.rollback']);
    const pv = await preview(A(), { set: { 'sse.pingS': 7 } });
    expect(pv.row.state === 'done' && pv.row.result.changes.length === 1 && pv.row.result.changes[0].path === 'sse.pingS' && pv.row.result.changes[0].to === 7, `dry run: ${JSON.stringify(pv.row.result)}`);
    expect((await proxyCfg(A()))['sse.pingS'].value !== 7, 'a dry run wrote nothing');
    const ap = await applyPreview(A(), pv.id);
    expect(ap.row.state === 'done', `apply: ${ap.row.state} ${ap.row.outcomeCode}`);
    const c = (await proxyCfg(A()))['sse.pingS'];
    expect(c.value === 7 && c.source === 'override' && c.by?.cmdId === ap.id, `on the proxy: ${JSON.stringify(c)}`);
    const from = pv.row.result.changes[0].from;
    const rec = (await proxyAudit(A(), 'config-change')).find((x) => x.cam_proxy?.cmdId === ap.id);
    expect(rec && rec.user?.name === 'cams-admin' && JSON.stringify(rec.cam_proxy.changes) === JSON.stringify([{ key: 'sse.pingS', from, to: 7 }]), `the proxy's config-change record: ${JSON.stringify(rec?.cam_proxy)}`);
    const res = (await adminAudit('command-result')).find((x) => x.detail?.cmdId === ap.id);
    expect(res && JSON.stringify(res.detail.changes) === JSON.stringify([{ path: 'sse.pingS', from, to: 7 }]), `cams-admin's command-result: ${JSON.stringify(res?.detail)}`);
    state.applied = ap.id;
  }],
  ['a local edit between preview and apply → preview_stale or conflict; the local value stays', async () => {
    const pv = await preview(A(), { set: { 'sse.pingS': 8 } });
    expect(pv.row.state === 'done', 'dry run done');
    const put = await proxyApi(A(), 'PUT', '/control/config', { sse: { pingS: 9 } });
    expect(put.status === 200, `local PUT ${put.status}`);
    const r = await api('POST', `${A().base}/config/apply`, { previewId: pv.id });
    if (r.status === 202) {
      const f = await finalOf(A(), r.body.commandId);
      expect(f.state === 'failed' && f.outcomeCode === 'conflict', `apply after a local edit: ${f.state} ${f.outcomeCode}`);
    } else expect(r.body.error === 'preview_stale', `apply: ${r.status} ${JSON.stringify(r.body)}`);
    expect((await proxyCfg(A()))['sse.pingS'].value === 9, 'the local value stays');
  }],
  ['rollback of the first change: changed locally since → conflict naming sse.pingS; set back to 7 locally, rollback works; again → already_rolled_back', async () => {
    // The proxy's shared settings window (contract step 9: 6 a minute, dry runs count) is full after the checks above.
    await sleep(61_000);
    await viewCurrent(A());
    const rp = await api('POST', `${A().base}/config/rollback/preview`, { cmdId: state.applied });
    expect(rp.status === 202, `rollback preview ${rp.status} ${JSON.stringify(rp.body)}`);
    const f = await finalOf(A(), rp.body.commandId);
    expect(f.outcomeCode === 'conflict' && f.result?.current?.['sse.pingS'], `rollback dry run: ${f.state} ${f.outcomeCode} ${JSON.stringify(f.result)}`);
    expect((await proxyApi(A(), 'PUT', '/control/config', { sse: { pingS: 7 } })).status === 200, 'local PUT 7');
    await viewCurrent(A());
    const rp2 = await api('POST', `${A().base}/config/rollback/preview`, { cmdId: state.applied });
    const f2 = await finalOf(A(), rp2.body.commandId);
    expect(f2.state === 'done', `rollback dry run 2: ${f2.state} ${f2.outcomeCode} ${JSON.stringify(f2.result)}`);
    const ra = await api('POST', `${A().base}/config/rollback/apply`, { previewId: rp2.body.commandId });
    const f3 = await finalOf(A(), ra.body.commandId);
    expect(f3.state === 'done', `rollback: ${f3.state} ${f3.outcomeCode}`);
    expect((await proxyCfg(A()))['sse.pingS'].source !== 'override', `after rollback: ${JSON.stringify((await proxyCfg(A()))['sse.pingS'])}`);
    await viewCurrent(A());
    const rp3 = await api('POST', `${A().base}/config/rollback/preview`, { cmdId: state.applied });
    const f4 = await finalOf(A(), rp3.body.commandId);
    expect(f4.outcomeCode === 'already_rolled_back', `rollback again: ${f4.state} ${f4.outcomeCode}`);
  }],
  ['denied and local-only paths are refused by cams-admin before any command (400 not_remote_settable)', async () => {
    for (const set of [{ 'cameras.cam1.host': '192.0.2.9' }, { 'ftp.enabled': true }, { 'storage.maxPercent': 10 }, { 'health.diskPercent': 99 }]) {
      const r = await api('POST', `${A().base}/config/preview`, { set });
      expect(r.status === 400 && r.body.error === 'not_remote_settable', `${JSON.stringify(set)}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const r = await api('POST', `${A().base}/config/preview`, { set: { 'retention.clipsDays': 1 } });
    expect(r.status === 400 && r.body.error === 'widening_local_only', `retention lowered: ${r.status} ${JSON.stringify(r.body)}`);
  }],
  ['beta-2 (three cameras) refuses config.set (not allowed there): 409 not_allowed_on_proxy', async () => {
    await viewCurrent(B());
    const r = await api('POST', `${B().base}/config/preview`, { set: { 'sse.pingS': 7 } });
    expect(r.status === 409 && r.body.error === 'not_allowed_on_proxy', `${r.status} ${JSON.stringify(r.body)}`);
  }],
  ['camera round trip on beta-2 against cam-sim: camera.name.set verified and read back from the cam-sim; set back', async () => {
    await allow(B(), ['config.get', 'camera.name.set', 'camera.action:camera-ntp-set', 'proxy.restart']);
    const cam = B().cameras[1];
    const tok = secret('beta-2', 'camsim_control_token');
    const original = (await camSim(cam.controlPort, tok)).name;
    const r = await api('POST', `${B().base}/cameras/${cam.id}/name`, { name: 'p3 check' });
    expect(r.status === 202, `rename ${r.status} ${JSON.stringify(r.body)}`);
    const f = await finalOf(B(), r.body.commandId);
    expect(f.state === 'done' && f.result?.verified === true && f.result?.name === 'p3 check', `rename: ${f.state} ${f.outcomeCode} ${JSON.stringify(f.result)}`);
    expect((await camSim(cam.controlPort, tok)).name === 'p3 check', 'the cam-sim has the new name');
    const back = await api('POST', `${B().base}/cameras/${cam.id}/name`, { name: original });
    expect((await finalOf(B(), back.body.commandId)).state === 'done', 'renamed back');
    expect((await camSim(cam.controlPort, tok)).name === original, 'the cam-sim has its name back');
  }],
  ['camera-ntp-set on beta-2 (disruptive: typed confirmation) → verified; the cam-sim\'s NTP server is 192.0.2.123', async () => {
    const cam = B().cameras[0];
    const no = await api('POST', `${B().base}/actions`, { camera: cam.id, action: 'camera-ntp-set' });
    expect(no.status === 400 && no.body.error === 'confirm_required', `without confirm: ${no.status} ${JSON.stringify(no.body)}`);
    const r = await api('POST', `${B().base}/actions`, { camera: cam.id, action: 'camera-ntp-set', confirm: 'camera-ntp-set' });
    expect(r.status === 202, `ntp ${r.status} ${JSON.stringify(r.body)}`);
    const f = await finalOf(B(), r.body.commandId);
    expect(f.state === 'done' && f.result?.verified === true, `ntp: ${f.state} ${f.outcomeCode} ${JSON.stringify(f.result).slice(0, 300)}`);
    const ntp = (await camSim(cam.controlPort, secret('beta-2', 'camsim_control_token'))).settings?.Ntp;
    expect(JSON.stringify(ntp ?? {}).includes('192.0.2.123'), `cam-sim Ntp: ${JSON.stringify(ntp)}`);
  }],
  ['proxy.restart on beta-2: refused without confirm; with it → done before the process exits; the supervisor starts it again; a third restart within the window is refused', async () => {
    const no = await api('POST', `${B().base}/restart`, {});
    expect(no.status === 400 && no.body.error === 'confirm_required', `without confirm: ${no.status}`);
    for (let i = 1; i <= 2; i++) {
      const r = await api('POST', `${B().base}/restart`, { confirm: 'proxy.restart' });
      expect(r.status === 202, `restart ${i}: ${r.status} ${JSON.stringify(r.body)}`);
      const f = await finalOf(B(), r.body.commandId);
      expect(f.state === 'done' && typeof f.result?.restartAt === 'number', `restart ${i}: ${f.state} ${f.outcomeCode}`);
      await waitFor(async () => !(await health(B())) || !(await connected(B())), `beta-2 goes away (${i})`, 30_000);
      await waitFor(() => health(B()), `beta-2 /health again (${i})`, 90_000);
      await waitFor(() => connected(B()), `beta-2 reconnects (${i})`, 90_000);
    }
    // ntp-set + 2 restarts = 3 disruptive in 10 min: cams-admin's fleet limit fires before the proxy's journal budget (2 restarts an hour).
    const third = await api('POST', `${B().base}/restart`, { confirm: 'proxy.restart' });
    expect((third.status === 429 && third.body.error === 'fleet_limit') || third.status === 202, `third restart: ${third.status} ${JSON.stringify(third.body)}`);
    if (third.status === 202) {
      const f = await finalOf(B(), third.body.commandId);
      expect(f.state === 'refused' && f.outcomeCode === 'rate_limited' && f.retryAfterS > 0, `third restart on the proxy: ${f.state} ${f.outcomeCode}`);
    }
  }],
  ['pause on alpha-1 (local) → preview 409 paused_on_proxy; resume (local)', async () => {
    await viewCurrent(A());
    expect((await proxyApi(A(), 'POST', '/control/admin/commands/pause', { reason: 'p3 check' })).status === 200, 'pause');
    // Wait for the heartbeat that reports the pause, then one preview (no command spam while waiting).
    const policy = async () => (await api('GET', `/accounts/${A().acc}/proxies`)).body.items.find((p: any) => p.id === A().id)?.status?.commands;
    await waitFor(async () => (await policy()) === 'paused', 'cams-admin shows paused', 120_000);
    const pr = await api('POST', `${A().base}/config/preview`, { set: { 'sse.pingS': 11 } });
    expect(pr.status === 409 && pr.body.error === 'paused_on_proxy', `preview while paused: ${pr.status} ${JSON.stringify(pr.body)}`);
    const res = await proxyApi(A(), 'POST', '/control/admin/commands/resume', {});
    expect(res.status === 200 && res.body.paused === false, `resume: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    const t = Date.now();
    await waitFor(async () => (await policy()) === 'allowed', 'cams-admin shows resumed', 180_000);
    console.log(`     (cams-admin saw the resume after ${((Date.now() - t) / 1000).toFixed(0)} s)`);
  }],
  ['the client tokens (CAMPROXY_TOKENS) still work on both proxies', async () => {
    for (const px of [A(), B()]) {
      const r = await proxyApi(px, 'GET', '/api/cameras', undefined, px.client);
      expect(r.status === 200 && Array.isArray(r.body) && r.body.length === px.cameras.length, `${px.name} /api/cameras: ${r.status}`);
    }
  }],
];

(async () => {
  const accounts = (await api('GET', '/accounts')).body.items as { id: string; name: string }[];
  for (const a of plan.accounts) for (const p of a.proxies) {
    if (!['alpha-1', 'beta-2'].includes(p.name)) continue;
    const acc = accounts.find((x) => x.name === a.name)!;
    const id = ((await api('GET', `/accounts/${acc.id}/proxies`)).body.items as any[]).find((x) => x.name === p.name).id as string;
    pxs[p.name] = { name: p.name, port: p.port, acc: acc.id, id, base: `/accounts/${acc.id}/proxies/${id}`, admin: secret(p.name, 'proxy_admin_token'), client: secret(p.name, 'proxy_tokens').split(/[\s,]+/)[0], cameras: p.cameras };
  }
  const t0 = Date.now();
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  for (const [name, fn] of checks.filter(([n]) => !only || n.includes(only))) {
    const t = Date.now();
    try {
      await fn();
      console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      console.log(`FAIL ${name}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  console.log(`all ${only ? "selected" : checks.length} checks ok in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch((e) => {
  console.error(`p3-check: ${(e as Error).message}`);
  process.exit(1);
});
