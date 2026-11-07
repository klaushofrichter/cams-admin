import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { camsResponseText, fingerprint, generateKeyPair, publicFromB64, verify } from '../server/crypto/ed25519';
import { MoveStore } from '../server/moves/store';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { tmpDir } from './helpers/tmp';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch, type CamsKeyT } from './helpers/cams';
import { strictCamsErrors, strictCamsValidator } from './helpers/contract';

// The answer may name the fleet of the asked account only, without anything secret.
const FINGERPRINT = 'ab'.repeat(32);
const HASH = 'sha256:' + '7'.repeat(64);
const REPORT = (held: unknown[], heldProxies: unknown[] = [], keptOld: unknown[] = []) => ({
  v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held, keptOld, heldProxies, shadow: null,
  tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [{ code: 'MARKER-REPORT-PROBLEM', detail: 'MARKER-REPORT-DETAIL' }],
});

describe('GET /cams/v1/accounts/:id/fleet', () => {
  const dir = tmpDir();
  let s: Running;
  let home: any, beta: any, pi: any, spare: any, hidden: any, betaPx: any, both: any, onlyHome: any, onlyBeta: any, cam1: any;
  let bothKey: CamsKeyT, homeKey: CamsKeyT, betaKey: CamsKeyT;
  let switchReadAt = 0;
  const fleetPath = (id: string) => `/cams/v1/accounts/${id}/fleet`;
  const get = (key: CamsKeyT, id: string) => signedFetch(s, key, 'GET', fleetPath(id));
  const fleet = async (key: CamsKeyT, id: string) => {
    const r = await get(key, id);
    expect(r.status).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    s = await startServer(dir);
    home = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home-Account-Marker' });
    beta = await s.api('POST', '/accounts', { name: 'beta-marker', displayName: 'Beta-Account-Marker' });
    await s.api('POST', `/accounts/${home.id}/users`, { email: 'owner@example.org', role: 'admin' });
    await s.api('POST', `/accounts/${beta.id}/users`, { email: 'beta-owner@example.org', role: 'admin' });
    pi = await s.api('POST', `/accounts/${home.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480', adminUiUrl: 'http://10.20.30.40:8480', caFingerprints: [FINGERPRINT] });
    spare = await s.api('POST', `/accounts/${home.id}/proxies`, { name: 'spare', displayName: 'Spare', runsOn: 'cloud', url: 'https://spare.example.net' });
    hidden = await s.api('POST', `/accounts/${home.id}/proxies`, { name: 'hidden-marker', displayName: 'Hidden', runsOn: 'cloud', url: 'https://hidden-marker.example.net' });
    betaPx = await s.api('POST', `/accounts/${beta.id}/proxies`, { name: 'beta-proxy-marker', displayName: 'Beta-Proxy-Marker', runsOn: 'cloud', url: 'https://beta-proxy-marker.example.net' });
    cam1 = await s.api('POST', `/accounts/${home.id}/cameras`, { camsId: 'cam1', name: 'Yard', kind: 'camera', proxyId: pi.id, proxyCameraId: 'pcam1', host: 'from-proxy', protocol: 'https', cameraUser: 'cams' });
    await s.api('POST', `/accounts/${home.id}/cameras`, { camsId: 'cam2', name: 'Drive', kind: 'camera', proxyId: hidden.id, proxyCameraId: 'cam2' });
    await s.api('POST', `/accounts/${beta.id}/cameras`, { camsId: 'cam1', name: 'Beta-Camera-Marker', kind: 'camera', proxyId: betaPx.id, proxyCameraId: 'cam1' });
    both = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', baseUrl: 'https://cams.example.net', notes: 'NOTES-MARKER', accounts: [home.id, beta.id] });
    onlyHome = await s.api('POST', '/cams-instances', { name: 'lanviewer', displayName: 'LAN viewer', baseUrl: 'http://10.20.30.41:8080', accounts: [home.id] });
    onlyBeta = await s.api('POST', '/cams-instances', { name: 'beta-viewer-marker', displayName: 'Beta-Viewer-Marker', accounts: [beta.id] });
    await s.api('POST', '/cams-instances', { name: 'pending-marker', displayName: 'Not enrolled', accounts: [home.id] });
    for (const px of [pi, spare, betaPx]) await s.api('PUT', `/cams-instances/${both.id}/routes/${px.id}`, { url: null, hidden: false });
    await s.api('PUT', `/cams-instances/${both.id}/routes/${hidden.id}`, { url: null, hidden: true });
    bothKey = await enrollCamsKey(s, both.id);
    homeKey = await enrollCamsKey(s, onlyHome.id);
    betaKey = await enrollCamsKey(s, onlyBeta.id);
    for (const k of [bothKey, homeKey, betaKey]) await signedFetch(s, k, 'GET', '/cams/v1/ping');
    const now = Date.now();
    // An enrolled proxy with an active key that says hello.
    s.built.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(pi.id);
    const k = generateKeyPair();
    s.built.db.prepare('INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?,?,?,?,?,?)').run('pk-fleet', pi.id, k.publicKeySpkiB64, fingerprint(k.publicKeySpkiB64), now, now);
    s.built.status.hello(pi.id, '2026.11.01.1', now, ['status']);
    const summary = makeSummary({ cameras: 1, now }) as any;
    summary.ok = false;
    summary.problemCount = 2;
    summary.items.push({ id: 'disk', label: 'Disk', text: '91% full', problem: true }, { id: 'fine', label: 'Fine', text: 'NOT-A-PROBLEM-MARKER', problem: false });
    summary.cameras[0].camera.id = 'pcam1';
    summary.cameras[0].items = [{ id: 'stream', label: 'Stream', text: 'no stream', problem: true }];
    s.built.status.heartbeat(pi.id, { summary, proxy: makeProxyInfo({ now }), truncated: false }, now);
    const store = new MoveStore(s.built.db, s.built.clock);
    store.create({ accountId: home.id, cameraId: cam1.id, sourceProxyId: pi.id, targetProxyId: spare.id, requestId: 'rq-marker', tokenHash: HASH, targetIp: '198.51.100.77', actor: 'actor-marker@example.org', detail: 'DETAIL-MARKER' });
    // A PoE switch operated by pi, and what powers cam1 (switch_list / camera_power in the cams MCP).
    const sw = await s.api('POST', `/accounts/${home.id}/switches`, { name: 'GPS-208', host: '192.168.1.217', proxyId: pi.id });
    s.built.switches.store.updateSwitch('admin@example.org', home.id, sw.id, { state: 'active', sn: 'SN-MARKER-1', firmware: 'FW-MARKER', readAt: now });
    s.built.switches.store.setPower(cam1.id, { kind: 'poe', switchId: sw.id, port: 3, watts: 4.2, verifiedAt: now }, 'admin@example.org', 'sysadmin', 'test');
    switchReadAt = now;
    await signedFetch(s, bothKey, 'POST', '/cams/v1/report', REPORT(
      [{ accountId: home.id, camsId: 'cam1', fields: ['host'] }, { accountId: beta.id, camsId: 'bcam', fields: ['protocol'] }],
      [{ accountId: home.id, proxyId: spare.id, fields: ['proxyUrl'] }, { accountId: beta.id, proxyId: betaPx.id, fields: ['caFingerprints'] }],
      [{ accountId: home.id, camsId: 'cam2', fields: ['tlsServername'] }, { accountId: beta.id, camsId: 'bcam2', fields: ['tlsServername'] }],
    ));
  });
  afterAll(() => s.stop());

  it('answers signed, no-store and in the contract', async () => {
    const r = await get(bothKey, home.id);
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.clone().arrayBuffer());
    expect(verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(200, r.nonce, bytes), r.headers.get('x-cams-admin-sig'))).toBe(true);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(strictCamsValidator('fleet-response')(body), strictCamsErrors()).toBe(true);
    expect(body).toMatchObject({ v: 1, type: 'cams-fleet', accountId: home.id });
  });

  it('list_proxies data: state, version, problems, the GUI address with its note; only routed proxies', async () => {
    const b = await fleet(bothKey, home.id);
    expect(b.proxies.map((p: any) => p.name)).toEqual(['pi', 'spare']);
    expect(b.notRouted).toBe(1);
    const p = b.proxies[0];
    expect(p).toMatchObject({ displayName: 'Pi', state: 'online', ok: false, problemCount: 2, gui: { url: 'http://10.20.30.40:8480/', scope: 'private', note: 'Local network address: only reachable from inside that network.' } });
    expect(typeof p.version).toBe('string');
    expect(p.problems).toEqual(expect.arrayContaining([{ id: 'disk', label: 'Disk', text: '91% full', camera: null }, { id: 'stream', label: 'Stream', text: 'no stream', camera: 'cam1' }]));
    expect(JSON.stringify(p.problems)).not.toContain('NOT-A-PROBLEM-MARKER');
    expect(p.cameras).toEqual([{ id: 'cam1', name: 'Yard', online: expect.any(Boolean) }]);
    expect(b.proxies[1].gui).toEqual({ url: 'https://spare.example.net/', scope: 'public', note: null });
  });

  it('list_viewers data: enrolled viewers of this account, held changes of this account only', async () => {
    const b = await fleet(bothKey, home.id);
    expect(b.viewers.map((v: any) => v.name).sort()).toEqual(['cluster', 'lanviewer']);
    const cluster = b.viewers.find((v: any) => v.name === 'cluster');
    expect(cluster).toEqual({
      name: 'cluster', displayName: 'Cluster', thisViewer: true, address: { url: 'https://cams.example.net/', scope: 'public', note: null },
      held: [{ camera: 'cam1', fields: ['host'] }], keptOld: [{ camera: 'cam2', fields: ['tlsServername'] }], heldProxies: [{ proxy: 'Spare', fields: ['proxyUrl'] }], heldTotal: 3,
    });
    const lan = b.viewers.find((v: any) => v.name === 'lanviewer');
    expect(lan).toMatchObject({ thisViewer: false, held: [], heldTotal: 0, address: { scope: 'private' } });
  });

  it('list_moves data: this account, phase, progress, times; no token, address or actor', async () => {
    const b = await fleet(bothKey, home.id);
    expect(b.moves).toHaveLength(1);
    expect(b.moves[0]).toMatchObject({ camera: 'cam1', cameraName: 'Yard', source: 'Pi', target: 'Spare', phase: 'requested', bytesDone: null, endedAt: null, chunks: { pending: 0 } });
    expect(b.moves[0].createdAt).toEqual(expect.any(Number));
    expect((await fleet(bothKey, beta.id)).moves).toEqual([]);
  });

  it('switch_list and camera_power data: the switches by name with their LAN address, each shown camera\'s power; no id, serial or firmware', async () => {
    const b = await fleet(bothKey, home.id);
    expect(b.switches).toEqual([{
      name: 'GPS-208', model: 'sscpoe-web', address: { url: 'http://192.168.1.217/', scope: 'private', note: 'Local network address: only reachable from inside that network.' },
      proxy: 'Pi', state: 'active', readAt: switchReadAt, ports: 8, problems: [],
    }]);
    // cam2 runs on a hidden proxy: not shown, as in proxies[].cameras.
    expect(b.cameraPower).toEqual([{ camera: 'cam1', cameraName: 'Yard', kind: 'poe', switch: 'GPS-208', port: 3, watts: 4.2, verifiedAt: switchReadAt, notSeen: false, lastCycle: null }]);
    expect((await fleet(bothKey, beta.id))).toMatchObject({ switches: [], cameraPower: [{ camera: 'cam1', kind: 'unknown', switch: null, port: null, watts: null, verifiedAt: null }] });
    const raw = JSON.stringify(b);
    for (const leak of ['sw_', 'SN-MARKER', 'FW-MARKER', 'switchId', 'commandIds']) expect(raw, leak).not.toContain(leak);
  });

  it('scan: one account never shows another, and nothing secret or internal in the JSON', async () => {
    const raw = JSON.stringify(await fleet(bothKey, home.id));
    for (const leak of ['Beta-', 'beta-', beta.id, betaPx.id, 'bcam', onlyBeta.id, 'beta-viewer-marker', 'pending-marker', 'hidden-marker', 'Home-Account-Marker',
      FINGERPRINT, 'SHA256:', 'sha256:', '7777777', 'caFingerprint', 'token', 'hash', 'password', 'publicKey', 'NOTES-MARKER', 'MARKER-REPORT', 'DETAIL-MARKER', 'rq-marker', '198.51.100.77', 'actor-marker',
      'prx_', 'cam_', 'cms_', 'key_', 'tok_', '"accounts"', 'audit']) expect(raw, leak).not.toContain(leak);
    expect(raw.match(/acc_[0-9A-Z]+/g)).toEqual([home.id]);
    const rawBeta = JSON.stringify(await fleet(bothKey, beta.id));
    for (const leak of ['Yard', 'Pi"', 'lanviewer', home.id, 'owner@example.org', 'MARKER-REPORT']) expect(rawBeta, leak).not.toContain(leak);
    expect(JSON.parse(rawBeta).viewers.find((v: any) => v.name === 'cluster')).toMatchObject({ held: [{ camera: 'bcam', fields: ['protocol'] }], heldProxies: [{ proxy: 'Beta-Proxy-Marker', fields: ['caFingerprints'] }], heldTotal: 3 });
  });

  it("instance A can't read account B: 403 not_served, signed, and the same for an account that doesn't exist", async () => {
    for (const [key, acc] of [[homeKey, beta.id], [betaKey, home.id], [homeKey, 'acc_00000000000000000000'], [homeKey, 'nonsense']] as const) {
      const r = await get(key, acc);
      const bytes = Buffer.from(await r.clone().arrayBuffer());
      expect(r.status).toBe(403);
      expect(JSON.parse(bytes.toString())).toEqual({ error: 'not_served' });
      expect(verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(403, r.nonce, bytes), r.headers.get('x-cams-admin-sig'))).toBe(true);
    }
  });

  it('stops at once when the account leaves the instance', async () => {
    const i = await s.api('POST', '/cams-instances', { name: 'leaving', displayName: 'Leaving', accounts: [home.id] });
    const k = await enrollCamsKey(s, i.id);
    expect((await get(k, home.id)).status).toBe(200);
    await s.api('PATCH', `/cams-instances/${i.id}`, { accounts: [], version: s.built.camsInstances.get(i.id).version });
    expect((await get(k, home.id)).status).toBe(403);
  });

  it('a blocked instance and a revoked key are refused', async () => {
    const i = await s.api('POST', '/cams-instances', { name: 'blocked', displayName: 'Blocked', accounts: [home.id] });
    const k = await enrollCamsKey(s, i.id);
    expect((await get(k, home.id)).status).toBe(200);
    s.built.camsInstances.block('admin@example.org', i.id);
    const r = await get(k, home.id);
    expect([r.status, (await r.json()).error]).toEqual([403, 'revoked']);
    const i2 = await s.api('POST', '/cams-instances', { name: 'keyless', displayName: 'Keyless', accounts: [home.id] });
    const k2 = await enrollCamsKey(s, i2.id);
    expect((await get(k2, home.id)).status).toBe(200);
    s.built.camsInstances.revokeKey('admin@example.org', i2.id, k2.keyId);
    const r2 = await get(k2, home.id);
    expect([r2.status, (await r2.json()).error]).toEqual([401, 'unknown_key']);
  });

  it('an unsigned request, a wrong signature and a replay are refused', async () => {
    const bare = await fetch(`${s.url}${fleetPath(home.id)}`);
    expect(bare.status).toBe(400);
    expect(await bare.json()).toEqual({ error: 'bad_request' });
    const noSig = await signedFetch(s, bothKey, 'GET', fleetPath(home.id), undefined, { drop: 'X-Cams-Sig' });
    expect(noSig.status).toBe(400);
    // Signed for one account, sent for another: the path is in the signature.
    const swapped = await signedFetch(s, bothKey, 'GET', fleetPath(home.id), undefined, { signPath: fleetPath(beta.id) });
    expect([swapped.status, (await swapped.json()).error]).toEqual([401, 'bad_signature']);
    const stranger = await signedFetch(s, bothKey, 'GET', fleetPath(home.id), undefined, { sigWith: homeKey.privateKey });
    expect([stranger.status, (await stranger.json()).error]).toEqual([401, 'bad_signature']);
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    expect((await signedFetch(s, bothKey, 'GET', fleetPath(home.id), undefined, { nonce })).status).toBe(200);
    const again = await signedFetch(s, bothKey, 'GET', fleetPath(home.id), undefined, { nonce });
    expect([again.status, (await again.json()).error]).toEqual([401, 'replayed']);
  });

  it('read only: no other method, nothing written', async () => {
    expect((await signedFetch(s, bothKey, 'POST', fleetPath(home.id), {})).status).toBe(404);
    // Every write on this connection counts here: a read of the fleet makes none.
    const writes = () => s.built.db.prepare('SELECT total_changes() n').get();
    const before = writes();
    await fleet(bothKey, home.id);
    expect(writes()).toEqual(before);
  });

  it('caps the problems of a proxy', async () => {
    const now = Date.now();
    const summary = makeSummary({ cameras: 0, now }) as any;
    summary.items = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, label: 'L'.repeat(200), text: 'T'.repeat(500), problem: true }));
    s.built.status.hello(spare.id, 'v', now, ['status']);
    s.built.status.heartbeat(spare.id, { summary, proxy: makeProxyInfo({ now }), truncated: false }, now);
    const b = await fleet(bothKey, home.id);
    expect(strictCamsValidator('fleet-response')(b), strictCamsErrors()).toBe(true);
    const p = b.proxies.find((x: any) => x.name === 'spare');
    expect(p.problems).toHaveLength(20);
    expect(p.problems[0].label.length).toBe(120);
    expect(p.problems[0].text.length).toBeLessThanOrEqual(240);
  });
});
