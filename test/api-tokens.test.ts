// The command history and managed token routes (plan Task 8): the token is
// in the issue answer only (no-store), never again: not in a list, the
// command history, the dashboard, the audit log or the live stream, and no
// answer carries a full hash.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';

const dir = tmpDir();
let s: Running;
const clients: ProxyClient[] = [];
let sse = '';
const sseAbort = new AbortController();

beforeAll(async () => {
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000' });
  const r = await fetch(`${s.url}/api/v1/live`, { headers: { Cookie: `__Host-cams_admin=${s.cookie}` }, signal: sseAbort.signal });
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) sse += dec.decode(chunk);
    } catch { /* aborted */ }
  })();
});
afterAll(async () => {
  sseAbort.abort();
  for (const c of clients) await c.stop('shutdown');
  await s.stop();
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${s.url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${s.cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, body: text ? JSON.parse(text) : null };
}
async function proxy(name: string, commands: { allow: string[] } | null, account = 'home') {
  const p = await enrolled(s, name, account);
  const client = makeClient(p.key, commands ? { commands } : {});
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.cameras.length, 5000);
  if (commands) await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000);
  return { base: `/accounts/${p.accountId}/proxies/${p.proxyId}`, ...p, client };
}
const FULL_HASH = /sha256:[0-9a-f]{16}/;

