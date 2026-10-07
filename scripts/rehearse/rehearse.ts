// The cams-admin half of the cut-over rehearsal (runbook §R, M §11.3) on the
// local stack (scripts/localstack/start.sh), with the reference cams client
// standing in for cams until cams's own client is on main:
//   1. P2 steps 1–2: managed client + admin tokens for both proxies of the
//      account (the "cluster cams"), a client token on the first proxy for
//      the "Pi cams"; active through tokens.apply.
//   2. two real-shaped exports (export-config: no password, token hashes),
//      localized with localize.ts onto the local proxies.
//   3. instances rh-cluster and rh-pi, enrolled by the reference client.
//   4. import the cluster file: dry run, apply, apply again = no changes;
//      the Pi file with hideUnlisted: a route and a hidden proxy, again no changes.
//   5. both instances pull (200, then 304), verify the snapshot signatures;
//      the Pi's snapshot has only its proxy, at its loopback URL.
//   6. shadow: the file and the snapshot compared field by field (the trust
//      fields of cams-v1), reported; 0 differences, "zero since" shown.
//   7. tokens: rh-cluster registers its own client + admin hashes for every
//      proxy (active), Rotate now → new ones active, old ones retiring.
//   8. the cached snapshot verifies with cams-admin unreachable (offline start).
//   9. rollback: blocking rh-pi revokes its tokens; its next pull is 403 revoked.
// Prints PASS/FAIL per step and writes result.json to --work. Never prints a
// token; the exports and the result stay in the work dir (outside git).
//   npx tsx scripts/rehearse/rehearse.ts --url http://localhost:29000 --session-file F --account beta --work DIR
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { CamsTestClient, enrollCams, verifySnapshot, type CamsSnapshot } from '../../test-client/cams';
import { localize } from './localize';

