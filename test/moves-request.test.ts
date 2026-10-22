// Camera move, the start of the job (plan Task 4): targets, the request's
// precheck, move.open then move.offer (A15), and the answer to the source.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomInt } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProxyInfo } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';
import { GIVE_UP_AFTER_MS, RESEND_AFTER_MS } from '../server/commands/service';
import { estimateS, FALLBACK_BPS, PER_FILE_OVERHEAD_MS } from '../server/moves/service';
import { AUDIT_ACTIONS } from '../server/audit';
import { moveToken, targetAddress } from '../server/moves/token';

const ACTOR = 'admin@example.com';
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rq = () => 'rq_' + Array.from({ length: 20 }, () => CROCK[randomInt(32)]).join('');
const FP = 'SHA256:' + 'CD'.repeat(32);

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 20;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string; ip: string }
// An enrolled, online proxy reporting `site`; the registry has the same site, a LAN url, a TLS name and the CA pin.
async function proxy(o: { allow?: string[]; site?: string | null; registrySite?: string | null; account?: string } = {}): Promise<Px> {
  const name = `mv${n++}`;
  const p = await enrolled(s, name, o.account ?? 'home');
  const site = o.site === undefined ? `site-${name}` : o.site;
  const client = makeClient(p.key, { commands: { allow: o.allow ?? ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }) });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'connected');
  const addr = `192.0.2.${ip++}`;
  const cur = s.built.registry.getProxy(p.accountId, p.proxyId);
  const registrySite = o.registrySite === undefined ? site : o.registrySite;
  s.built.registry.updateProxy(ACTOR, p.accountId, p.proxyId, {
    url: `http://${addr}:8480`, tlsSite: registrySite, tlsServername: registrySite ? `${name}.${registrySite}.internal` : null, caFingerprints: [FP], version: cur.version,
  });
  return { ...p, client, name, ip: addr };
}
function camera(src: Px, proxyCameraId = 'cam1', camsId = proxyCameraId) {
  return s.built.registry.createCamera(ACTOR, src.accountId, { camsId, name: `Cam ${camsId}`, kind: 'camera', proxyId: src.proxyId, proxyCameraId, host: '192.0.2.10', protocol: 'https' });
}
function request(src: Px, target: string, o: { requestId?: string; camera?: string } = {}) {
  const body = fx('valid-event-move-request.json');
  const { proxyId: _p, connId: _c, ...rest } = body;
  const requestId = o.requestId ?? rq();
  src.client.emitEvent({ ...rest, requestId, target, camera: { ...rest.camera, proxyCameraId: o.camera ?? 'cam1' } });
  return requestId;
}
const got = (c: ProxyClient, command: string) => c.receivedCommands.filter((m) => m.body.command === command);
const moves = () => s.built.moves.store.list();
const answerOf = async (src: Px, requestId: string) => {
  await until(() => got(src.client, 'move.answer').some((m) => m.body.args.requestId === requestId), 5000, 'answer');
  return got(src.client, 'move.answer').find((m) => m.body.args.requestId === requestId)!.body.args as Record<string, any>;
};
const auditFor = (action: string) => s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string }[];
// Every text column of every table, for "the token is nowhere".
function dbText(): string {
  const tables = (s.built.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(s.built.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

describe('move targets', () => {
  it('targets lists only same-account online proxies allowing move.receive', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const sendOnly = await proxy({ allow: ['move.send'] });
    const noSite = await proxy({ site: null });
    const other = await proxy({ account: 'other' });
    const off = await proxy();
    off.client.abort();
    clock.advance(10 * 60_000); // off's heartbeat ages out; the others heartbeat again
    await until(() => s.built.status.view(src.proxyId).state === 'online' && s.built.status.view(tgt.proxyId).state === 'online' && s.built.status.view(off.proxyId).state === 'offline', 5000, 'states');
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId).map((t) => t.proxyId)).toEqual([tgt.proxyId]);
    src.client.emitEvent({ kind: 'move.targets', requestId: 'rq_0123456789ABCDEFGHJK', camera: 'cam1' });
    await until(() => got(src.client, 'move.targets').length === 1, 5000, 'move.targets');
    const args = got(src.client, 'move.targets')[0].body.args;
    expect(args).toEqual({ v: 1, requestId: 'rq_0123456789ABCDEFGHJK', targets: [{ proxyId: tgt.proxyId, name: tgt.name, site: `site-${tgt.name}` }] });
    for (const p of [sendOnly, noSite, other, off]) expect(JSON.stringify(args)).not.toContain(p.proxyId);
  });
});

