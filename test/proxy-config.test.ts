// ProxyConfig (migration spec §8.1–§8.5, P3 plan Task 4): the last reported
// view per proxy, its triggers, dry-run previews, apply by preview id (R3-15),
// cams-admin's own path pre-check (R3-16) and rollback (R3-21). A real server
// on a fake clock and the test client with the reference proxy (RefProxyConfig).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { readEpoch } from '../server/db/open';
import { RefProxyConfig } from '../test-client/config';
import type { ProxyClient } from '../test-client/client';
import { isRemoteSettable, narrowingOk, narrowReason, patternOf } from '../server/config/narrow';

const ACTOR = 'admin@example.com';
const ACTOR2 = 'other@example.com';
const ALLOW = ['config.get', 'config.set', 'config.unset', 'config.rollback'];
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

async function proxy(o: { allow?: string[]; ref?: RefProxyConfig; account?: string } = {}) {
  const p = await enrolled(s, `cfg${n++}`, o.account);
  const ref = o.ref ?? new RefProxyConfig({ cameras: ['cam1'] });
  const client = makeClient(p.key, { commands: { allow: o.allow ?? ALLOW, config: ref } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { ...p, client, ref, acc: p.accountId, prx: p.proxyId };
}
const C = () => s.built.config;
const cmds = () => s.built.commands;
const count = (sql: string, ...a: unknown[]) => (s.built.db.prepare(sql).get(...(a as string[])) as { n: number }).n;
const countCommands = () => count('SELECT count(*) n FROM commands');
const final = async (acc: string, prx: string, id: string) => {
  await until(() => !['queued', 'sent', 'received'].includes(cmds().get(acc, prx, id).state), 5000, `final ${id}`);
  return cmds().get(acc, prx, id);
};
const viewed = (acc: string, prx: string) => until(() => C().state(acc, prx).view !== null, 5000, 'view');
// The minute cap on automatic reads: let the next automatic one through.
const nextMinute = () => { clock.advance(61_000); C().tick(); };

describe('narrow.ts: the contract rules for the pre-check', () => {
  it('patternOf, isRemoteSettable = remote-settable.json ∩ the proxy\'s settable', () => {
    expect(patternOf('cameras.cam1.stills.enabled')).toBe('cameras.*.stills.enabled');
    expect(patternOf('sse.pingS')).toBe('sse.pingS');
    const settable = { 'sse.pingS': { type: 'integer' as const }, 'camsAdmin.url': { type: 'string' as const }, 'cameras.*.name': { type: 'string' as const } };
    expect(isRemoteSettable('sse.pingS', settable)).toBe(true);
    expect(isRemoteSettable('cameras.cam1.name', settable)).toBe(true);
    expect(isRemoteSettable('camsAdmin.url', settable)).toBe(false);
    expect(isRemoteSettable('sse.maxClients', settable)).toBe(false);
  });
  it('narrowingOk: spending only down (0 = no cap for the two caps), data kept only longer (unset size cap = no cap)', () => {
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 1000, 500)).toBe(true);
    expect(narrowingOk('analytics.googleVision.monthlyLimit', 1000, 5000)).toBe(false);
    expect(narrowingOk('analytics.googleVision.dailyCap', 0, 50)).toBe(true);
    expect(narrowingOk('analytics.googleVision.dailyCap', 50, 0)).toBe(false);
    expect(narrowingOk('analytics.googleVision.enabled', true, false)).toBe(true);
    expect(narrowingOk('analytics.googleVision.enabled', false, true)).toBe(false);
    expect(narrowingOk('retention.clipsDays', 90, 120)).toBe(true);
    expect(narrowingOk('retention.clipsDays', 90, 30)).toBe(false);
    expect(narrowingOk('retention.clipsDays', 90, undefined)).toBe(false); // Reset: cams-admin can't know the value it restores
    expect(narrowingOk('ftp.maxGB', undefined, 5)).toBe(false);
    expect(narrowingOk('ftp.maxGB', 5, undefined)).toBe(true);
    expect(narrowingOk('ftp.maxGB', 5, 10)).toBe(true);
    expect(narrowingOk('sse.pingS', 30, 5)).toBe(true);
    expect(narrowReason('retention.auditDays')).toBe('a remote change may only keep data longer');
    expect(narrowReason('analytics.googleVision.checksPerDay')).toBe('a remote change may only lower spending');
  });
});