const args = process.argv.slice(2);
const opt = (n: string, def?: string) => {
  const i = args.indexOf(`--${n}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  if (def !== undefined) return def;
  throw new Error(`--${n} is required`);
};
const url = opt('url').replace(/\/+$/, '');
const cookie = readFileSync(opt('session-file'), 'utf8').trim();
const work = opt('work');
const accountName = opt('account', 'beta');
mkdirSync(work, { recursive: true, mode: 0o700 });

const steps: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail = '') => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${step}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
    await sleep(500);
  }
}
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${j.error ?? ''}${j.field ? ` (${j.field})` : ''}`);
  return j;
}
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function main() {
  const run = randomBytes(2).toString('hex');
  const account = ((await api('GET', '/accounts')).items as any[]).find((a) => a.name === accountName) ?? (() => { throw new Error(`no account ${accountName}`); })();
  const proxies = ((await api('GET', `/accounts/${account.id}/proxies`)).items as any[]).sort((a, b) => a.name.localeCompare(b.name));
  const cameras = (await api('GET', `/accounts/${account.id}/cameras`)).items as any[];
  if (proxies.length < 2) throw new Error(`account ${accountName} needs two proxies`);
  const [first, second] = proxies;

  // 1. Managed P2 tokens (the hash is all this script keeps).
  const issue = async (px: any, kind: 'client' | 'admin', label: string) => {
    const t = await api('POST', `/accounts/${account.id}/proxies/${px.id}/tokens`, { kind, label });
    const hash = sha(t.token);
    await until(`${label} active`, async () => ((await api('GET', `/accounts/${account.id}/proxies/${px.id}/tokens`)).items as any[]).some((x) => x.id === t.tokenId && x.state === 'active'));
    return hash;
  };
  const p2: Record<string, { client: string; admin: string }> = {};
  for (const px of [first, second]) p2[px.id] = { client: await issue(px, 'client', `cams cluster ${run}`), admin: await issue(px, 'admin', `cams cluster admin ${run}`) };
  const piHash = await issue(first, 'client', `cams pi ${run}`);
  record('1 P2 managed tokens active (cut-over steps 1–2)', true, `${proxies.length} proxies`);

  // 2. Real-shaped exports, then localized.
  const realUrl = (px: any) => `https://${px.name}.proxy.example.net:8480`;
  const camOf = (px: any) => cameras.filter((c) => c.proxyId === px.id);
  const exportOf = (entries: { px: any; url: string; token: string; admin?: string }[]) => ({
    v: 1, kind: 'cams-export', exportedAt: Date.now(), camsVersion: 'rehearsal', source: 'cameras-file',
    cameras: entries.flatMap((e) => camOf(e.px).map((c) => ({
      id: c.camsId, name: c.name, host: c.host ?? 'from-proxy', protocol: c.protocol ?? 'https', user: c.cameraUser ?? 'cams', webUiNote: 'rehearsal',
      proxy: { url: e.url, token: { sha256: e.token }, ...(e.admin ? { adminToken: { sha256: e.admin } } : {}), camera: c.proxyCameraId ?? c.camsId },
    }))),
    counts: { preferencesUsers: 1, proxySwitchOff: 0, tlsCas: 0, tlsPins: 0 },
  });
  const realCluster = exportOf([first, second].map((px) => ({ px, url: realUrl(px), token: p2[px.id].client, admin: p2[px.id].admin })));
  const realPi = exportOf([{ px: first, url: 'http://127.0.0.1:8480', token: piHash }]);
  const map = { proxies: { [realUrl(first)]: { url: first.url }, [realUrl(second)]: { url: second.url }, 'http://127.0.0.1:8480': { url: first.url.replace('127.0.0.1', 'localhost') } } };
  for (const [n, v] of [['export-cluster.json', realCluster], ['export-pi.json', realPi], ['map.json', map]] as const) writeFileSync(join(work, n), JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  const cluster = localize(realCluster, map);
  const pi = localize(realPi, map);
  writeFileSync(join(work, 'local-cluster.json'), JSON.stringify(cluster, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(work, 'local-pi.json'), JSON.stringify(pi, null, 2) + '\n', { mode: 0o600 });
  record('2 exports written and localized', !JSON.stringify([cluster, pi]).includes('"password"'), `${cluster.cameras.length} + ${pi.cameras.length} cameras`);

  // 3. Instances, enrolled.
  const mk = async (name: string) => {
    const i = await api('POST', '/cams-instances', { name, displayName: name, accounts: [account.id] });
    const k = await enrollCams(url, (await api('POST', `/cams-instances/${i.id}/enrollment-codes`, { lifetimeH: 1 })).code, 'rehearsal');
    writeFileSync(join(work, `${name}.key.json`), JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
    return { i, k, c: new CamsTestClient({ url, instanceId: k.instanceId, keyId: k.keyId, privateKey: k.privateKey, serverKeys: k.serverKeys }) };
  };
  const rc = await mk(`rh-cluster-${run}`);
  const rp = await mk(`rh-pi-${run}`);
  record('3 instances enrolled (fingerprints match the keys)', rc.k.serverKeyFingerprints.length === 1 && rp.k.serverKeyFingerprints[0] === rc.k.serverKeyFingerprints[0]);

  // 4. Imports.
  const imp = (inst: any, file: unknown, o: object = {}) => api('POST', `/accounts/${account.id}/import`, { instanceId: inst.id, file, ...o });
  const dry = await imp(rc.i, cluster);
  const byToken = dry.changes.filter((c: any) => c.kind === 'proxy-matched' && c.by === 'token').length;
  record('4a cluster dry run: proxies matched by token, no mismatch', byToken === 2 && dry.mismatches.length === 0 && !dry.applied, `${dry.changes.length} changes`);
  const applied = await imp(rc.i, cluster, { apply: true });
  record('4b cluster apply', applied.applied === true || applied.noChanges === true);
  record('4c cluster again: no changes', (await imp(rc.i, cluster, { apply: true })).noChanges === true);
  const piDry = await imp(rp.i, pi, { hideUnlisted: true });
  const routeAdd = piDry.changes.find((c: any) => c.kind === 'route-add');
  const hidden = piDry.changes.find((c: any) => c.kind === 'route-hide');
  record('4d Pi dry run: a loopback route and the other proxy hidden', !!routeAdd && routeAdd.proxyId === first.id && !!hidden && hidden.proxyId === second.id && piDry.mismatches.length === 0);
  await imp(rp.i, pi, { hideUnlisted: true, apply: true });
  record('4e Pi again: no changes; the registered URL unchanged', (await imp(rp.i, pi, { hideUnlisted: true, apply: true })).noChanges === true
    && (await api('GET', `/accounts/${account.id}/proxies/${first.id}`)).url === first.url);

  // 5. Pulls.
  const pull = async (c: CamsTestClient) => {
    const a = await c.get('/cams/v1/config');
    const b = await c.get('/cams/v1/config', { 'If-None-Match': a.headers.get('etag')! });
    return { a, b, snap: a.json as CamsSnapshot };
  };
  const pc = await pull(rc.c);
  const pp = await pull(rp.c);
  const piProxies = pp.snap.accounts[0].proxies;
  record('5 pulls: 200 then 304, signatures verified; the Pi sees only its proxy at the loopback URL',
    pc.a.status === 200 && pc.b.status === 304 && pp.b.status === 304 && verifySnapshot(pc.snap, rc.k.serverKeys) && verifySnapshot(pp.snap, rp.k.serverKeys)
    && piProxies.length === 1 && piProxies[0].id === first.id && piProxies[0].url === first.url.replace('127.0.0.1', 'localhost'));

  // 6. Shadow: the file against the snapshot (cams-v1 trust fields + the camera's proxy).
  const shadow = (file: any, snap: CamsSnapshot) => {
    const acc = snap.accounts.find((a) => a.id === account.id)!;
    const items: string[] = [];
    for (const f of file.cameras) {
      const c = acc.cameras.find((x: any) => x.camsId === f.id) as any;
      if (!c) { items.push(`${f.id}: missing`); continue; }
      const px = acc.proxies.find((p) => p.id === c.proxyId);
      if ((px?.url ?? null) !== f.proxy.url) items.push(`${f.id}: proxyUrl`);
      if (c.host !== f.host) items.push(`${f.id}: host`);
      if ((c.protocol ?? 'https') !== f.protocol) items.push(`${f.id}: protocol`);
      if ((c.tlsServername ?? undefined) !== f.tlsServername) items.push(`${f.id}: tlsServername`);
      if ((c.proxyCameraId ?? c.camsId) !== (f.proxy.camera ?? f.id)) items.push(`${f.id}: camera`);
    }
    return items;
  };
  const report = (c: CamsTestClient, snap: CamsSnapshot, items: string[]) => c.post('/cams/v1/report', {
    v: 1, mode: 'shadow', version: 'rehearsal', appliedRevision: snap.revision, cacheVerifiedAt: Date.now(), lastPullAt: Date.now(), held: [], keptOld: [],
    shadow: { accountId: account.id, differences: items.length, items: items.slice(0, 20) }, tokens: { managed: 0, pending: 0, legacy: 2 }, problems: [],
  });
  const dc = shadow(cluster, pc.snap), dp = shadow(pi, pp.snap);
  const r1 = await report(rc.c, pc.snap, dc);
  const r2 = await report(rp.c, pp.snap, dp);
  const dash = (await api('GET', '/dashboard')).cams as any[];
  const zero = (i: any) => dash.find((x) => x.id === i.id)?.shadowZeroSince;
  record('6 shadow: 0 differences for both, reported current, "zero since" set', dc.length === 0 && dp.length === 0 && r1.json.changed === false && r2.json.changed === false && !!zero(rc.i) && !!zero(rp.i),
    [...dc, ...dp].join('; '));

  // 7. cams-held tokens, then Rotate now.
  const held = async (c: CamsTestClient) => {
    const ids: string[] = [];
    for (const px of [first, second]) for (const kind of ['client', 'admin'] as const) {
      const r = await c.post('/cams/v1/tokens', { v: 1, proxyId: px.id, kind, hash: `sha256:${sha(randomBytes(32).toString('base64url'))}` });
      if (r.status !== 201) throw new Error(`register ${kind} on ${px.name}: ${r.status} ${r.json?.error}`);
      ids.push(r.json.tokenId);
    }
    return ids;
  };
  const states = async (c: CamsTestClient) => Object.fromEntries((await c.snapshot()).accounts.flatMap((a) => a.proxies.flatMap((p) => p.tokens.map((t) => [t.id, t.state]))));
  const old = await held(rc.c);
  await until('cams tokens active', async () => { const s = await states(rc.c); return old.every((id) => s[id] === 'active'); });
  await api('POST', `/cams-instances/${rc.i.id}/rotate`, {});
  const rot = await rc.c.snapshot();
  const fresh = await held(rc.c);
  for (const id of old) {
    const r = await rc.c.post(`/cams/v1/tokens/${id}/retire`, { v: 1, hours: 24 });
    if (r.status !== 200) throw new Error(`retire: ${r.status} ${r.json?.error}`);
  }
  await until('rotated tokens active', async () => { const s = await states(rc.c); return fresh.every((id) => s[id] === 'active'); });
  const after = await states(rc.c);
  record('7 tokens: registered → active; Rotate now → new active, old retiring', rot.instance.rotateBefore !== null && old.every((id) => after[id] === 'retiring'), `${old.length} + ${fresh.length} tokens`);

  // 8. Offline start: the cached copy verifies with the pinned key alone.
  writeFileSync(join(work, 'cache-cluster.json'), JSON.stringify(rot) + '\n', { mode: 0o600 });
  const cached = JSON.parse(readFileSync(join(work, 'cache-cluster.json'), 'utf8'));
  const tampered = { ...cached, accounts: [] };
  record('8 offline: the cached snapshot verifies without cams-admin; a changed copy does not', verifySnapshot(cached, rc.k.serverKeys) && !verifySnapshot(tampered, rc.k.serverKeys));

  // 9. Rollback on the cams-admin side: block the Pi instance.
  const piTok = await rp.c.post('/cams/v1/tokens', { v: 1, proxyId: first.id, kind: 'client', hash: `sha256:${sha(randomBytes(32).toString('base64url'))}` });
  await api('POST', `/cams-instances/${rp.i.id}/block`, {});
  const blocked = await rp.c.get('/cams/v1/config');
  const tokState = ((await api('GET', `/accounts/${account.id}/proxies/${first.id}/tokens`)).items as any[]).find((t) => t.id === piTok.json.tokenId)?.state;
  record('9 block: next pull 403 revoked (signed), its tokens revoked', blocked.status === 403 && blocked.json.error === 'revoked' && tokState === 'revoked');
}

main()
  .then(() => {
    writeFileSync(join(work, 'result.json'), JSON.stringify({ at: new Date().toISOString(), url, account: accountName, ok: true, steps }, null, 2) + '\n', { mode: 0o600 });
    console.log(`rehearsal: PASS (${steps.length} steps), result in ${join(work, 'result.json')}`);
  })
  .catch((e) => {
    writeFileSync(join(work, 'result.json'), JSON.stringify({ at: new Date().toISOString(), url, account: accountName, ok: false, error: (e as Error).message, steps }, null, 2) + '\n', { mode: 0o600 });
    console.error(`rehearsal: FAIL: ${(e as Error).message}`);
    process.exit(1);
  });
