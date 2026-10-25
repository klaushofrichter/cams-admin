// Camera move refusals with their detail (who refused, the reason, the words), the
// rejected rows of cams-admin's own refusals, and the live event of every move change.
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
import { estimateS, FALLBACK_BPS, hostnameOf, MIN_ESTIMATE_S, OFFER_EXPIRY_MS, RESUME_GAP_MS } from '../server/moves/service';
import { readEpoch } from '../server/db/open';
import { AUDIT_ACTIONS } from '../server/audit';
import { moveToken, targetAddress } from '../server/moves/token';
import { precheckReport } from '../server/moves/precheck';
import { moveView } from '../server/moves/view';

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
// The live 'move' events published in this test (the ids, in order).
let published: string[] = [];
beforeEach(() => {
  published = [];
  const orig = s.built.live.publishRegistry.bind(s.built.live);
  s.built.live.publishRegistry = (type: string, id: string) => {
    if (type === 'move') published.push(id);
    orig(type, id);
  };
});
const view = (id: string) => moveView(s.built.db, s.built.moves.store.get(id)!);

describe('the target refuses with a detail', () => {
  it('stores the detail, forwards it in move.answer, audits it; the view says the target refused', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: false, reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' } };
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' });
    const m = moves()[0];
    expect(m).toMatchObject({ id: a.moveId, phase: 'rejected', reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' });
    expect(view(m.id)).toMatchObject({ refusedBy: 'target', reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' });
    expect(JSON.parse(auditFor('move-offer').at(-1)!.detail)).toMatchObject({ phase: 'rejected', reason: 'incompatible', detail: 'cameras.cam1.protocol is http here; the target needs https' });
  });

  it('an older target sends no detail: the answer has none and the move works as before', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: false, reason: 'camera_unreachable' } };
    const a = await answerOf(src, request(src, tgt.proxyId));
    expect(a).toMatchObject({ accept: false, reason: 'camera_unreachable' });
    expect('detail' in a).toBe(false);
    expect(moves()[0]).toMatchObject({ phase: 'rejected', detail: null });
    expect(view(moves()[0].id)).toMatchObject({ refusedBy: 'target', detail: null });
  });

  it('a rejection publishes a live move event (the list updates without a reload)', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.moveResults['move.offer'] = { status: 'ok', result: { accept: false, reason: 'incompatible' } };
    await answerOf(src, request(src, tgt.proxyId));
    const id = moves()[0].id;
    await until(() => s.built.moves.store.get(id)?.phase === 'rejected', 5000, 'rejected');
    const before = published.filter((x) => x === id).length;
    // Created (requested), offered, rejected: one event each.
    expect(before).toBeGreaterThanOrEqual(3);
    expect(published.at(-1)).toBe(id);
  });
});

describe("cams-admin's own refusals get a rejected move row", () => {
  it("a host other than the registry's: rejected row, detail with both hosts, answered with the row id and the detail", async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const requestId = request(src, tgt.proxyId, { conn: { host: '192.0.2.11' } });
    const a = await answerOf(src, requestId);
    const want = 'registry host 192.0.2.10, source reports 192.0.2.11';
    expect(a).toMatchObject({ accept: false, reason: 'incompatible', detail: want });
    expect(moves()).toHaveLength(1);
    const m = moves()[0];
    expect(m).toMatchObject({ id: a.moveId, requestId, phase: 'rejected', reason: 'incompatible', detail: want, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId });
    expect(m.endedAt).not.toBeNull();
    expect(view(m.id)).toMatchObject({ refusedBy: 'cams-admin', detail: want });
    expect(published).toContain(m.id);
    expect(JSON.parse(auditFor('move-request').at(-1)!.detail)).toMatchObject({ moveId: m.id, reason: 'incompatible', rule: 'camera_host', detail: want, phase: 'rejected' });
    expect(got(tgt.client, 'move.offer')).toHaveLength(0);
    // A repeated request event changes nothing.
    request(src, tgt.proxyId, { requestId, conn: { host: '192.0.2.11' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(moves()).toHaveLength(1);
    expect(got(src.client, 'move.answer')).toHaveLength(1);
  });

  it("a protocol other than the registry's says both protocols", async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const a = await answerOf(src, request(src, tgt.proxyId, { conn: { protocol: 'http' } }));
    expect(a).toMatchObject({ reason: 'incompatible', detail: 'registry protocol https, source reports http' });
    expect(moves()[0]).toMatchObject({ phase: 'rejected', detail: 'registry protocol https, source reports http' });
  });

  it("a precheck failure carries the failing rule's detail", async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    const i = s.built.camsInstances.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [src.accountId] });
    s.built.camsInstances.setRoute(ACTOR, i.id, src.proxyId, { url: null, hidden: false });
    const a = await answerOf(src, request(src, tgt.proxyId));
    const want = 'cams instances that see the source but not the target: cluster';
    expect(a).toMatchObject({ reason: 'not_routed', detail: want });
    expect(moves()[0]).toMatchObject({ phase: 'rejected', reason: 'not_routed', detail: want });
  });

  it('busy: a rejected row beside the active move, which stays the only active one', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    camera(src, 'cam2');
    tgt.client.dropCommands = 100;
    const first = request(src, tgt.proxyId);
    await until(() => moves().length === 1, 5000, 'first');
    const second = request(src, tgt.proxyId, { camera: 'cam2' });
    expect(await answerOf(src, second)).toMatchObject({ reason: 'busy', detail: 'a move is open on the source, target' });
    expect(s.built.moves.store.active().map((m) => m.requestId)).toEqual([first]);
    expect(moves().find((m) => m.requestId === second)).toMatchObject({ phase: 'rejected', reason: 'busy' });
  });

  it('no row where none can be: a camera not in the registry, a target of another account', async () => {
    const src = await proxy();
    const tgt = await proxy();
    const other = await proxy({ account: 'other' });
    camera(src);
    expect(await answerOf(src, request(src, tgt.proxyId, { camera: 'nope' }))).toMatchObject({ reason: 'not_registered' });
    expect(await answerOf(src, request(src, other.proxyId))).toMatchObject({ reason: 'other_account' });
    expect(moves()).toHaveLength(0);
  });

  it('a newly created move publishes a live move event', async () => {
    const src = await proxy();
    const tgt = await proxy();
    camera(src);
    tgt.client.dropCommands = 100;
    request(src, tgt.proxyId);
    await until(() => moves().length === 1, 5000, 'move');
    expect(published).toContain(moves()[0].id);
  });
});
