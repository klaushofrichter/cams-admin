// The Commands service (migration spec §7, plan Task 5): signed commands,
// one in flight per proxy, retries with the same cmdId, verified results,
// expiry. A real server on a fake clock and the test client as a P2 proxy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { keyFromSeed, privateFromB64, publicFromB64, sign, signEnvelope, signedText, verifyEnvelope } from '../server/crypto/ed25519';
import { readEpoch } from '../server/db/open';
import type { ProxyClient, KeyFile } from '../test-client/client';
import { RefProxyConfig } from '../test-client/config';
import { summariseArgs, requiredEntries } from '../server/commands/service';
import vectors from '../contract/v1/vectors.json';

const V1 = join(__dirname, '../contract/v1/strict');
const ajv = new Ajv2020({ strict: true });
for (const f of readdirSync(V1).filter((x) => x.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(V1, f), 'utf8')));
const strict = (name: string) => (m: unknown) => ajv.validate(`https://cams-admin.skylar.technology/contract/v1/strict/${name}.schema.json`, m);

const ACTOR = 'admin@example.com';
const ARGS = (revision: number, n = 1) => ({
  v: 1, revision,
  tokens: Array.from({ length: n }, (_, i) => ({ id: `tok_${String(revision * 100 + i).padStart(20, '0')}`, kind: 'client', hash: `sha256:${(revision * 100 + i).toString(16).padStart(64, '0')}`, label: `t${i}`, retireAt: null })),
});

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

// An enrolled proxy and its test client; ready when cams-admin has its command report.
async function proxy(o: { commands?: { allow: string[]; paused?: boolean; config?: RefProxyConfig } | null; start?: boolean } = {}) {
  const p = await enrolled(s, `cmd${n++}`);
  const commands = o.commands === undefined ? { allow: ['tokens.apply'] } : o.commands;
  const client = makeClient(p.key, commands ? { commands } : {});
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.cameras.length, 5000, 'connected');
  if (commands) await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { ...p, client, acc: p.accountId, prx: p.proxyId };
}
const cmds = () => s.built.commands;
const auditFor = (action: string) => s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string; actor: string }[];
const stateOf = (acc: string, prx: string, id: string) => cmds().get(acc, prx, id).state;

// A raw authenticated socket for a proxy (to send hostile results).
async function rawLive(key: KeyFile) {
  const ws = new WebSocket(s.wsUrl, ['cams-admin.v1']);
  const q: any[] = [];
  ws.on('message', (d) => q.push(JSON.parse(String(d))));
  ws.on('error', () => undefined);
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await until(() => q.length > 0);
  const ch = q.shift();
  let seq = 0;
  const env = (type: string, body: object, extra: object = {}) => { seq++; return { v: 1, type, id: '01K6' + String(Date.now()).padStart(15, '0') + String(seq).padStart(7, '0'), seq, ts: Date.now(), ...extra, body }; };
  const ts = Date.now();
  ws.send(JSON.stringify(env('hello', { proxyId: key.proxyId, keyId: key.keyId, connId: ch.body.connId, nonce: ch.body.nonce, ts, version: 'raw', capabilities: ['status', 'commands'] }, { sig: sign(privateFromB64(key.privateKey), signedText.hello(ch.body.connId, ch.body.nonce, key.proxyId, key.keyId, ts)) })));
  await until(() => q.some((m) => m.type === 'welcome'));
  const sendSigned = (body: object, priv: string, extra: object = { re: '01K6' + '0'.repeat(22) }) => {
    const m = env('result', body, extra);
    ws.send(JSON.stringify({ ...m, sig: signEnvelope(privateFromB64(priv), m) }));
  };
  return { ws, connId: ch.body.connId as string, closed, sendSigned, q };
}