describe('ProxyConfig', () => {
  it('a proxy that allows config.get is read once; the view is stored; heartbeats with the same revision write nothing', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    const st = C().state(p.acc, p.prx);
    expect(st.view!.paths['sse.pingS']).toEqual({ v: 30, s: 'default' });
    expect(st.view!.revision).toBe(p.ref.revision());
    expect(st).toMatchObject({ changedOnProxy: false, fetching: null, allow: ALLOW });
    expect(count('SELECT count(*) n FROM commands WHERE command = ?', 'config.get')).toBe(1);
    const before = readEpoch(s.built.db);
    const sent = p.client.stats.sent;
    await until(() => p.client.stats.sent >= sent + 5, 5000, 'heartbeats');
    nextMinute();
    expect(readEpoch(s.built.db)).toBe(before);
    expect(count('SELECT count(*) n FROM commands WHERE command = ?', 'config.get')).toBe(1);
  });

  it('a proxy that does not allow config.get is never read', async () => {
    const p = await proxy({ allow: ['config.set'] });
    const sent = p.client.stats.sent;
    await until(() => p.client.stats.sent >= sent + 3);
    expect(countCommands()).toBe(0);
    expect(C().state(p.acc, p.prx)).toMatchObject({ view: null, allow: ['config.set'] });
    expect(() => C().refresh(ACTOR, p.acc, p.prx)).toThrow(/not_allowed_on_proxy/);
  });

  it('a local edit (new configRevision in the heartbeat) → changedOnProxy, then one automatic config.get within the minute cap', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    p.ref.localEdit({ 'sse.pingS': 9 });
    await until(() => C().state(p.acc, p.prx).changedOnProxy, 5000, 'changedOnProxy');
    expect(count('SELECT count(*) n FROM commands WHERE command = ?', 'config.get')).toBe(1); // within the minute: deferred
    nextMinute();
    await until(() => C().state(p.acc, p.prx).view?.paths['sse.pingS'].v === 9, 5000, 're-read');
    expect(C().state(p.acc, p.prx).changedOnProxy).toBe(false);
    expect(count('SELECT count(*) n FROM commands WHERE command = ?', 'config.get')).toBe(2);
    expect((s.built.db.prepare(`SELECT actor FROM commands WHERE command = 'config.get'`).all() as { actor: string }[]).map((x) => x.actor)).toEqual(['system', 'system']);
  });

  it('Reload: refresh by a person; 409 already_fetching while one is open', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    p.client.dropCommands = 1;
    const r = C().refresh(ACTOR, p.acc, p.prx);
    expect(C().state(p.acc, p.prx).fetching).toBe(r.commandId);
    expect(() => C().refresh(ACTOR, p.acc, p.prx)).toThrow(/already_fetching/);
  });

  it('preview → done dry run with the diff; apply(previewId) → the proxy changed; a re-read follows', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } });
    const done = await final(p.acc, p.prx, pv.commandId);
    expect(done).toMatchObject({ state: 'done', dryRun: true, result: { changes: [{ path: 'sse.pingS', from: 30, to: 7 }] } });
    expect(p.ref.current('sse.pingS')).toBe(30);
    const a = C().apply(ACTOR, p.acc, p.prx, pv.commandId);
    expect(cmds().get(p.acc, p.prx, a.commandId)).toMatchObject({ dryRun: false, previewOf: pv.commandId, args: { set: { 'sse.pingS': 7 } } });
    await final(p.acc, p.prx, a.commandId);
    expect(p.ref.current('sse.pingS')).toBe(7);
    await until(() => C().state(p.acc, p.prx).view?.paths['sse.pingS'].v === 7, 5000, 're-read after apply');
    expect(C().state(p.acc, p.prx).view!.paths['sse.pingS']).toMatchObject({ s: 'override', by: { cmdId: a.commandId, actor: ACTOR } });
  });

  it('Review Focus 1: apply without a matching preview is refused and creates no command', async () => {
    const p = await proxy();
    const q = await proxy({ account: 'other' });
    await viewed(p.acc, p.prx);
    const before = countCommands();
    expect(() => C().apply(ACTOR, p.acc, p.prx, 'cmd_0123456789ABCDEFGHJK')).toThrow(/not_found/);
    expect(() => C().apply(ACTOR, p.acc, p.prx, 42)).toThrow(/invalid/);
    // A config.get row is no preview.
    const get = s.built.db.prepare(`SELECT id FROM commands WHERE command = 'config.get'`).get() as { id: string };
    expect(() => C().apply(ACTOR, p.acc, p.prx, get.id)).toThrow(/preview_required/);
    expect(countCommands()).toBe(before);
    // By another sysadmin.
    const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } });
    await final(p.acc, p.prx, pv.commandId);
    expect(() => C().apply(ACTOR2, p.acc, p.prx, pv.commandId)).toThrow(/preview_required/);
    // Another account's proxy in the URL.
    expect(() => C().apply(ACTOR, q.acc, q.prx, pv.commandId)).toThrow(/not_found/);
    // Older than 10 minutes.
    clock.advance(10 * 60_000 + 1);
    expect(() => C().apply(ACTOR, p.acc, p.prx, pv.commandId)).toThrow(/preview_stale/);
    expect(countCommands()).toBe(before + 1);
    // The same preview twice → preview_used (also once the view moved on).
    const pv4 = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 6 } });
    await final(p.acc, p.prx, pv4.commandId);
    const a = C().apply(ACTOR, p.acc, p.prx, pv4.commandId);
    expect(() => C().apply(ACTOR, p.acc, p.prx, pv4.commandId)).toThrow(/preview_used/);
    await final(p.acc, p.prx, a.commandId);
    await until(() => C().state(p.acc, p.prx).view?.paths['sse.pingS'].v === 6, 5000, 're-read');
    expect(() => C().apply(ACTOR, p.acc, p.prx, pv4.commandId)).toThrow(/preview_used/);
    // A preview's apply is no preview.
    expect(() => C().apply(ACTOR, p.acc, p.prx, a.commandId)).toThrow(/preview_required/);
  });

  it('a dry run that answered conflict is no preview (preview_required)', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    // Edit, then preview against the old view at once (before the heartbeat's re-read).
    p.ref.localEdit({ 'sse.maxClients': 25 });
    const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 8 } });
    const f = await final(p.acc, p.prx, pv.commandId);
    expect([f.state, f.outcomeCode]).toEqual(['failed', 'conflict']);
    expect(() => C().apply(ACTOR, p.acc, p.prx, pv.commandId)).toThrow(/preview_required/);
  });

  it('R3-16: a path outside remote-settable ∩ settable is 400 not_remote_settable before any command; a narrow path widened is 400 widening_local_only', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    const before = countCommands();
    for (const set of [{ 'cameras.cam1.host': '192.0.2.9' }, { 'camsAdmin.url': 'https://x.example' }, { 'server.port': 1 }, { 'nosuch.x': 1 }, { Sse: 1 }])
      expect(() => C().preview(ACTOR, p.acc, p.prx, { set }), JSON.stringify(set)).toThrow(/not_remote_settable/);
    expect(() => C().preview(ACTOR, p.acc, p.prx, { set: { 'analytics.googleVision.monthlyLimit': 5000 } })).toThrow(/widening_local_only/);
    // coordinator ruling: no remote write may make the proxy delete data
    for (const path of ['retention.clipsDays', 'retention.stillsDays', 'retention.eventsDays', 'retention.auditDays', 'ftp.maxGB'])
      expect(() => C().preview(ACTOR, p.acc, p.prx, { set: { [path]: 1 } }), path).toThrow(/widening_local_only/);
    for (const path of ['storage.maxPercent', 'storage.maxBytes', 'storage.minFreeBytes', 'storage.keepHours.clips', 'cameras.cam1.storage.sharePercent']) {
      let err: any;
      try { C().preview(ACTOR, p.acc, p.prx, { set: { [path]: 10 } }); } catch (e) { err = e; }
      expect(err, path).toMatchObject({ status: 400, code: 'not_remote_settable', field: 'storage settings are local only' });
    }
    expect(() => C().preview(ACTOR, p.acc, p.prx, { unset: ['retention.clipsDays'] })).toThrow(/widening_local_only/); // the reference proxy holds it above the default
    expect(() => C().preview(ACTOR, p.acc, p.prx, { set: { 'ftp.publicHost': 'x.example.net' } })).toThrow(/not_remote_settable/);
    for (const bad of [null, {}, { set: {} }, { set: { 'sse.pingS': null } }, { set: { 'sse.pingS': { a: 1 } } }, { unset: [] }, { unset: ['sse.pingS', 'sse.pingS'] }, { set: { 'sse.pingS': 1 }, unset: ['sse.pingS'] }, { set: { 'sse.pingS': 'x'.repeat(513) } }])
      expect(() => C().preview(ACTOR, p.acc, p.prx, bad), JSON.stringify(bad)).toThrow(/invalid/);
    expect(countCommands()).toBe(before);
    expect(C().preview(ACTOR, p.acc, p.prx, { set: { 'retention.clipsDays': 120 } }).commandId).toMatch(/^cmd_/); // raising is fine
    expect(countCommands()).toBe(before + 1);
  });

  it('no view yet: preview is 409 no_view', async () => {
    const p = await proxy({ allow: ['config.set'] });
    expect(() => C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } })).toThrow(/no_view/);
  });

  it('Review Focus 2: a local edit after the preview → preview_stale once re-read; if the apply already went out → conflict, a re-read, the local value kept', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } });
    await final(p.acc, p.prx, pv.commandId);
    // The apply goes out before cams-admin re-read the local edit: the proxy answers conflict.
    p.ref.localEdit({ 'sse.pingS': 9 });
    const a = C().apply(ACTOR, p.acc, p.prx, pv.commandId);
    const f = await final(p.acc, p.prx, a.commandId);
    expect([f.state, f.outcomeCode]).toEqual(['failed', 'conflict']);
    expect(f.result).toMatchObject({ current: { 'sse.pingS': { v: 9, s: 'override' } } });
    expect(p.ref.current('sse.pingS')).toBe(9);
    // a conflict ends → an automatic re-read (not held by the minute cap)
    await until(() => C().state(p.acc, p.prx).view?.paths['sse.pingS'].v === 9, 5000, 're-read after conflict');
    // A preview made before another local edit is stale once the edit is re-read.
    const pv2 = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 6 } });
    await final(p.acc, p.prx, pv2.commandId);
    p.ref.localEdit({ 'sse.pingS': 11 });
    await until(() => C().state(p.acc, p.prx).changedOnProxy, 5000, 'changed');
    nextMinute();
    await until(() => C().state(p.acc, p.prx).view?.paths['sse.pingS'].v === 11, 5000, 're-read');
    expect(() => C().apply(ACTOR, p.acc, p.prx, pv2.commandId)).toThrow(/preview_stale/);
  });

  it('Review Focus 3 (over the channel): __proto__, HTML, settable entries for camsAdmin.url and cameras.*.host → stored as text, never editable', async () => {
    const p = await proxy();
    await viewed(p.acc, p.prx);
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) paths[`sse.p${i}`] = { v: 'x'.repeat(500), s: 'file' };
    Object.defineProperty(paths, '__proto__', { value: { v: 1, s: 'file' }, enumerable: true });
    paths['sse.pingS'] = { v: '<script>alert(1)</script>', s: 'file' };
    const hostile = { revision: `sha256:${'c'.repeat(64)}`, schema: 1, cameras: ['cam1'], omittedCameras: [], paths, settable: { 'sse.pingS': { type: 'integer' }, 'camsAdmin.url': { type: 'string' }, 'cameras.*.host': { type: 'string' }, 'storage.maxPercent': { type: 'integer' } } };
    p.client.overrideConfigGetResult = hostile;
    await final(p.acc, p.prx, C().refresh(ACTOR, p.acc, p.prx).commandId);
    await until(() => C().state(p.acc, p.prx).view?.revision === hostile.revision, 5000, 'hostile view stored');
    const st = C().state(p.acc, p.prx);
    expect(Object.keys(st.view!.settable)).toEqual(['sse.pingS']);
    expect(Object.getPrototypeOf(st.view!.paths)).toBe(Object.prototype);
    expect(Object.keys(st.view!.paths)).not.toContain('__proto__');
    expect(st.view!.paths['sse.pingS'].v).toBe('<script>alert(1)</script>'); // stored as text; the UI renders text
    for (const v of Object.values(st.view!.paths)) if (typeof v.v === 'string') expect(v.v.length).toBeLessThanOrEqual(200);
    for (const set of [{ 'camsAdmin.url': 'https://evil.example' }, { 'cameras.cam1.host': '192.0.2.66' }, { 'storage.maxPercent': 10 }])
      expect(() => C().preview(ACTOR, p.acc, p.prx, { set }), JSON.stringify(set)).toThrow(/not_remote_settable/);
  });

  it('Review Focus 3 (storeView): 10 000 paths of 1 MiB strings, bad keys and a bad revision are clamped to ≤ 256 KiB or ignored, never refused', async () => {
    const p = await proxy({ allow: ['config.set'] });
    const big = 'x'.repeat(1 << 20);
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) paths[`sse.p${i}`] = { v: big, s: 'file', n: big, by: { cmdId: 'cmd_0123456789ABCDEFGHJK', actor: big, at: 1 } };
    paths['Bad.Key'] = { v: 1, s: 'file' };
    paths['sse.pingS'] = { v: 5, s: 'nonsense' };
    const settable: Record<string, unknown> = { 'sse.pingS': { type: 'integer', min: 5 }, 'camsAdmin.url': { type: 'string' }, 'sse.maxClients': { type: 'float' } };
    C().storeView(p.prx, 'cmd_0123456789ABCDEFGHJK', { revision: `sha256:${'e'.repeat(64)}`, cameras: Array.from({ length: 1000 }, (_, i) => `c${i}`), omittedCameras: [], paths, settable });
    const v = C().state(p.acc, p.prx).view!;
    expect(v.revision).toBe(`sha256:${'e'.repeat(64)}`);
    expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(262144);
    expect(v.clampedPaths).toBeGreaterThan(0);
    expect(v.cameras.length).toBeLessThanOrEqual(256);
    expect(v.settable).toEqual({ 'sse.pingS': { type: 'integer', min: 5 } });
    expect(v.paths['Bad.Key']).toBeUndefined();
    expect(v.paths['sse.pingS']).toBeUndefined(); // an unknown source: dropped
    expect((s.built.db.prepare('SELECT length(view) n FROM proxy_config WHERE proxy_id = ?').get(p.prx) as { n: number }).n).toBeLessThanOrEqual(262144);
    // not a view at all: ignored, the stored one kept
    for (const bad of [null, 'x', { revision: 'nope', paths: {}, settable: {} }, { revision: `sha256:${'f'.repeat(64)}` }]) C().storeView(p.prx, 'cmd_0123456789ABCDEFGHJK', bad);
    expect(C().state(p.acc, p.prx).view!.revision).toBe(`sha256:${'e'.repeat(64)}`);
    // the same view again writes nothing
    const before = readEpoch(s.built.db);
    C().storeView(p.prx, 'cmd_1123456789ABCDEFGHJK', { revision: `sha256:${'e'.repeat(64)}`, cameras: Array.from({ length: 1000 }, (_, i) => `c${i}`), omittedCameras: [], paths, settable });
    expect(readEpoch(s.built.db)).toBe(before);
  });

  it('Review Focus 5: rollback only of a real write of this proxy; a conflict answer names the paths changed since', async () => {
    const p = await proxy();
    const q = await proxy({ account: 'other' });
    await viewed(p.acc, p.prx);
    await viewed(q.acc, q.prx);
    const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } });
    await final(p.acc, p.prx, pv.commandId);
    const a = C().apply(ACTOR, p.acc, p.prx, pv.commandId);
    await final(p.acc, p.prx, a.commandId);
    // a dry run, a config.get, a conflict, a refused command → not_rollbackable
    const get = (s.built.db.prepare(`SELECT id FROM commands WHERE command = 'config.get' AND proxy_id = ?`).get(p.prx) as { id: string }).id;
    const bad = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 8 } });
    await final(p.acc, p.prx, bad.commandId);
    for (const id of [pv.commandId, get, bad.commandId]) expect(() => C().rollbackPreview(ACTOR, p.acc, p.prx, id), id).toThrow(/not_rollbackable/);
    p.client.refuseNext = { code: 'paused' };
    const refused = cmds().create(ACTOR, p.acc, p.prx, 'config.set', { v: 1, dryRun: false, baseRevision: p.ref.revision(), set: { 'sse.pingS': 9 } });
    await final(p.acc, p.prx, refused.id);
    expect(() => C().rollbackPreview(ACTOR, p.acc, p.prx, refused.id)).toThrow(/not_rollbackable/);
    // another proxy's or account's command → 404
    expect(() => C().rollbackPreview(ACTOR, q.acc, q.prx, a.commandId)).toThrow(/not_found/);
    expect(() => C().rollbackPreview(ACTOR, p.acc, p.prx, 'cmd_ZZZZZZZZZZZZZZZZZZZZ')).toThrow(/not_found/);
    // rollbackPreview → dry run diff; rollbackApply(previewId) → restored
    const rp = C().rollbackPreview(ACTOR, p.acc, p.prx, a.commandId);
    expect(await final(p.acc, p.prx, rp.commandId)).toMatchObject({ state: 'done', dryRun: true, result: { of: a.commandId, changes: [{ path: 'sse.pingS', from: 7, to: 30 }] } });
    expect(() => C().rollbackApply(ACTOR2, p.acc, p.prx, rp.commandId)).toThrow(/preview_required/);
    expect(() => C().rollbackApply(ACTOR, p.acc, p.prx, pv.commandId)).toThrow(/preview_required/); // a config.set preview is no rollback preview
    const ra = C().rollbackApply(ACTOR, p.acc, p.prx, rp.commandId);
    expect(await final(p.acc, p.prx, ra.commandId)).toMatchObject({ state: 'done', dryRun: false });
    expect(p.ref.current('sse.pingS')).toBe(30);
    expect(() => C().rollbackApply(ACTOR, p.acc, p.prx, rp.commandId)).toThrow(/preview_used/);
    // the rollback itself is a real write: rollbackable
    expect(C().rollbackPreview(ACTOR, p.acc, p.prx, ra.commandId).commandId).toMatch(/^cmd_/);
    // after a local edit of the same path → the proxy answers conflict, shown with current
    const pv5 = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.maxClients': 30 } });
    await until(() => !['queued', 'sent', 'received'].includes(cmds().get(p.acc, p.prx, pv5.commandId).state));
    await until(() => C().state(p.acc, p.prx).view?.revision === p.ref.revision(), 5000, 'view current');
    const pv6 = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.maxClients': 30 } });
    await final(p.acc, p.prx, pv6.commandId);
    const a6 = C().apply(ACTOR, p.acc, p.prx, pv6.commandId);
    await final(p.acc, p.prx, a6.commandId);
    p.ref.localEdit({ 'sse.maxClients': 40 });
    const rp6 = C().rollbackPreview(ACTOR, p.acc, p.prx, a6.commandId);
    expect(await final(p.acc, p.prx, rp6.commandId)).toMatchObject({ state: 'failed', outcomeCode: 'conflict', result: { current: { 'sse.maxClients': { v: 40, s: 'override' } } } });
  });

  it('write budget: 20 proxies heartbeating with a stable revision → zero writes from ProxyConfig after the first reads', async () => {
    const ps: Awaited<ReturnType<typeof proxy>>[] = [];
    for (let i = 0; i < 20; i++) ps.push(await proxy());
    for (const p of ps) await viewed(p.acc, p.prx);
    await until(() => ps.every((p) => !cmds().hasOpen(p.prx, 'config.get')));
    const before = readEpoch(s.built.db);
    const sent = ps.map((p) => p.client.stats.sent);
    await until(() => ps.every((p, i) => p.client.stats.sent >= sent[i] + 3), 10_000, 'heartbeats');
    for (let m = 0; m < 60; m++) nextMinute();
    expect(readEpoch(s.built.db)).toBe(before);
  });

  it('secret guard: a marker in the fake proxy\'s environment never reaches proxy_config, commands or the audit log', async () => {
    const MARK = 'SECRET-MARKER-7f3a9c';
    process.env.CAMPROXY_TEST_SECRET = MARK;
    try {
      const p = await proxy();
      await viewed(p.acc, p.prx);
      const pv = C().preview(ACTOR, p.acc, p.prx, { set: { 'sse.pingS': 7 } });
      await final(p.acc, p.prx, pv.commandId);
      await final(p.acc, p.prx, C().apply(ACTOR, p.acc, p.prx, pv.commandId).commandId);
      for (const t of ['proxy_config', 'commands', 'audit_log']) expect(JSON.stringify(s.built.db.prepare(`SELECT * FROM ${t}`).all()), t).not.toContain(MARK);
    } finally {
      delete process.env.CAMPROXY_TEST_SECRET;
    }
  });
});