describe('move request', () => {
  it('request creates a move and sends move.open then move.offer', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    src.client.dropCommands = 1; // the first move.open is lost: no offer may go out before the open is done (A15)
    const requestId = request(src, tgt.proxyId);
    await until(() => moves().length === 1 && got(src.client, 'move.open').length === 1, 5000, 'move row + open');
    const m = moves()[0];
    expect(m).toMatchObject({ phase: 'requested', cameraId: cam.id, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, requestId, targetIp: tgt.ip });
    expect(m.id).toMatch(/^mv_[0-9A-HJKMNP-TV-Z]{20}$/);
    await new Promise((r) => setTimeout(r, 200));
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
    // The open is re-sent and answered: now the offer.
    clock.advance(RESEND_AFTER_MS);
    s.built.tick();
    await until(() => got(tgt.client, 'move.offer').length === 1, 5000, 'offer');
    const open = got(src.client, 'move.open').at(-1)!.body.args;
    const offer = got(tgt.client, 'move.offer')[0].body.args;
    expect(open).toMatchObject({ v: 1, moveId: m.id, requestId, camera: 'cam1', targetIp: tgt.ip });
    expect(open.tokenHash).toBe(`sha256:${createHash('sha256').update(offer.token, 'utf8').digest('hex')}`);
    expect(offer).toMatchObject({
      v: 1, moveId: m.id,
      source: { proxyId: src.proxyId, name: src.name, url: `http://${src.ip}:8480`, caFingerprints: [FP], tlsServername: `${src.name}.site-${src.name}.internal` },
      camera: { camsId: 'cam1', proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https', user: 'cams', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
    });
    await until(() => s.built.moves.store.get(m.id)!.phase === 'awaiting-approval', 5000, 'awaiting-approval');
    const after = s.built.moves.store.get(m.id)!;
    expect(after.tokenHash).toBe(open.tokenHash);
    expect(after.offeredAt).not.toBeNull();
    // The token's plaintext is nowhere in the database once the offer is final (audit included).
    expect(dbText()).not.toContain(offer.token);
    expect(auditFor('move-request').map((a) => a.outcome)).toEqual(['ok']);
    expect(auditFor('move-offer').length).toBeGreaterThanOrEqual(1);
    for (const a of [...auditFor('move-request'), ...auditFor('move-offer'), ...auditFor('move-phase')]) {
      expect(a.detail).not.toContain(offer.token);
      expect(JSON.parse(a.detail)).toMatchObject({ moveId: m.id, camsId: 'cam1', source: src.proxyId, target: tgt.proxyId });
    }
  });

  it('a repeated request event (same requestId) makes no second move and answers nothing new', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const requestId = request(src, tgt.proxyId);
    await answerOf(src, requestId);
    request(src, tgt.proxyId, { requestId });
    await new Promise((r) => setTimeout(r, 300));
    expect(moves()).toHaveLength(1);
    expect(got(src.client, 'move.open')).toHaveLength(1);
    expect(got(tgt.client, 'move.offer')).toHaveLength(1);
    expect(got(src.client, 'move.answer')).toHaveLength(1);
  });

  it('a repeated refused request is answered once', async () => {
    const src = await proxy();
    const other = await proxy({ account: 'other' });
    camera(src);
    const requestId = request(src, other.proxyId);
    await answerOf(src, requestId);
    request(src, other.proxyId, { requestId });
    await new Promise((r) => setTimeout(r, 300));
    expect(got(src.client, 'move.answer')).toHaveLength(1);
  });

  it('second request is busy (same source, and a target already in a move)', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const src2 = await proxy();
    camera(src);
    camera(src, 'cam2');
    camera(src2, 'cam1', 'other-cam1');
    tgt.client.dropCommands = 100; // the offer stays open: the first move stays active
    const first = request(src, tgt.proxyId);
    const second = request(src, tgt.proxyId, { camera: 'cam2' });
    const third = request(src2, tgt.proxyId);
    expect(await answerOf(src, second)).toMatchObject({ accept: false, reason: 'busy' });
    expect(await answerOf(src2, third)).toMatchObject({ accept: false, reason: 'busy' });
    expect(moves()).toHaveLength(1);
    expect(moves()[0].requestId).toBe(first);
    const refused = auditFor('move-request').filter((a) => a.outcome === 'refused').map((a) => JSON.parse(a.detail));
    expect(refused.map((d) => d.reason)).toEqual(['busy', 'busy']);
  });

  it('cross-account target is refused other_account', async () => {
    const src = await proxy();
    const other = await proxy({ account: 'other' });
    camera(src);
    const requestId = request(src, other.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ v: 1, requestId, accept: false, reason: 'other_account' });
    expect(a.target.name).not.toBe(other.name); // another account's proxy name is not shown
    expect(a.moveId).toMatch(/^mv_/);
    expect(moves()).toHaveLength(0);
    expect(got(other.client, 'move.offer')).toHaveLength(0);
  });

  it('target not routed to the source\'s cams instance is refused not_routed', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const i = s.built.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [src.accountId] });
    s.built.camsInstances.setRoute(ACTOR, i.id, src.proxyId, { url: null, hidden: false });
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId)).toEqual([]);
    const requestId = request(src, tgt.proxyId);
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'not_routed' });
    // Routed there too: fine.
    s.built.camsInstances.setRoute(ACTOR, i.id, tgt.proxyId, { url: null, hidden: false });
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId).map((t) => t.proxyId)).toEqual([tgt.proxyId]);
  });

  it('a camera with a per-instance host override is refused host_overridden', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const cam = camera(src);
    const i = s.built.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [src.accountId] });
    s.built.camsInstances.setOverride(ACTOR, i.id, cam.id, { host: '198.51.100.7' });
    const requestId = request(src, tgt.proxyId);
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'host_overridden' });
  });

  it('a registry site that differs from the reported one is refused no_site_ca', async () => {
    const src = await proxy();
    const tgt = await proxy({ registrySite: 'elsewhere' });
    camera(src);
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId)).toEqual([]);
    const requestId = request(src, tgt.proxyId);
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'no_site_ca' });
  });

  it('an offline target is refused target_offline, one without move.receive moves_not_allowed', async () => {
    const src = await proxy();
    const off = await proxy();
    const sendOnly = await proxy({ allow: ['move.send'] });
    camera(src);
    camera(src, 'cam2');
    off.client.abort();
    clock.advance(10 * 60_000);
    await until(() => s.built.status.view(off.proxyId).state === 'offline' && s.built.status.view(src.proxyId).state === 'online' && s.built.status.view(sendOnly.proxyId).state === 'online', 5000, 'offline');
    expect(await answerOf(src, request(src, off.proxyId))).toMatchObject({ accept: false, reason: 'target_offline' });
    expect(await answerOf(src, request(src, sendOnly.proxyId, { camera: 'cam2' }))).toMatchObject({ accept: false, reason: 'moves_not_allowed' });
  });
});

