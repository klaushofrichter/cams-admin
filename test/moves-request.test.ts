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
import { answerKinds, estimateS, FALLBACK_BPS, hostnameOf, MIN_ESTIMATE_S, OFFER_EXPIRY_MS, RESUME_GAP_MS } from '../server/moves/service';
import { readEpoch } from '../server/db/open';
import { AUDIT_ACTIONS } from '../server/audit';
import { moveToken, targetAddress } from '../server/moves/token';
import { precheckReport } from '../server/moves/precheck';
import { moveView } from '../server/moves/view';
import { spaceCheck } from '../server/moves/space';

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
async function proxy(o: { allow?: string[]; site?: string | null; registrySite?: string | null; account?: string; caps?: string[] } = {}): Promise<Px> {
  const name = `mv${n++}`;
  const p = await enrolled(s, name, o.account ?? 'home');
  const site = o.site === undefined ? `site-${name}` : o.site;
  const client = makeClient(p.key, { commands: { allow: o.allow ?? ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }), capabilities: o.caps });
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
function request(src: Px, target: string, o: { requestId?: string; camera?: string; conn?: Record<string, unknown>; bounds?: Record<string, unknown> | null } = {}) {
  const body = fx('valid-event-move-request.json');
  const { proxyId: _p, connId: _c, ...rest } = body;
  const requestId = o.requestId ?? rq();
  const { bounds: _b, ...noBounds } = rest;
  src.client.emitEvent({ ...noBounds, ...(o.bounds !== undefined ? { bounds: o.bounds } : {}), requestId, target, camera: { ...rest.camera, proxyCameraId: o.camera ?? 'cam1', ...o.conn } });
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

describe('move request, pre-approval bounds', () => {
  const BOUNDS = { transfer: true, kinds: ['clips', 'stills'], space: 'fit', maxBudgetS: 3600 };
  it('request with bounds stores them and the view shows autoApprove', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    request(src, tgt.proxyId, { bounds: BOUNDS });
    await until(() => moves().length === 1, 5000, 'move row');
    const m = moves()[0];
    expect(m.bounds).toEqual(BOUNDS);
    const v = moveView(s.built.db, m);
    expect(v.autoApprove).toBe(true);
    expect(v.bounds).toEqual(BOUNDS);
    expect(JSON.parse(auditFor('move-request').at(-1)!.detail)).toMatchObject({ autoApprove: true });
  });
  it('request without bounds stores null', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    request(src, tgt.proxyId);
    await until(() => moves().length === 1, 5000, 'move row');
    const m = moves()[0];
    expect(m.bounds).toBeNull();
    expect(moveView(s.built.db, m)).toMatchObject({ autoApprove: false, bounds: null });
    expect(JSON.parse(auditFor('move-request').at(-1)!.detail)).toMatchObject({ autoApprove: false });
  });
  it('the request flow is unchanged with bounds', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    request(src, tgt.proxyId, { bounds: BOUNDS });
    await until(() => got(tgt.client, 'move.offer').length === 1, 5000, 'offer');
    expect(got(src.client, 'move.open')).toHaveLength(1);
    expect(JSON.stringify(got(src.client, 'move.open')[0].body.args)).not.toContain('bounds');
    expect(JSON.stringify(got(tgt.client, 'move.offer')[0].body.args)).not.toContain('bounds');
  });
});

describe('the ptz kind: the accepted kinds of the target', () => {
  const ALL = ['stills', 'clips', 'events', 'checks', 'archive', 'ptz'];
  const offerWith = (tgt: Px, kinds: unknown) => {
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: true, space: { needed: 1000, available: 5000, fits: true, perKind: {}, retentionProposal: null }, probeBps: 50_000_000, kinds } };
  };
  const run = async (caps: string[], kinds: unknown) => {
    const src = await proxy({ caps });
    const tgt = await proxy();
    camera(src);
    offerWith(tgt, kinds);
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    await until(() => moves()[0]?.phase === 'awaiting-approval', 5000, 'awaiting-approval');
    return a;
  };
  it('an offer result with kinds is accepted and relayed', async () => {
    const a = await run(['move-ptz'], ALL);
    expect(a).toMatchObject({ accept: true, kinds: ALL });
    const offer = auditFor('move-offer').map((x) => JSON.parse(x.detail)).find((d) => d.phase === 'awaiting-approval');
    expect(offer.kinds).toEqual(ALL);
  });
  it('kinds are not relayed to a source without move-ptz', async () => {
    const a = await run([], ALL);
    expect(a.accept).toBe(true);
    expect('kinds' in a).toBe(false);
    expect(moves()[0].phase).toBe('awaiting-approval');
  });
  it('an offer result with bad kinds: relayed without kinds', async () => {
    const a = await run(['move-ptz'], ['ptz', 'ptz']);
    expect(a.accept).toBe(true);
    expect('kinds' in a).toBe(false);
  });
  it('answerKinds reads unique move kinds, else null', () => {
    expect(answerKinds(ALL)).toEqual(ALL);
    expect(answerKinds(['ptz'])).toEqual(['ptz']);
    for (const bad of [undefined, null, 'ptz', ['ptz', 'ptz'], ['video'], [1], Array(7).fill('ptz')]) expect(answerKinds(bad), JSON.stringify(bad)).toBeNull();
  });
  it('estimateS and the space check ignore ptz', () => {
    const summary = fx('valid-event-move-request.json').summary;
    const withPtz = { ...summary, ptz: { files: 9, bytes: 9_000_000_000, rows: 3, oldest: 0, newest: 1 } };
    expect(estimateS(withPtz, 1_000_000)).toBe(estimateS(summary, 1_000_000));
    const profile = { storage: { budgetBytes: 10_000_000_000, usedBytes: 0, diskBytes: null, freeBytes: null } } as any;
    expect(spaceCheck(withPtz, profile, {}, 1)).toEqual(spaceCheck(summary, profile, {}, 1));
  });
});