describe('commands', () => {
  it('create → sent → received → done; the stored evidence verifies with the proxy key', async () => {
    const { acc, prx, client } = await proxy();
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(1));
    expect(row).toMatchObject({ state: 'queued', attempts: 0, actor: ACTOR, command: 'tokens.apply' });
    await until(() => stateOf(acc, prx, row.id) === 'done');
    const done = cmds().get(acc, prx, row.id);
    expect(done).toMatchObject({ attempts: 1, outcomeCode: null, result: { revision: 1, applied: true } });
    expect(verifyEnvelope(publicFromB64(client['o'].key.publicKey), done.resultEnvelope as never)).toBe(true);
    expect(auditFor('command-create')).toHaveLength(1);
    expect(auditFor('command-result')).toMatchObject([{ outcome: 'ok' }]);
    // The API view never carries a full hash: args are summarised.
    expect(JSON.stringify(done.args)).not.toMatch(/sha256:[0-9a-f]{16}/);
    expect(JSON.stringify(auditFor('command-create'))).not.toMatch(/sha256:[0-9a-f]{16}/);
    expect(cmds().list(acc, prx, {}).items.map((r) => r.id)).toEqual([row.id]);
  });

  it('the command on the wire validates against the strict command schema and carries the connection binding', async () => {
    const { acc, prx, client } = await proxy();
    cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(1));
    await until(() => client.receivedCommands.length === 1);
    const m = client.receivedCommands[0];
    expect(strict('command')(m), JSON.stringify(ajv.errors)).toBe(true);
    expect(m.body).toMatchObject({ proxyId: prx, connId: client.connId, cmdId: expect.stringMatching(/^cmd_/), actor: ACTOR });
    expect(m.body.exp - m.ts).toBe(60_000);
  });

  it('no received within 10 s → re-sent with the same cmdId and a new envelope id', async () => {
    const { acc, prx, client } = await proxy();
    client.dropCommands = 1;
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(2));
    await until(() => stateOf(acc, prx, row.id) === 'sent' && client.receivedCommands.length === 1);
    clock.advance(9_000);
    cmds().tick();
    expect(stateOf(acc, prx, row.id)).toBe('sent');
    clock.advance(1_000);
    cmds().tick();
    await until(() => stateOf(acc, prx, row.id) === 'done');
    const sends = client.receivedCommands.filter((m) => m.body.cmdId === row.id);
    expect(sends).toHaveLength(2);
    expect(sends[0].id).not.toBe(sends[1].id);
    expect(cmds().get(acc, prx, row.id).attempts).toBe(2);
  });

  it('received, then the socket drops: re-sent on the next connection, answered as a duplicate, done once', async () => {
    const { acc, prx, client } = await proxy();
    client.dropAfterReceived = 1;
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(3));
    await until(() => stateOf(acc, prx, row.id) === 'done', 8000);
    await until(() => client.receivedCommands.filter((m) => m.body.cmdId === row.id).length === 2, 5000, 'resent');
    await new Promise((r) => setTimeout(r, 200));
    expect(client.executed.filter((x) => x === row.id)).toHaveLength(1);
    expect(auditFor('command-result').filter((a) => JSON.parse(a.detail).cmdId === row.id)).toHaveLength(1);
    expect(cmds().get(acc, prx, row.id)).toMatchObject({ state: 'done', result: { revision: 3 } });
  });

  it('a restart between received and done: the new process re-sends once, the duplicate answer finalises the row', async () => {
    const { acc, prx, client } = await proxy();
    client.dropAfterReceived = 1;
    client.debugHoldEvents = true;
    client.holdReconnect = true; // stays away until the restart: the row must stay `received`
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(3));
    await until(() => stateOf(acc, prx, row.id) === 'received' && client.state !== 'connected');
    s = await s.restart();
    client.release();
    await until(() => s.built.commands.get(acc, prx, row.id).state === 'done', 8000);
    expect(client.executed.filter((x) => x === row.id)).toHaveLength(1);
    expect(s.built.commands.get(acc, prx, row.id).attempts).toBe(2);
  });

  it('one in flight per proxy: a second command waits until the first is final', async () => {
    const { acc, prx, client } = await proxy();
    client.dropCommands = 1;
    const a = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(4));
    const b = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(5));
    await until(() => client.receivedCommands.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(client.receivedCommands.map((m) => m.body.cmdId)).toEqual([a.id]);
    expect(stateOf(acc, prx, b.id)).toBe('queued');
    clock.advance(10_000);
    cmds().tick();
    await until(() => stateOf(acc, prx, b.id) === 'done');
    expect(client.receivedCommands.map((m) => m.body.cmdId)).toEqual([a.id, a.id, b.id]);
  });

  it('a proxy without the commands capability: create() refuses 409 unsupported_by_proxy', async () => {
    const { acc, prx } = await proxy({ commands: null });
    expect(() => cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(1))).toThrow(expect.objectContaining({ status: 409, code: 'unsupported_by_proxy' }));
  });

  it('the proxy reports tokens.apply not allowed (or paused): 409 not_allowed_on_proxy / paused_on_proxy', async () => {
    const a = await proxy({ commands: { allow: [] } });
    expect(() => cmds().create(ACTOR, a.acc, a.prx, 'tokens.apply', ARGS(1))).toThrow(expect.objectContaining({ status: 409, code: 'not_allowed_on_proxy' }));
    const b = await proxy({ commands: { allow: ['tokens.apply'], paused: true } });
    expect(() => cmds().create(ACTOR, b.acc, b.prx, 'tokens.apply', ARGS(1))).toThrow(expect.objectContaining({ status: 409, code: 'paused_on_proxy' }));
    // An admin entry needs tokens.apply.admin.
    const args = ARGS(1);
    args.tokens[0].kind = 'admin';
    const c = await proxy();
    expect(() => cmds().create(ACTOR, c.acc, c.prx, 'tokens.apply', args)).toThrow(expect.objectContaining({ status: 409, code: 'not_allowed_on_proxy' }));
    expect(() => cmds().create(ACTOR, c.acc, c.prx, 'tokens.apply', { v: 1, revision: 0, tokens: [] })).toThrow(expect.objectContaining({ status: 400, code: 'invalid_args' }));
    expect(s.built.db.prepare('SELECT count(*) n FROM commands').get()).toEqual({ n: 0 });
  });

  it('another account\'s proxy: 404', async () => {
    const { prx } = await proxy();
    const other = await s.api('POST', '/accounts', { name: 'other', displayName: 'O' });
    expect(() => cmds().create(ACTOR, other.id, prx, 'tokens.apply', ARGS(1))).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => cmds().list(other.id, prx, {})).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('a refused result: state refused with the nack code; never re-sent', async () => {
    const { acc, prx, client } = await proxy();
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(1));
    client.commands!.paused = true; // after cams-admin's pre-check, before the proxy sees the command
    await until(() => stateOf(acc, prx, row.id) === 'refused');
    expect(cmds().get(acc, prx, row.id)).toMatchObject({ outcomeCode: 'paused' });
    clock.advance(20_000);
    cmds().tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(client.receivedCommands.filter((m) => m.body.cmdId === row.id)).toHaveLength(1);
    expect(auditFor('command-result')).toMatchObject([{ outcome: 'refused' }]);
  });

  it('offline for 15 min: queued → expired; sent without a final → unknown; a late done still finalises', async () => {
    const a = await proxy();
    await a.client.stop('shutdown');
    const q = cmds().create(ACTOR, a.acc, a.prx, 'tokens.apply', ARGS(1));
    const b = await proxy();
    b.client.dropCommands = 1;
    const sent = cmds().create(ACTOR, b.acc, b.prx, 'tokens.apply', ARGS(1));
    await until(() => stateOf(b.acc, b.prx, sent.id) === 'sent');
    const wire = b.client.receivedCommands[0];
    clock.advance(15 * 60_000 - 1);
    cmds().tick();
    expect(stateOf(a.acc, a.prx, q.id)).toBe('queued');
    // Re-sends after 10 s go on meanwhile; the proxy keeps dropping them.
    b.client.dropCommands = 1000;
    clock.advance(1);
    cmds().tick();
    expect(stateOf(a.acc, a.prx, q.id)).toBe('expired');
    expect(stateOf(b.acc, b.prx, sent.id)).toBe('unknown');
    expect(auditFor('command-expired').map((x) => JSON.parse(x.detail).state).sort()).toEqual(['expired', 'unknown']);
    // The proxy's (late) done on its live connection.
    const raw = await rawLive(b.key);
    raw.sendSigned({ proxyId: b.prx, connId: raw.connId, cmdId: sent.id, phase: 'done', status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] } }, b.key.privateKey, { re: wire.id });
    await until(() => stateOf(b.acc, b.prx, sent.id) === 'done');
    expect(JSON.parse(auditFor('command-result').at(-1)!.detail)).toMatchObject({ late: true });
    raw.ws.terminate();
  });

  it('results that must be dropped: bad signature, another proxy\'s cmdId, wrong connId, wrong proxyId', async () => {
    const a = await proxy();
    a.client.dropCommands = 1000;
    const row = cmds().create(ACTOR, a.acc, a.prx, 'tokens.apply', ARGS(1));
    await until(() => stateOf(a.acc, a.prx, row.id) === 'sent');
    const b = await proxy();
    await b.client.stop('shutdown');
    const raw = await rawLive(b.key);
    const other = keyFromSeed(vectors.keys.other.seedHex).privateKeyPkcs8B64;
    const body = (o: object) => ({ proxyId: b.prx, connId: raw.connId, cmdId: row.id, phase: 'done', status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] }, ...o });
    raw.sendSigned(body({}), other); // bad signature
    raw.sendSigned(body({}), b.key.privateKey); // A's cmdId from B: unknown_command
    raw.sendSigned(body({ connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' }), b.key.privateKey); // wrong connId
    raw.sendSigned(body({ proxyId: a.prx }), b.key.privateKey); // A's proxyId on B's connection (B's key)
    raw.sendSigned(body({ proxyId: a.prx }), a.key.privateKey); // signed with A's key on B's connection
    await until(() => auditFor('command-result').length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    expect(stateOf(a.acc, a.prx, row.id)).toBe('sent');
    const reasons = auditFor('command-result').map((x) => ({ outcome: x.outcome, reason: JSON.parse(x.detail).reason }));
    expect(reasons.every((r) => r.outcome === 'refused')).toBe(true);
    expect(reasons.map((r) => r.reason).sort()).toEqual(['bad_signature', 'unknown_command', 'wrong_target']); // throttled: one per reason
    expect(raw.ws.readyState).toBe(WebSocket.OPEN);
    raw.ws.terminate();
  });

  it('the proxy\'s own correctly signed result replayed with an old connId on a new connection is dropped', async () => {
    const a = await proxy();
    a.client.dropCommands = 1000;
    const row = cmds().create(ACTOR, a.acc, a.prx, 'tokens.apply', ARGS(1));
    await until(() => stateOf(a.acc, a.prx, row.id) === 'sent');
    const oldConn = a.client.connId!;
    await a.client.stop('shutdown');
    const raw = await rawLive(a.key);
    expect(raw.connId).not.toBe(oldConn);
    raw.sendSigned({ proxyId: a.prx, connId: oldConn, cmdId: row.id, phase: 'done', status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] } }, a.key.privateKey);
    await until(() => auditFor('command-result').length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(stateOf(a.acc, a.prx, row.id)).toBe('sent');
    expect(JSON.parse(auditFor('command-result')[0].detail)).toMatchObject({ reason: 'wrong_target' });
    raw.ws.terminate();
  });

  it('more than 20 dropped results on one connection close it (4400)', async () => {
    const b = await proxy();
    await b.client.stop('shutdown');
    const raw = await rawLive(b.key);
    for (let i = 0; i < 21; i++) raw.sendSigned({ proxyId: b.prx, connId: raw.connId, cmdId: 'cmd_ZZZZZZZZZZZZZZZZZZZZ', phase: 'received' }, b.key.privateKey);
    expect(await raw.closed).toBe(4400);
  });

  it('60 commands per minute per proxy, then 429 rate_limited', async () => {
    const { acc, prx, client } = await proxy();
    client.dropCommands = 1000;
    for (let i = 0; i < 60; i++) cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(i + 1));
    expect(() => cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(61))).toThrow(expect.objectContaining({ status: 429, code: 'rate_limited' }));
    clock.advance(60_000);
    expect(cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(62)).state).toBe('queued');
  });

  it('write budget: one command end to end costs at most 4 write transactions (create, sent, received, done)', async () => {
    const { acc, prx } = await proxy();
    const before = readEpoch(s.built.db);
    const row = cmds().create(ACTOR, acc, prx, 'tokens.apply', ARGS(1));
    await until(() => stateOf(acc, prx, row.id) === 'done');
    await new Promise((r) => setTimeout(r, 300)); // heartbeats meanwhile write nothing
    expect(readEpoch(s.built.db) - before).toBeLessThanOrEqual(4);
  });
});