describe('move offer answer', () => {
  it('offer refused by the target becomes move.answer with its reason and phase rejected', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: false, reason: 'camera_unreachable' } };
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'camera_unreachable', target: { proxyId: tgt.proxyId, name: tgt.name } });
    expect(a.moveId).toBe(moves()[0].id);
    expect(moves()[0]).toMatchObject({ phase: 'rejected', reason: 'camera_unreachable' });
    expect(moves()[0].endedAt).not.toBeNull();
  });

  it('a move.offer the proxy refuses not_allowed is answered moves_not_allowed (A2)', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.refuseNext = { code: 'not_allowed' };
    const a = await answerOf(src, request(src, tgt.proxyId));
    expect(a).toMatchObject({ accept: false, reason: 'moves_not_allowed' });
    expect(moves()[0]).toMatchObject({ phase: 'rejected', reason: 'moves_not_allowed' });
  });

  it('offer accepted becomes move.answer with estimateS from probeBps', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const space = { needed: 1000, available: 5000, fits: true, perKind: { clips: 600, stills: 400 }, retentionProposal: null };
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: true, space, probeBps: 50_000_000 } };
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    // The fixture's summary: 4 × 52428800 bytes, 480 files (A25: all kinds plus per-file overhead).
    const want = Math.ceil((4 * 52428800) / 50_000_000 + (480 * PER_FILE_OVERHEAD_MS) / 1000);
    expect(a).toEqual({ v: 1, moveId: moves()[0].id, requestId, target: { proxyId: tgt.proxyId, name: tgt.name }, accept: true, space, estimateS: want });
    expect(moves()[0]).toMatchObject({ phase: 'awaiting-approval', rateBps: 50_000_000, etaS: want, bytesTotal: 4 * 52428800 });
  });

  it('a failed probe (probeBps 0) uses the fallback rate', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: true, space: { needed: 1, available: 2, fits: true, perKind: {}, retentionProposal: null }, probeBps: 0 } };
    const a = await answerOf(src, request(src, tgt.proxyId));
    expect(a.estimateS).toBe(Math.ceil((4 * 52428800) / FALLBACK_BPS + (480 * PER_FILE_OVERHEAD_MS) / 1000));
  });

  it('offer that never answers fails', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.dropCommands = 100;
    const requestId = request(src, tgt.proxyId);
    await until(() => got(tgt.client, 'move.offer').length >= 1, 5000, 'offer sent');
    expect(moves()[0].phase).toBe('offered');
    clock.advance(GIVE_UP_AFTER_MS + 1000);
    s.built.tick();
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'target_failed' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'unknown' });
    expect(dbText()).not.toContain(got(tgt.client, 'move.offer')[0].body.args.token);
  });

  it('a move whose token was lost (restart before move.open was done) fails and answers target_failed', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.dropCommands = 1;
    const requestId = request(src, tgt.proxyId);
    await until(() => moves().length === 1, 5000, 'move');
    (s.built.moves as unknown as { pending: Map<string, unknown> }).pending.clear(); // what a restart loses
    clock.advance(RESEND_AFTER_MS);
    s.built.tick();
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'target_failed' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'token_lost' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });

  it('a failed move.open fails the move, sends no offer and answers the source with the open\'s reason (A15)', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.moveResults['move.open'] = { status: 'failed', code: 'busy' };
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'busy' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'open:busy' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });
});