describe('move request', () => {
  it('a plain-http source without a TLS name (the Pi) gets an offer naming its url host', async () => {
    const src = await proxy({ site: null });
    const tgt = await proxy();
    camera(src);
    request(src, tgt.proxyId);
    await until(() => moves().length === 1 && got(src.client, 'move.open').length === 1, 5000, 'move row + open');
    await until(() => got(tgt.client, 'move.offer').length === 1, 5000, 'offer');
    expect(got(tgt.client, 'move.offer')[0].body.args.source).toMatchObject({ url: `http://${src.ip}:8480`, tlsServername: src.ip });
    expect(auditFor('move-request').at(-1)!.outcome).toBe('ok');
  });
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
    // The refusals are rejected rows (ended); the first move is the only active one.
    expect(s.built.moves.store.active().map((m) => m.requestId)).toEqual([first]);
    expect(moves().filter((m) => m.phase === 'rejected').map((m) => m.requestId).sort()).toEqual([second, third].sort());
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

  it('the precheck report (diagnostics) names the rule and the instance, and agrees with the refusal', async () => {
    const src = await proxy();
    const tgt = await proxy({ allow: ['move.send'] });
    camera(src);
    const i = s.built.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [src.accountId] });
    s.built.camsInstances.setRoute(ACTOR, i.id, src.proxyId, { url: null, hidden: false });
    const report = () => precheckReport({ db: s.built.db, registry: s.built.registry, status: s.built.status, store: s.built.moves.store }, { accountId: src.accountId, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId });
    const rule = (k: string) => report().rules.find((r) => r.rule === k);
    expect(report()).toMatchObject({ ok: false, reason: 'moves_not_allowed' });
    expect(rule('target_online')).toMatchObject({ ok: true, detail: 'target online' });
    expect(rule('target_receives')).toMatchObject({ ok: false, detail: 'commands allowed; move.receive not allowed' });
    expect(rule('site_ca')).toMatchObject({ ok: true });
    expect(rule('routed')).toEqual({ rule: 'routed', ok: false, reason: 'not_routed', detail: 'cams instances that see the source but not the target: cluster' });
    expect(s.built.moves.precheck({ accountId: src.accountId, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId })).toEqual({ ok: false, reason: 'moves_not_allowed', rule: 'target_receives', detail: 'commands allowed; move.receive not allowed' });
    s.built.camsInstances.setRoute(ACTOR, i.id, tgt.proxyId, { url: null, hidden: false });
    expect(rule('routed')).toEqual({ rule: 'routed', ok: true, reason: 'not_routed' });
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
    // The fixture's summary: 4 × 52428800 bytes, 480 files, 4 kinds over 31 days (124 chunks): bytes at the
    // probe rate + 150 ms per file + 1 s per chunk + 45 s switch-over.
    const want = Math.ceil((4 * 52428800) / 50_000_000 + 480 * 0.15 + 124 + 45);
    expect(a).toEqual({ v: 1, moveId: moves()[0].id, requestId, target: { proxyId: tgt.proxyId, name: tgt.name }, accept: true, space, estimateS: want });
    expect(moves()[0]).toMatchObject({ phase: 'awaiting-approval', rateBps: 50_000_000, etaS: want, bytesTotal: 4 * 52428800 });
  });

  it('a failed probe (probeBps 0) uses the fallback rate', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: true, space: { needed: 1, available: 2, fits: true, perKind: {}, retentionProposal: null }, probeBps: 0 } };
    const a = await answerOf(src, request(src, tgt.proxyId));
    expect(a.estimateS).toBe(Math.ceil((4 * 52428800) / FALLBACK_BPS + 480 * 0.15 + 124 + 45));
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

