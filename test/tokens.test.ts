// The Tokens service (migration spec §10.1–§10.2, plan Task 6): managed
// cams↔proxy tokens, stored only as hashes, shown once, applied as a
// declarative set with a strictly increasing revision.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { readEpoch } from '../server/db/open';
import { generateToken } from '../server/tokens/service';
import type { ProxyClient } from '../test-client/client';

const ACTOR = 'admin@example.com';
const ACTOR2 = 'other@example.com';
const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
const logs: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
  logs.length = 0;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
});
afterEach(async () => {
  process.stdout.write = origWrite;
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow = ['tokens.apply', 'tokens.apply.admin']) {
  const p = await enrolled(s, `tok${n++}`);
  const client = makeClient(p.key, { commands: { allow } });
  clients.push(client);
  client.start();
  await until(() => !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'commands report');
  return { ...p, client, acc: p.accountId, prx: p.proxyId };
}
const T = () => s.built.tokens;
const tokenState = (acc: string, prx: string, id: string) => T().list(acc, prx).items.find((t) => t.id === id)?.state;
const audit = (action: string) => (s.built.db.prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { detail: string }[]).map((x) => JSON.parse(x.detail));
const appliedArgs = (c: ProxyClient) => c.receivedCommands.filter((m) => c.executed.includes(m.body.cmdId)).map((m) => m.body.args);

describe('tokens', () => {
  it('generateToken: 43 characters of base64url, sha256 hash', () => {
    const g = generateToken();
    expect(g.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.hash).toBe(`sha256:${createHash('sha256').update(g.token).digest('hex')}`);
    expect(generateToken().token).not.toBe(g.token);
  });

  it('issue: 43-character token, only its hash stored, shown once; pending → active when the proxy confirms', async () => {
    const { acc, prx, client } = await proxy();
    const r = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'cams cluster' });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = s.built.db.prepare('SELECT * FROM proxy_tokens WHERE id = ?').get(r.tokenId) as Record<string, unknown>;
    expect(row).toMatchObject({ hash: `sha256:${createHash('sha256').update(r.token).digest('hex')}`, state: 'pending', holder: 'manual', kind: 'client', issued_revision: 1 });
    await until(() => tokenState(acc, prx, r.tokenId) === 'active');
    expect(client.tokens.has(row.hash as string)).toBe(true);
    // Never stored, logged, audited or put in a command: only the hash, and in views only its prefix.
    const db = s.built.db;
    for (const t of ['proxy_tokens', 'audit_log', 'commands', 'proxy_status']) expect(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()), t).not.toContain(r.token);
    expect(logs.join('')).not.toContain(r.token);
    expect(JSON.stringify(T().list(acc, prx))).not.toMatch(/sha256:[0-9a-f]{16}/);
    expect(JSON.stringify(db.prepare('SELECT detail FROM audit_log').all())).not.toMatch(/sha256:[0-9a-f]{16}/);
    expect(T().list(acc, prx)).toMatchObject({ revision: 1, appliedRevision: 1, items: [{ id: r.tokenId, kind: 'client', label: 'cams cluster', hashPrefix: (row.hash as string).slice(0, 15), createdBy: ACTOR, lastCommand: { state: 'done' } }] });
    expect(audit('token-issue')).toMatchObject([{ tokenId: r.tokenId, kind: 'client', hashPrefix: (row.hash as string).slice(0, 15) }]);
  });

  it('every tokens.apply carries the full non-revoked set with a strictly higher revision', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    const b = T().issue(ACTOR, acc, prx, { kind: 'admin', label: 'b' });
    await until(() => tokenState(acc, prx, b.tokenId) === 'active');
    T().revoke(ACTOR, acc, prx, a.tokenId);
    await until(() => appliedArgs(client).length === 3);
    const sets = appliedArgs(client);
    expect(sets.map((x) => x.revision)).toEqual([1, 2, 3]);
    expect(sets.map((x) => x.tokens.map((t: { id: string }) => t.id))).toEqual([[a.tokenId], [a.tokenId, b.tokenId], [b.tokenId]]);
    expect(client.tokens.size).toBe(1);
  });

  it('two issues at once: both tokens in the final set, revisions 1 then 2', async () => {
    const { acc, prx, client } = await proxy();
    const [a, b] = [T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' }), T().issue(ACTOR2, acc, prx, { kind: 'client', label: 'b' })];
    await until(() => T().list(acc, prx).items.filter((t) => t.state === 'active').length === 2);
    const sets = appliedArgs(client);
    expect(sets.map((x) => x.revision)).toEqual([1, 2]);
    expect(sets.at(-1).tokens.map((t: { id: string }) => t.id).sort()).toEqual([a.tokenId, b.tokenId].sort());
    expect(T().list(acc, prx)).toMatchObject({ revision: 2, appliedRevision: 2 });
  });

  it('admin kind needs tokens.apply.admin on the proxy: 409 not_allowed_on_proxy otherwise, and nothing is stored', async () => {
    const { acc, prx } = await proxy(['tokens.apply']);
    expect(() => T().issue(ACTOR, acc, prx, { kind: 'admin', label: 'x' })).toThrow(expect.objectContaining({ status: 409, code: 'not_allowed_on_proxy' }));
    expect(s.built.db.prepare('SELECT count(*) n FROM proxy_tokens').get()).toEqual({ n: 0 });
    expect(T().list(acc, prx).revision).toBe(0);
    expect(audit('token-issue')).toHaveLength(0);
  });

  it('input: kind and label are checked (400 field errors)', async () => {
    const { acc, prx } = await proxy();
    for (const [input, field] of [[{ kind: 'root', label: 'x' }, 'kind'], [{ kind: 'client', label: '' }, 'label'], [{ kind: 'client', label: 'a\nb' }, 'label'], [{ kind: 'client', label: 'x'.repeat(65) }, 'label'], [null, 'kind']] as const) {
      expect(() => T().issue(ACTOR, acc, prx, input), JSON.stringify(input)).toThrow(expect.objectContaining({ field }));
    }
  });

  it('retire: retiring with retireAt in the set; hours outside 1–168 → 400; at retireAt → revoked and a cleanup tokens.apply', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    for (const h of [0, 169, 1.5, '2']) expect(() => T().retire(ACTOR, acc, prx, a.tokenId, h)).toThrow(expect.objectContaining({ field: 'hours' }));
    const v = T().retire(ACTOR, acc, prx, a.tokenId, 1);
    expect(v).toMatchObject({ state: 'retiring', retireAt: clock.now() + 3600_000 });
    await until(() => appliedArgs(client).length === 2);
    expect(appliedArgs(client)[1].tokens).toMatchObject([{ id: a.tokenId, retireAt: clock.now() + 3600_000 }]);
    expect(() => T().retire(ACTOR, acc, prx, a.tokenId, 2)).toThrow(expect.objectContaining({ status: 409, code: 'not_active' }));
    clock.advance(3600_000);
    T().tick();
    expect(tokenState(acc, prx, a.tokenId)).toBe('revoked');
    await until(() => appliedArgs(client).length === 3);
    expect(appliedArgs(client)[2].tokens).toEqual([]);
    expect(audit('token-revoke')).toMatchObject([{ tokenId: a.tokenId, reason: 'retired' }]);
    T().tick();
    expect(audit('token-revoke')).toHaveLength(1);
  });

  it('revoke: revoked at once, the next set no longer has it; revoking twice is 409', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    expect(T().revoke(ACTOR, acc, prx, a.tokenId)).toMatchObject({ state: 'revoked', revokedAt: clock.now() });
    await until(() => client.tokens.size === 0);
    expect(() => T().revoke(ACTOR, acc, prx, a.tokenId)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => T().revoke(ACTOR, acc, prx, 'tok_ZZZZZZZZZZZZZZZZZZZZ')).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('a refused tokens.apply leaves the token pending with the reason shown; re-apply sends the set again', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    client.commands!.paused = true;
    await until(() => T().list(acc, prx).items[0].lastCommand?.state === 'refused');
    expect(T().list(acc, prx).items[0]).toMatchObject({ state: 'pending', lastCommand: { state: 'refused', outcomeCode: 'paused' } });
    client.commands!.paused = false;
    await until(() => s.built.status.row(prx)?.reported?.commands?.paused === false);
    const r = T().reapply(ACTOR, acc, prx);
    expect(r.commandId).toMatch(/^cmd_/);
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    expect(appliedArgs(client).at(-1)).toMatchObject({ revision: 2 });
    expect(audit('command-create').at(-1)).toMatchObject({ reason: 'reapply' });
  });

  it('restore: a proxy ahead of cams-admin blocks token changes until an admin confirms; then the set goes out above it', async () => {
    const { acc, prx, client } = await proxy();
    client.tokensRevision = 50; // the proxy has seen revision 50 (from before the restore)
    await until(() => T().list(acc, prx).ahead === 50, 5000, 'ahead from the heartbeat');
    expect(() => T().issue(ACTOR, acc, prx, { kind: 'client', label: 'x' })).toThrow(expect.objectContaining({ status: 409, code: 'proxy_ahead' }));
    expect(() => T().reapply(ACTOR, acc, prx)).toThrow(expect.objectContaining({ status: 409, code: 'proxy_ahead' }));
    expect(() => T().confirmRestore(ACTOR, acc, 'prx_ZZZZZZZZZZZZZZZZZZZZ')).toThrow(expect.objectContaining({ status: 404 }));
    const c = T().confirmRestore(ACTOR, acc, prx);
    expect(c.commandId).toMatch(/^cmd_/);
    await until(() => client.tokensRevision === 51);
    expect(T().list(acc, prx)).toMatchObject({ ahead: null, revision: 51, appliedRevision: 51 });
    expect(audit('command-create').filter((d) => d.reason === 'restore-confirmed')).toHaveLength(1);
    const r = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'after restore' });
    await until(() => tokenState(acc, prx, r.tokenId) === 'active');
    expect(() => T().confirmRestore(ACTOR, acc, prx)).toThrow(expect.objectContaining({ status: 409, code: 'not_ahead' }));
  });

  it('restore: a stale answer at our own revision (another set with the same number) also asks for the confirmation, never auto-confirms', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    client.tokensRevision = 2; // the proxy already has a revision 2 we never sent
    T().retire(ACTOR, acc, prx, a.tokenId, 24); // our revision 2
    await until(() => T().list(acc, prx).ahead === 2);
    expect(T().list(acc, prx).appliedRevision).toBe(1);
  });

  it('a revoke is committed whatever the proxy says, and stays "not on the proxy" until a set at or above its revision is applied', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    // The proxy is paused and allows nothing (e.g. a leaked admin token narrowed it): the revoke still goes through, as a revocation.
    client.commands!.paused = true;
    client.commands!.allow = [];
    await until(() => s.built.status.row(prx)?.reported?.commands?.paused === true && s.built.status.row(prx)?.reported?.commands?.allow.length === 0);
    const v = T().revoke(ACTOR, acc, prx, a.tokenId);
    expect(v).toMatchObject({ state: 'revoked', revokedRevision: 2, onProxy: false });
    await until(() => client.tokens.size === 0);
    await until(() => T().list(acc, prx).items[0].onProxy === true);
    const cmd = client.receivedCommands.at(-1)!;
    expect(cmd.body.revocationOnly).toBe(true);
    // With the env switch off nothing goes out, the revoke stands.
    const b = await proxy();
    const t = T().issue(ACTOR, b.acc, b.prx, { kind: 'client', label: 'b' });
    await until(() => tokenState(b.acc, b.prx, t.tokenId) === 'active');
    b.client.commands!.enabled = false;
    await until(() => s.built.status.row(b.prx)?.reported?.commands?.enabled === false);
    expect(T().revoke(ACTOR, b.acc, b.prx, t.tokenId)).toMatchObject({ state: 'revoked', onProxy: false });
    expect(b.client.tokens.size).toBe(1);
    // A few heartbeats while it is still off: nothing can go out, and nothing waits for it later.
    const hb = b.client.stats.sent;
    await until(() => b.client.stats.sent >= hb + 3);
    expect(b.client.tokens.size).toBe(1);
    // Back on: the next heartbeat (proxy revision 1 < 2) re-sends the current set.
    b.client.commands!.enabled = true;
    await until(() => b.client.tokens.size === 0, 5000, 'resync');
    await until(() => T().list(b.acc, b.prx).items[0].onProxy === true);
  });

  it('offline for more than 15 minutes: the revoke\'s tokens.apply expires; on reconnect the heartbeat (revision below ours) re-sends the set', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    await client.stop('shutdown');
    T().revoke(ACTOR, acc, prx, a.tokenId);
    clock.advance(16 * 60_000);
    s.built.commands.tick();
    expect(T().list(acc, prx).items[0]).toMatchObject({ state: 'revoked', onProxy: false, lastCommand: { state: 'expired' } });
    client.start();
    await until(() => client.tokens.size === 0, 5000, 'resent after reconnect');
    await until(() => T().list(acc, prx).appliedRevision === 2);
    expect(audit('command-create').filter((d) => d.reason === 'resync')).toHaveLength(1);
  });

  it('a refused tokens.apply (the proxy\'s rate limit) is re-sent from the heartbeat only after retryAfterS', async () => {
    const { acc, prx, client } = await proxy();
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => tokenState(acc, prx, a.tokenId) === 'active');
    client.refuseNext = { code: 'rate_limited', retryAfterS: 600 };
    T().revoke(ACTOR, acc, prx, a.tokenId);
    await until(() => T().list(acc, prx).items[0].lastCommand?.state === 'refused');
    await new Promise((r) => setTimeout(r, 600)); // a few heartbeats: nothing re-sent yet
    expect(client.tokens.size).toBe(1);
    clock.advance(600_000);
    await until(() => client.tokens.size === 0, 5000, 'resent after retryAfterS');
  });

  it('a heartbeat tokens.revision covering a pending token confirms it (a lost done); a repeat writes nothing', async () => {
    const { acc, prx, client } = await proxy();
    client.dropAfterReceived = 1; // applies, then the socket drops before done
    client.debugHoldEvents = true; // and the done never comes as an event
    client.holdReconnect = true;
    const a = T().issue(ACTOR, acc, prx, { kind: 'client', label: 'a' });
    await until(() => client.tokensRevision === 1 && client.state !== 'connected');
    client.dropCommands = 1000; // the re-send is lost too
    client.release();
    await until(() => tokenState(acc, prx, a.tokenId) === 'active', 5000, 'confirmed by heartbeat');
    expect(['sent', 'received']).toContain(s.built.commands.get(acc, prx, a.commandId).state);
    const before = readEpoch(s.built.db);
    T().onHeartbeat(prx, { revision: 1 });
    expect(readEpoch(s.built.db)).toBe(before);
  });

  it('a heartbeat revision that no sent command carried confirms nothing (a restored revision collision)', async () => {
    const { acc, prx, client } = await proxy();
    await client.stop('shutdown');
    s.built.db.prepare('INSERT INTO proxy_token_state (proxy_id, revision) VALUES (?, 5)').run(prx);
    // A pending token at revision 5 whose command never went out.
    s.built.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES ('tok_00000000000000000001',?,?,'client','manual','x',?, 'pending',5,1,'a')`).run(acc, prx, 'sha256:' + 'e'.repeat(64));
    T().onHeartbeat(prx, { revision: 5 });
    expect(tokenState(acc, prx, 'tok_00000000000000000001')).toBe('pending');
  });

  it('64 non-revoked tokens per proxy, then 409 too_many_tokens', async () => {
    const { acc, prx, client } = await proxy();
    client.dropCommands = 100000;
    const ins = s.built.db.prepare(`INSERT INTO proxy_tokens (id,account_id,proxy_id,kind,holder,label,hash,state,issued_revision,created_at,created_by) VALUES (?,?,?,'client','manual','x',?,'active',1,1,'a')`);
    for (let i = 0; i < 64; i++) ins.run(`tok_${String(i).padStart(20, '0')}`, acc, prx, `sha256:${i.toString(16).padStart(64, '0')}`);
    expect(() => T().issue(ACTOR, acc, prx, { kind: 'client', label: 'x' })).toThrow(expect.objectContaining({ status: 409, code: 'too_many_tokens' }));
  });

  it('a token id of proxy B under proxy A\'s path: 404 for retire and revoke', async () => {
    const a = await proxy();
    const b = await proxy();
    const t = T().issue(ACTOR, b.acc, b.prx, { kind: 'client', label: 'b' });
    expect(() => T().revoke(ACTOR, a.acc, a.prx, t.tokenId)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => T().retire(ACTOR, a.acc, a.prx, t.tokenId, 2)).toThrow(expect.objectContaining({ status: 404 }));
    expect(tokenState(b.acc, b.prx, t.tokenId)).not.toBe('revoked');
  });

  it('another account\'s proxy: 404', async () => {
    const { prx } = await proxy();
    const other = await s.api('POST', '/accounts', { name: 'other', displayName: 'O' });
    expect(() => T().issue(ACTOR, other.id, prx, { kind: 'client', label: 'x' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => T().list(other.id, prx)).toThrow(expect.objectContaining({ status: 404 }));
  });
});
