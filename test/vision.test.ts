// Vision management (design 2026-11-05-vision-management-design.md, cams-admin 1–4): the stored usage per
// proxy (proxy_analytics), Refresh (analytics.usage.get for every online proxy of the account), the monthly
// limit through config.set preview + apply server side, system admin only. A real server on a fake clock and
// the test client with the reference proxy (RefProxyConfig answers analytics.usage.get and the ceiling rules).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { RefProxyConfig } from '../test-client/config';
import type { ProxyClient } from '../test-client/client';
import { PROVIDER_CONFIG, cleanUsage } from '../server/vision/service';
import { usageGetPublic } from '../server/commands/service';

const ALLOW = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'analytics.usage.get'];
const SYS = { actor: 'admin@example.com', sysadmin: true };
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

async function proxy(o: { allow?: string[]; ref?: RefProxyConfig; account?: string; commands?: boolean } = {}) {
  const p = await enrolled(s, `vis${n++}`, o.account);
  const ref = o.ref ?? new RefProxyConfig({ cameras: ['cam1'] });
  const client = makeClient(p.key, o.commands === false ? {} : { commands: { allow: o.allow ?? ALLOW, config: ref } });
  clients.push(client);
  client.start();
  await until(() => s.built.status.viewOf(s.built.registry.proxyById(p.proxyId)!).state === 'online', 5000, 'online');
  if (o.commands !== false) await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { ...p, client, ref, acc: p.accountId, prx: p.proxyId };
}
const V = () => s.built.vision;
const item = async (acc: string, prx: string) => (await s.api('GET', `/accounts/${acc}/vision`)).items.find((x: { proxyId: string }) => x.proxyId === prx);
const viewed = (acc: string, prx: string) => until(() => s.built.config.state(acc, prx).view !== null, 5000, 'view');
const stored = (acc: string, prx: string) => until(async () => (await item(acc, prx))?.fetchedAt != null, 5000, 'stored usage');
const rows = () => (s.built.db.prepare('SELECT count(*) n FROM proxy_analytics').get() as { n: number }).n;

describe('Vision: provider table and the result clean-up', () => {
  it('google-vision maps to the config key googleVision (one entry per provider)', () => {
    expect(PROVIDER_CONFIG['google-vision']).toBe('googleVision');
  });
  it('keeps only the contract fields, clamps strings, drops unknown ones (never a key)', () => {
    const r = cleanUsage({ v: 1, at: 5, apiKey: 'AIzaSECRET', providers: [{ id: 'google-vision', name: 'Google Vision', enabled: true, key: 'env', keyValue: 'AIzaSECRET', monthlyLimit: 1000, remoteMaxMonthly: 500, dailyCap: 0,
      month: { calls: 3 }, today: { calls: 1 }, paused: { reason: 'quota', until: 9 }, lastError: { at: 4, message: 'x'.repeat(500) }, cameras: [{ id: 'cam1', today: 1, month: 3, extra: 1 }] }] });
    expect(JSON.stringify(r)).not.toContain('AIza');
    expect(r!.providers[0].lastError!.message.length).toBeLessThanOrEqual(200);
    expect(r!.providers[0].cameras).toEqual([{ id: 'cam1', today: 1, month: 3 }]);
    expect(r!.providers[0].paused).toEqual({ reason: 'quota', until: 9 });
    expect(cleanUsage({ v: 1 })).toBeNull();
  });
});