describe('move request, the camera connection must match the registry', () => {
  it('a host other than the registry\'s is refused incompatible', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const requestId = request(src, tgt.proxyId, { conn: { host: '192.0.2.99' } });
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'incompatible' });
    expect(moves().map((m) => m.phase)).toEqual(['rejected']);
    const d = JSON.parse(auditFor('move-request').at(-1)!.detail);
    expect(d).toMatchObject({ reason: 'incompatible', rule: 'camera_host', detail: 'registry host 192.0.2.10, source reports 192.0.2.99', phase: 'rejected' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });

  it('a protocol other than the registry\'s is refused incompatible', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const requestId = request(src, tgt.proxyId, { conn: { protocol: 'http' } });
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'incompatible' });
    expect(JSON.parse(auditFor('move-request').at(-1)!.detail)).toMatchObject({ rule: 'camera_protocol' });
    expect(moves().map((m) => m.phase)).toEqual(['rejected']);
  });

  const camWith = (src: Px, f: { host: string | null; protocol: string | null }) =>
    s.built.registry.createCamera(ACTOR, src.accountId, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', ...f } as any);

  it('an adopted camera (host from-proxy, protocol NULL) moves', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camWith(src, { host: 'from-proxy', protocol: null });
    expect(await answerOf(src, request(src, tgt.proxyId))).toMatchObject({ accept: true });
  });

  it('a camera with a NULL registry host moves', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camWith(src, { host: null, protocol: 'https' });
    expect(await answerOf(src, request(src, tgt.proxyId))).toMatchObject({ accept: true });
  });

  it('hostnameOf: lowercase, no port, IPv6 without brackets', () => {
    expect(hostnameOf('192.0.2.10:443')).toBe('192.0.2.10');
    expect(hostnameOf('Cam.Example.test')).toBe('cam.example.test');
    expect(hostnameOf('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(hostnameOf('2001:db8::1')).toBe('2001:db8::1');
  });

  it('hostnames compare without the port and case-insensitively', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camWith(src, { host: 'Cam-1.Example.test', protocol: 'https' });
    expect(await answerOf(src, request(src, tgt.proxyId, { conn: { host: 'cam-1.example.test:443' } }))).toMatchObject({ accept: true });
  });

  it('a registry host without a port equals the reported host with one', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    expect(await answerOf(src, request(src, tgt.proxyId, { conn: { host: '192.0.2.10:443' } }))).toMatchObject({ accept: true });
  });

  it('a different hostname with a port is still refused incompatible', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    expect(await answerOf(src, request(src, tgt.proxyId, { conn: { host: '192.0.2.11:443' } }))).toMatchObject({ accept: false, reason: 'incompatible' });
  });

  it('a registry host "from-proxy" takes the source\'s address', async () => {
    const src = await proxy();
    const tgt = await proxy();
    s.built.registry.createCamera(ACTOR, src.accountId, { camsId: 'cam1', name: 'Cam 1', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https' });
    const requestId = request(src, tgt.proxyId);
    expect(await answerOf(src, requestId)).toMatchObject({ accept: true });
  });
});