describe('move request, failures cams-admin answers at once', () => {
  it('a camera not in the registry is answered not_registered', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const requestId = request(src, tgt.proxyId, { camera: 'nope' });
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'not_registered' });
    expect(moves()).toHaveLength(0);
  });

  it('a move.open that fails with a code outside the reason list is answered internal', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.moveResults['move.open'] = { status: 'failed', code: 'disk_on_fire' };
    const requestId = request(src, tgt.proxyId);
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'internal' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'open:disk_on_fire' });
  });

  it('a move.open that never ends (unknown or expired) is answered internal', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.dropCommands = 100;
    const requestId = request(src, tgt.proxyId);
    await until(() => moves().length === 1, 5000, 'move');
    clock.advance(GIVE_UP_AFTER_MS + 1000);
    s.built.tick();
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'internal' });
    expect(moves()[0]).toMatchObject({ phase: 'failed' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });
});

describe('estimate and audit', () => {
  it('estimateS sums every kind and adds the per-file overhead', () => {
    const k = (files: number, bytes: number) => ({ files, bytes, rows: files, oldest: null, newest: null });
    const summary = { stills: k(10, 1_000_000), clips: k(0, 0), events: k(0, 0), checks: k(0, 0), archive: k(10, 9_000_000) };
    expect(estimateS(summary, 1_000_000)).toBe(Math.ceil(10 + (20 * PER_FILE_OVERHEAD_MS) / 1000));
    expect(estimateS(summary, 0)).toBe(Math.ceil(10_000_000 / FALLBACK_BPS + (20 * PER_FILE_OVERHEAD_MS) / 1000));
  });

  it('targetAddress: the url host, a name resolved once, nothing without an address', async () => {
    const seen: string[] = [];
    const resolve = async (h: string) => { seen.push(h); return '198.51.100.9'; };
    expect(await targetAddress('http://192.0.2.5:8480', resolve)).toBe('192.0.2.5');
    expect(await targetAddress('https://[2001:db8::1]:8443', resolve)).toBe('2001:db8::1');
    expect(await targetAddress('https://mini.example.test:8443', resolve)).toBe('198.51.100.9');
    expect(seen).toEqual(['mini.example.test']);
    expect(await targetAddress(null, resolve)).toBeNull();
    expect(await targetAddress('https://nowhere.example.test', async () => { throw new Error('ENOTFOUND'); })).toBeNull();
  });

  it('moveToken: the hash is sha256: and the lowercase hex of the token', () => {
    const t = moveToken();
    expect(t.tokenHash).toBe(`sha256:${createHash('sha256').update(t.token, 'utf8').digest('hex')}`);
    expect(t.token).toMatch(/^[\x21-\x7e]{8,256}$/);
  });

  it('lists the move audit actions', () => {
    for (const a of ['move-request', 'move-offer', 'move-phase']) expect(AUDIT_ACTIONS).toContain(a);
  });
});