describe('commands: the P3 wire commands through the same service', () => {
  const REV = `sha256:${'a'.repeat(64)}`;
  const p3 = () => proxy({ commands: { allow: ['config.get', 'config.set', 'camera.action:camera-test'], config: new RefProxyConfig() } });
  const final = async (acc: string, prx: string, id: string) => {
    await until(() => ['done', 'refused', 'failed'].includes(stateOf(acc, prx, id)), 5000, 'final');
    return cmds().get(acc, prx, id);
  };
  it('config.get ends done with the view in result', async () => {
    const p = await p3();
    const r = cmds().create(ACTOR, p.acc, p.prx, 'config.get', { v: 1 });
    expect(r.dryRun).toBe(false);
    const f = await final(p.acc, p.prx, r.id);
    expect(f.state).toBe('done');
    expect((f.result as any).paths['sse.pingS']).toEqual({ v: 30, s: 'default' });
  });
  it('camera.action needs its own entry: camera-reboot → 409 not_allowed_on_proxy; camera-test → done', async () => {
    const p = await p3();
    expect(() => cmds().create(ACTOR, p.acc, p.prx, 'camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' })).toThrow(/not_allowed_on_proxy/);
    const r = cmds().create(ACTOR, p.acc, p.prx, 'camera.action', { v: 1, camera: 'cam1', action: 'camera-test' });
    expect((await final(p.acc, p.prx, r.id)).state).toBe('done');
    expect(r.args).toEqual({ v: 1, camera: 'cam1', action: 'camera-test' });
  });
  it('a config.set dry run row has dryRun true; previewOf is stored and used once (409 preview_used)', async () => {
    const p = await p3();
    const view = (await final(p.acc, p.prx, cmds().create(ACTOR, p.acc, p.prx, 'config.get', { v: 1 }).id)).result as any;
    const pv = cmds().create(ACTOR, p.acc, p.prx, 'config.set', { v: 1, dryRun: true, baseRevision: view.revision, set: { 'sse.pingS': 7 } });
    expect(pv.dryRun).toBe(true);
    expect(pv.previewOf).toBeNull();
    await final(p.acc, p.prx, pv.id);
    expect(cmds().usedPreview(pv.id)).toBe(false);
    expect(cmds().getRaw(p.acc, p.prx, pv.id).rawArgs).toEqual({ v: 1, dryRun: true, baseRevision: view.revision, set: { 'sse.pingS': 7 } });
    const a = cmds().create(ACTOR, p.acc, p.prx, 'config.set', { v: 1, dryRun: false, baseRevision: view.revision, set: { 'sse.pingS': 7 } }, { previewOf: pv.id });
    expect(a).toMatchObject({ dryRun: false, previewOf: pv.id });
    expect(cmds().usedPreview(pv.id)).toBe(true);
    const before = (s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n;
    expect(() => cmds().create(ACTOR, p.acc, p.prx, 'config.set', { v: 1, dryRun: false, baseRevision: view.revision, set: { 'sse.pingS': 7 } }, { previewOf: pv.id })).toThrow(/preview_used/);
    expect((s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n).toBe(before);
    expect(cmds().hasOpen(p.prx, 'config.set')).toBe(true);
    await final(p.acc, p.prx, a.id);
    expect(cmds().hasOpen(p.prx, 'config.set')).toBe(false);
    expect(() => cmds().getRaw(p.acc, 'prx_ZZZZZZZZZZZZZZZZZZZZ', pv.id)).toThrow();
  });
  it('a conflict answer keeps its name: state failed, outcomeCode conflict', async () => {
    const p = await p3();
    const r = cmds().create(ACTOR, p.acc, p.prx, 'config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': 7 } });
    const f = await final(p.acc, p.prx, r.id);
    expect([f.state, f.outcomeCode]).toEqual(['failed', 'conflict']);
    expect((f.result as any).current['sse.pingS']).toEqual({ v: 30, s: 'default' });
  });
  it('the args summary: config values clamped to 200 characters; camera actions name camera and action', () => {
    const long = 'x'.repeat(512);
    const sum = summariseArgs('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'cameras.cam1.name': long, 'sse.pingS': 7 } });
    expect(sum).toEqual({ v: 1, dryRun: true, baseRevision: REV.slice(0, 15), set: { 'cameras.cam1.name': long.slice(0, 200), 'sse.pingS': 7 } });
    expect(summariseArgs('config.unset', { v: 1, dryRun: false, baseRevision: REV, paths: ['sse.pingS'] })).toEqual({ v: 1, dryRun: false, paths: ['sse.pingS'] });
    expect(summariseArgs('config.rollback', { v: 1, dryRun: true, cmdId: 'cmd_0123456789ABCDEFGHJK' })).toEqual({ v: 1, dryRun: true, cmdId: 'cmd_0123456789ABCDEFGHJK' });
    expect(summariseArgs('camera.action', { v: 1, camera: null, action: 'retention-run' })).toEqual({ v: 1, camera: null, action: 'retention-run' });
    expect(summariseArgs('camera.name.set', { v: 1, camera: 'cam1', name: 'Porch' })).toEqual({ v: 1, camera: 'cam1', name: 'Porch' });
    expect(summariseArgs('proxy.restart', { v: 1 })).toEqual({ v: 1 });
    expect(requiredEntries('camera.action', { action: 'camera-reboot' })).toEqual(['camera.action:camera-reboot']);
    expect(requiredEntries('config.set', {})).toEqual(['config.set']);
  });
});