describe('requested and offered recover (lost results, staleness)', () => {
  // The command's answer landed but its listener never ran (a crash between the commit and the listener, or a listener throw).
  const landed = (command: string, state: string, code: string | null = null) =>
    s.built.db.prepare(`UPDATE commands SET state = ?, outcome_code = ?, finished_at = ? WHERE command = ?`).run(state, code, clock.now(), command);
  const cmdRows = (moveId: string, command: string) => s.built.db.prepare(`SELECT proxy_id, state FROM commands WHERE command = ? AND json_extract(args, '$.moveId') = ?`).all(command, moveId) as { proxy_id: string; state: string }[];

  it('requested: a done move.open whose result was not handled is picked up by tick', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.dropCommands = 1;
    request(src, tgt.proxyId);
    await until(() => got(src.client, 'move.open').length === 1, 5000, 'open');
    landed('move.open', 'done');
    clock.advance(RESUME_GAP_MS);
    s.built.moves.tick();
    await until(() => moves()[0].phase === 'awaiting-approval', 5000, 'awaiting-approval');
    expect(got(tgt.client, 'move.offer')).toHaveLength(1);
  });

  it('requested: the same after a restart (token gone) fails token_lost and answers the source', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.dropCommands = 1;
    const requestId = request(src, tgt.proxyId);
    await until(() => got(src.client, 'move.open').length === 1, 5000, 'open');
    landed('move.open', 'done');
    (s.built.moves as unknown as { pending: Map<string, unknown> }).pending.clear();
    clock.advance(RESUME_GAP_MS);
    s.built.moves.tick();
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'target_failed' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'token_lost' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
  });

  it('offered: a final move.offer whose result was not handled is picked up by tick', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.dropCommands = 1;
    const requestId = request(src, tgt.proxyId);
    await until(() => got(tgt.client, 'move.offer').length === 1 && moves()[0].phase === 'offered', 5000, 'offered');
    landed('move.offer', 'failed', 'disk_error');
    clock.advance(RESUME_GAP_MS);
    s.built.moves.tick();
    expect(await answerOf(src, requestId)).toMatchObject({ accept: false, reason: 'target_failed' });
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'disk_error' });
  });

  it('requested: a move.open open past the offer expiry fails offer_expired and cancels both', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    src.client.dropCommands = 1;
    request(src, tgt.proxyId);
    await until(() => got(src.client, 'move.open').length === 1, 5000, 'open');
    await new Promise((r) => setTimeout(r, 250));
    const epoch = readEpoch(s.built.db);
    clock.advance(OFFER_EXPIRY_MS - 1000);
    s.built.moves.tick();
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(moves()[0].phase).toBe('requested');
    clock.advance(2000);
    s.built.moves.tick();
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'offer_expired' });
    const m = moves()[0];
    expect(cmdRows(m.id, 'move.cancel').map((r) => r.proxy_id).sort()).toEqual([src.proxyId, tgt.proxyId].sort());
  });

  it('offered: a move.offer open past the offer expiry fails offer_expired and cancels both', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.dropCommands = 1;
    request(src, tgt.proxyId);
    await until(() => got(tgt.client, 'move.offer').length === 1 && moves()[0].phase === 'offered', 5000, 'offered');
    await new Promise((r) => setTimeout(r, 250));
    const epoch = readEpoch(s.built.db);
    clock.advance(OFFER_EXPIRY_MS - 1000);
    s.built.moves.tick();
    expect(readEpoch(s.built.db)).toBe(epoch);
    clock.advance(2000);
    s.built.moves.tick();
    expect(moves()[0]).toMatchObject({ phase: 'failed', reason: 'offer_expired' });
    const m = moves()[0];
    await until(() => got(tgt.client, 'move.cancel').some((c) => c.body.args.moveId === m.id), 5000, 'target cancel');
    expect(cmdRows(m.id, 'move.cancel').map((r) => r.proxy_id).sort()).toEqual([src.proxyId, tgt.proxyId].sort());
  });
});

describe('estimate and audit', () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 9, 1);
  const k = (files: number, bytes: number, days = 1) => ({ files, bytes, rows: files, oldest: files ? T0 : null, newest: files ? T0 + (days - 1) * DAY + 3600_000 : null });
  const none = k(0, 0);

  it('estimateS: bytes at the probe rate, per file, per chunk and the switch-over overhead', () => {
    // 100 MB over 20 files in 2 chunks (one day each kind) at 1 MB/s: 100 + 3 + 2 + 45.
    const summary = { stills: k(10, 10_000_000), clips: none, events: none, checks: none, archive: k(10, 90_000_000) };
    expect(estimateS(summary, 1_000_000)).toBe(150);
    expect(estimateS(summary, 0)).toBe(Math.ceil(100_000_000 / FALLBACK_BPS + 20 * 0.15 + 2 + 45));
  });

  it('estimateS: never under the floor; nothing to copy is the floor', () => {
    expect(estimateS({ stills: none, clips: none, events: none, checks: none, archive: none }, 50_000_000)).toBe(MIN_ESTIMATE_S);
    expect(MIN_ESTIMATE_S).toBe(60);
  });

  it('estimateS: a localstack-sized move (≈54 MB, 335 files, fast probe) is at least what it took (40–60 s)', () => {
    const summary = { stills: k(35, 4_000_000), clips: k(280, 49_000_000, 3), events: k(20, 1_000_000, 3), checks: none, archive: none };
    expect(estimateS(summary, 100_000_000)).toBeGreaterThanOrEqual(60);
  });

  it('estimateS: a big move is still dominated by its bytes', () => {
    const summary = { stills: none, clips: k(20_000, 50_000_000_000, 30), events: none, checks: none, archive: none };
    const est = estimateS(summary, 10_000_000);
    expect(est).toBeGreaterThanOrEqual(5000);
    expect(5000 / est).toBeGreaterThan(0.6);
  });

  it('estimateS: the chunks of a kind never outnumber its files', () => {
    // One file whose oldest and newest are a year apart (inconsistent summary): one chunk, not 366.
    const summary = { stills: k(1, 1_000_000, 366), clips: none, events: none, checks: none, archive: none };
    expect(estimateS(summary, 1_000_000)).toBe(MIN_ESTIMATE_S);
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