describe('Vision service', () => {
  it('Refresh queues analytics.usage.get, answers at once, stores the result (one row, replaced), GET shows it with its time', async () => {
    const p = await proxy({ ref: new RefProxyConfig({ cameras: ['cam1'], settings: { 'analytics.googleVision.remoteMaxMonthly': 1000 } }) });
    const r = await s.api('POST', `/accounts/${p.acc}/vision/refresh`, {});
    expect(r.queued).toEqual([p.prx]);
    await stored(p.acc, p.prx);
    const it1 = await item(p.acc, p.prx);
    expect(it1.access).toBe('ok');
    expect(it1.result.providers[0]).toMatchObject({ id: 'google-vision', enabled: false, monthlyLimit: 1000, remoteMaxMonthly: 1000, key: 'none' });
    expect(it1.fetchedAt).toBe(clock.now());
    expect(rows()).toBe(1);
    clock.advance(5000);
    await s.api('POST', `/accounts/${p.acc}/vision/refresh`, {});
    await until(async () => (await item(p.acc, p.prx)).fetchedAt === clock.now(), 5000, 'replaced');
    expect(rows()).toBe(1);
  });

  it('one refresh in flight per proxy: a second one meanwhile is skipped silently', async () => {
    const p = await proxy();
    const a = V().refresh(SYS, p.acc);
    const b = V().refresh(SYS, p.acc);
    expect(a.queued).toEqual([p.prx]);
    expect(b.queued).toEqual([]);
    expect((s.built.db.prepare(`SELECT count(*) n FROM commands WHERE command = 'analytics.usage.get'`).get() as { n: number }).n).toBe(1);
  });

  it('a proxy without the allow entry is Not allowed; one without commands is Proxy too old; neither gets a command', async () => {
    const na = await proxy({ allow: ['config.get'] });
    const old = await proxy({ commands: false });
    await viewed(na.acc, na.prx);
    const r = V().refresh(SYS, na.acc);
    expect(r.queued).toEqual([]);
    expect((await item(na.acc, na.prx)).access).toBe('not-allowed');
    expect((await item(old.acc, old.prx)).access).toBe('too-old');
    expect((s.built.db.prepare(`SELECT count(*) n FROM commands WHERE command = 'analytics.usage.get'`).get() as { n: number }).n).toBe(0);
  });

  // cam-proxy refuses a command it doesn't implement with the same not_allowed as an entry that is off
  // (command-check step 8, no field tells them apart): a not_allowed while its policy lists the entry is an
  // older release; one whose policy lacks the entry is Not allowed. Until the proxy's next hello (an update).
  const refuse = (prx: string, state: 'refused' | 'failed', code: string) =>
    (V() as unknown as { onFinal(r: object): void }).onFinal({ id: `c${n++}`, proxyId: prx, command: 'analytics.usage.get', state, outcomeCode: code, result: null });

  it('not_allowed while the policy lists the entry, or not_implemented, is Proxy too old (no command); a new hello clears it', async () => {
    const p = await proxy();
    refuse(p.prx, 'refused', 'not_allowed');
    expect((await item(p.acc, p.prx)).access).toBe('too-old');
    expect(V().refresh(SYS, p.acc).queued).toEqual([]);
    const q = await proxy();
    refuse(q.prx, 'failed', 'not_implemented');
    expect((await item(q.acc, q.prx)).access).toBe('too-old');
    // The update: the proxy reconnects (a new hello), the old refusal no longer counts.
    await p.client.stop('shutdown');
    clients.splice(clients.indexOf(p.client), 1);
    clock.advance(1000);
    const again = makeClient(p.key, { commands: { allow: ALLOW, config: p.ref } });
    clients.push(again);
    again.start();
    await until(() => (s.built.status.row(p.prx)?.lastHelloAt ?? 0) === clock.now() && s.built.status.viewOf(s.built.registry.proxyById(p.prx)!).state === 'online', 5000, 'new hello');
    expect((await item(p.acc, p.prx)).access).toBe('ok');
  });

  it('not_allowed from a proxy whose policy lacks the entry stays Not allowed', async () => {
    const p = await proxy({ allow: ['config.get'], ref: new RefProxyConfig({ cameras: ['cam1'], settings: { 'analytics.googleVision.remoteMaxMonthly': 1000 } }) });
    await viewed(p.acc, p.prx);
    refuse(p.prx, 'refused', 'not_allowed');
    expect((await item(p.acc, p.prx)).access).toBe('not-allowed');
  });

  it('an offline proxy keeps its old figures with their age and gets no command', async () => {
    const p = await proxy();
    V().refresh(SYS, p.acc);
    await stored(p.acc, p.prx);
    const at = (await item(p.acc, p.prx)).fetchedAt;
    await p.client.stop('shutdown');
    clients.splice(clients.indexOf(p.client), 1);
    clock.advance(10 * 60_000);
    const it1 = await item(p.acc, p.prx);
    expect(it1.state).not.toBe('online');
    expect(it1.fetchedAt).toBe(at);
    expect(V().refresh(SYS, p.acc).queued).toEqual([]);
  });

  it('limit 0 sends enabled:false with monthlyLimit 0 in one config.set; preview then apply server side; a refresh follows', async () => {
    const ref = new RefProxyConfig({ cameras: ['cam1'], settings: { 'analytics.googleVision.remoteMaxMonthly': 1000, 'analytics.googleVision.enabled': true } });
    const p = await proxy({ ref });
    await viewed(p.acc, p.prx);
    const r = await s.api('PUT', `/accounts/${p.acc}/vision/proxies/${p.prx}/providers/google-vision`, { monthlyLimit: 0 });
    expect(r.commandId).toMatch(/^cmd_/);
    const pv = s.built.commands.getRaw(p.acc, p.prx, r.commandId);
    expect(pv.command).toBe('config.set');
    expect(pv.rawArgs.set).toEqual({ 'analytics.googleVision.enabled': false, 'analytics.googleVision.monthlyLimit': 0 });
    expect(pv.rawArgs.dryRun).toBe(true);
    await until(async () => (await item(p.acc, p.prx)).saves?.['google-vision']?.state === 'saved', 5000, 'saved');
    expect(ref.current('analytics.googleVision.enabled')).toBe(false);
    expect(ref.current('analytics.googleVision.monthlyLimit')).toBe(0);
    await until(async () => (await item(p.acc, p.prx)).result?.providers?.[0]?.monthlyLimit === 0, 5000, 'refreshed after save');
  });

  it('a raise within the ceiling switches Vision on (enabled true, limit n)', async () => {
    const ref = new RefProxyConfig({ cameras: ['cam1'], settings: { 'analytics.googleVision.remoteMaxMonthly': 1000, 'analytics.googleVision.monthlyLimit': 0 } });
    const p = await proxy({ ref });
    await viewed(p.acc, p.prx);
    await s.api('PUT', `/accounts/${p.acc}/vision/proxies/${p.prx}/providers/google-vision`, { monthlyLimit: 800 });
    await until(async () => (await item(p.acc, p.prx)).saves?.['google-vision']?.state === 'saved', 5000, 'saved');
    expect(ref.current('analytics.googleVision.enabled')).toBe(true);
    expect(ref.current('analytics.googleVision.monthlyLimit')).toBe(800);
  });

  it('a preview error is the PUT\'s answer (above the known ceiling: above_local_ceiling); nothing is queued', async () => {
    const p = await proxy(); // ceiling 0, limit 1000, off
    await viewed(p.acc, p.prx);
    const before = (s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n;
    await expect(s.api('PUT', `/accounts/${p.acc}/vision/proxies/${p.prx}/providers/google-vision`, { monthlyLimit: 500 })).rejects.toMatchObject({ status: 400, body: { error: 'above_local_ceiling' } });
    expect((s.built.db.prepare('SELECT count(*) n FROM commands').get() as { n: number }).n).toBe(before);
  });

  it('a refusal at the proxy shows at the row (failed, with its code)', async () => {
    const ref = new RefProxyConfig({ cameras: ['cam1'], settings: { 'analytics.googleVision.remoteMaxMonthly': 1000 } });
    const p = await proxy({ ref });
    await viewed(p.acc, p.prx);
    ref.localEdit({ 'sse.pingS': 40 }); // the revision moves: the stored view's preview is a conflict at the proxy
    await s.api('PUT', `/accounts/${p.acc}/vision/proxies/${p.prx}/providers/google-vision`, { monthlyLimit: 0 });
    await until(async () => (await item(p.acc, p.prx)).saves?.['google-vision']?.state === 'failed', 5000, 'failed');
    expect((await item(p.acc, p.prx)).saves['google-vision'].code).toBe('conflict');
  });

  it('bad input: an unknown provider 404, a limit outside 0–100000 or not an integer 400, another account\'s proxy 404', async () => {
    const p = await proxy();
    const other = await proxy({ account: 'other' });
    const put = (acc: string, prx: string, prov: string, body: unknown) => s.api('PUT', `/accounts/${acc}/vision/proxies/${prx}/providers/${prov}`, body);
    await expect(put(p.acc, p.prx, 'aws-rekognition', { monthlyLimit: 1 })).rejects.toMatchObject({ status: 404 });
    for (const m of [-1, 100001, 1.5, '5', null]) await expect(put(p.acc, p.prx, 'google-vision', { monthlyLimit: m })).rejects.toMatchObject({ status: 400 });
    await expect(put(p.acc, other.prx, 'google-vision', { monthlyLimit: 0 })).rejects.toMatchObject({ status: 404 });
    const list = (await s.api('GET', `/accounts/${p.acc}/vision`)).items.map((x: { proxyId: string }) => x.proxyId);
    expect(list).toContain(p.prx);
    expect(list).not.toContain(other.prx);
  });

  it('system admin only, checked in the service: anyone else gets 403', async () => {
    const p = await proxy();
    const no = { actor: 'ops-token:abcdef01', sysadmin: false };
    expect(() => V().get(no, p.acc)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => V().refresh(no, p.acc)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => V().setLimit(no, p.acc, p.prx, 'google-vision', { monthlyLimit: 0 })).toThrow(expect.objectContaining({ status: 403 }));
    // An operations token (all scopes) never reaches these routes either.
    const { token } = s.built.ops.issue('admin@example.com', { name: 'all', scopes: ['tokens', 'routes', 'moves', 'registry', 'onboard', 'actions', 'config', 'offboard'], days: 1 });
    for (const [m, path] of [['GET', `/accounts/${p.acc}/vision`], ['POST', `/accounts/${p.acc}/vision/refresh`], ['PUT', `/accounts/${p.acc}/vision/proxies/${p.prx}/providers/google-vision`]]) {
      const res = await fetch(`${s.url}/api/v1${path}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify({ monthlyLimit: 0 }) });
      expect(res.status, `${m} ${path}`).toBe(403);
    }
  });

  it('the diagnostics API shows the stored figures per proxy', async () => {
    const p = await proxy();
    V().refresh(SYS, p.acc);
    await stored(p.acc, p.prx);
    const d = await s.api('GET', '/diag/proxies');
    const x = d.items.find((i: { id: string }) => i.id === p.prx);
    expect(x.vision).toMatchObject({ fetchedAt: expect.any(Number), result: { providers: [{ id: 'google-vision' }] } });
  });

  it('the stored row goes with its proxy', async () => {
    const p = await proxy();
    V().refresh(SYS, p.acc);
    await stored(p.acc, p.prx);
    s.built.db.prepare('DELETE FROM proxies WHERE id = ?').run(p.prx);
    expect(rows()).toBe(0);
  });
});

describe('usageGetPublic: the result\'s `key` (where the key comes from) is kept, anything secret-looking is not', () => {
  const base = { v: 1, at: 1, providers: [{ id: 'google-vision', name: 'Google Vision', enabled: true, key: 'env', monthlyLimit: 1, remoteMaxMonthly: 1, dailyCap: 0, month: { calls: 0 }, today: { calls: 0 }, paused: null, lastError: null, cameras: [] }] };
  it('keeps a contract result with key env/manual/none', () => {
    expect(usageGetPublic(base)).toBe(true);
    expect(usageGetPublic({ ...base, providers: [{ ...base.providers[0], key: 'AIzaSyEXAMPLE' }] })).toBe(false);
    expect(usageGetPublic({ ...base, providers: [{ ...base.providers[0], apiKey: 'AIzaSyEXAMPLE' }] })).toBe(false);
    expect(usageGetPublic({ v: 1 })).toBe(false);
  });
});