describe('token and command routes', () => {
  it('issue (shown once, no-store), list, retire, revoke, re-apply, history; the token and full hashes never appear again', async () => {
    const a = await proxy('api-a', { allow: ['tokens.apply'] });
    const issued = await call('POST', `${a.base}/tokens`, { kind: 'client', label: 'cams cluster' });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.body).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), tokenId: expect.stringMatching(/^tok_/), commandId: expect.stringMatching(/^cmd_/), shownOnce: true });
    const token: string = issued.body.token;
    await until(async () => (await call('GET', `${a.base}/tokens`)).body.items[0].state === 'active');

    const later: string[] = [];
    const list = await call('GET', `${a.base}/tokens`);
    expect(list.body).toMatchObject({ revision: 1, appliedRevision: 1, items: [{ id: issued.body.tokenId, kind: 'client', label: 'cams cluster', state: 'active', hashPrefix: expect.stringMatching(/^sha256:[0-9a-f]{8}$/) }] });
    later.push(list.text);
    const history = await call('GET', `${a.base}/commands`);
    expect(history.body.items).toMatchObject([{ id: issued.body.commandId, command: 'tokens.apply', state: 'done' }]);
    later.push(history.text);
    const one = await call('GET', `${a.base}/commands/${issued.body.commandId}`);
    expect(one.body).toMatchObject({ state: 'done', result: { revision: 1, applied: true }, resultEnvelope: { type: 'result', sig: expect.any(String) } });
    later.push(one.text);

    expect((await call('POST', `${a.base}/tokens/${issued.body.tokenId}/retire`, { hours: 0 })).body).toEqual({ error: 'invalid', field: 'hours' });
    const retired = await call('POST', `${a.base}/tokens/${issued.body.tokenId}/retire`, { hours: 1 });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ state: 'retiring', retireAt: expect.any(Number) });
    later.push(retired.text);
    expect((await call('POST', `${a.base}/tokens/${issued.body.tokenId}/retire`, { hours: 1 })).body).toEqual({ error: 'not_active' });
    const revoked = await call('POST', `${a.base}/tokens/${issued.body.tokenId}/revoke`, {});
    expect(revoked.body).toMatchObject({ state: 'revoked' });
    later.push(revoked.text);
    expect((await call('POST', `${a.base}/tokens/${issued.body.tokenId}/revoke`, {})).status).toBe(409);
    await until(async () => (await call('GET', `${a.base}/commands`)).body.items.every((c: { state: string }) => !['queued', 'sent', 'received'].includes(c.state)));
    const re = await call('POST', `${a.base}/tokens/apply`, {});
    expect(re.status).toBe(202);
    expect(re.body).toEqual({ commandId: expect.stringMatching(/^cmd_/) });
    await until(async () => (await call('GET', `${a.base}/commands/${re.body.commandId}`)).body.state === 'done');
    const page = await call('GET', `${a.base}/commands?limit=2`);
    expect(page.body.items).toHaveLength(2);
    expect((await call('GET', `${a.base}/commands?limit=2&cursor=${page.body.nextCursor}`)).body.items.length).toBeGreaterThanOrEqual(1);

    for (const path of ['/dashboard', '/audit?limit=200', `${a.base}/status`, `${a.base}/tokens`, `${a.base}/commands?limit=200`]) later.push((await call('GET', path)).text);
    await new Promise((r) => setTimeout(r, 1000)); // the live stream for a second more
    later.push(sse);
    expect(sse).toContain('event: registry');
    for (const text of later) {
      expect(text).not.toContain(token);
      expect(text).not.toMatch(FULL_HASH);
    }
  });

  it('restore: a proxy ahead → 409 proxy_ahead on issue; POST …/tokens/confirm-restore sends the set above it', async () => {
    const a = await proxy('api-ahead', { allow: ['tokens.apply'] });
    a.client.tokensRevision = 9;
    await until(async () => (await call('GET', `${a.base}/tokens`)).body.ahead === 9);
    expect((await call('POST', `${a.base}/tokens`, { kind: 'client', label: 'x' })).body).toEqual({ error: 'proxy_ahead' });
    const c = await call('POST', `${a.base}/tokens/confirm-restore`, {});
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ commandId: expect.stringMatching(/^cmd_/) });
    await until(async () => (await call('GET', `${a.base}/tokens`)).body.appliedRevision === 10);
    expect((await call('POST', `${a.base}/tokens/confirm-restore`, {})).body).toEqual({ error: 'not_ahead' });
  });

  it('errors: 400 field, 404 other account, 409 not_enrolled / unsupported_by_proxy / not_allowed_on_proxy / paused_on_proxy / not_active', async () => {
    const a = await proxy('api-b', { allow: ['tokens.apply'] });
    expect((await call('POST', `${a.base}/tokens`, { kind: 'client', label: '' })).body).toEqual({ error: 'invalid', field: 'label' });
    expect((await call('POST', `${a.base}/tokens`, { kind: 'superuser', label: 'x' })).body).toEqual({ error: 'invalid', field: 'kind' });
    expect((await call('POST', `${a.base}/tokens`, { kind: 'admin', label: 'x' })).body).toEqual({ error: 'not_allowed_on_proxy' });
    const p1 = await proxy('api-p1', null);
    expect((await call('POST', `${p1.base}/tokens`, { kind: 'client', label: 'x' })).body).toEqual({ error: 'unsupported_by_proxy' });
    expect((await call('POST', `${p1.base}/tokens/apply`, {})).body).toEqual({ error: 'unsupported_by_proxy' });
    a.client.commands!.paused = true;
    await until(() => s.built.status.row(a.proxyId)?.reported?.commands?.paused === true);
    expect((await call('POST', `${a.base}/tokens`, { kind: 'client', label: 'x' })).body).toEqual({ error: 'paused_on_proxy' });
    const other = await proxy('api-c', { allow: ['tokens.apply'] }, 'other');
    const wrong = `/accounts/${a.accountId}/proxies/${other.proxyId}`;
    for (const [m, path] of [['GET', `${wrong}/tokens`], ['GET', `${wrong}/commands`], ['POST', `${wrong}/tokens`], ['POST', `${wrong}/tokens/apply`]]) expect((await call(m, path, m === 'POST' ? { kind: 'client', label: 'x' } : undefined)).status, path).toBe(404);
    expect((await call('GET', `${a.base}/commands/cmd_ZZZZZZZZZZZZZZZZZZZZ`)).status).toBe(404);
    const t = await call('POST', `${other.base}/tokens`, { kind: 'client', label: 'x' });
    other.client.dropCommands = 1000;
    expect((await call('POST', `${other.base}/tokens`, { kind: 'client', label: 'y' })).status).toBe(201);
    const pendingId = (await call('GET', `${other.base}/tokens`)).body.items.find((x: { state: string }) => x.state === 'pending').id;
    expect((await call('POST', `${other.base}/tokens/${pendingId}/retire`, {})).body).toEqual({ error: 'not_active' });
    expect(t.status).toBe(201);
    const notEnrolled = await s.api('POST', `/accounts/${a.accountId}/proxies`, { name: 'fresh', displayName: 'Fresh', runsOn: 'cloud' });
    expect((await call('POST', `/accounts/${a.accountId}/proxies/${notEnrolled.id}/tokens`, { kind: 'client', label: 'x' })).body).toEqual({ error: 'not_enrolled' });
    // Nothing of the refused issues was stored.
    expect((await call('GET', `/accounts/${a.accountId}/proxies/${notEnrolled.id}/tokens`)).body).toEqual({ revision: 0, appliedRevision: 0, ahead: null, items: [] });
  });
});
