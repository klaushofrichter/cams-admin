// Camera move on the channel (plan Task 3): proxy move events reach the hub's
// onProxyEvent hook, the nine move.* commands are creatable, and the move
// token never stays in the database after its command is final.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { summariseArgs, requiredEntries } from '../server/commands/service';
import { AUDIT_ACTIONS } from '../server/audit';

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const cmdArgs = (c: string) => fx(`valid-command-move-${c}.json`).args as Record<string, any>;
const eventBody = (k: string) => {
  const { proxyId: _p, connId: _c, ...rest } = fx(`valid-event-move-${k}.json`);
  return rest;
};
const MOVE_ID = 'mv_0123456789ABCDEFGHJK';

const dir = tmpDir();
let s: Running;
const clients: ProxyClient[] = [];
let n = 0;
type Ev = { proxyId: string; accountId: string; body: Record<string, any> };
let seen: Ev[];

beforeEach(async () => {
  resetAccounts();
  seen = [];
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' });
  s.built.hub.deps.onProxyEvent = (proxyId, accountId, body) => { seen.push({ proxyId, accountId, body: body as unknown as Record<string, any> }); };
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

async function proxy(allow: string[]) {
  const p = await enrolled(s, `mv${n++}`);
  const client = makeClient(p.key, { commands: { allow } });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands, 5000, 'connected');
  return { ...p, client };
}
const auditFor = (action: string) => s.built.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as { outcome: string; detail: string; actor: string }[];

describe('proxy move events', () => {
  it('a signed move.request event reaches onProxyEvent with the proxy id', async () => {
    const p = await proxy(['move.send']);
    p.client.emitEvent(eventBody('request'));
    await until(() => seen.length === 1, 3000, 'event');
    expect(seen[0].proxyId).toBe(p.proxyId);
    expect(seen[0].accountId).toBe(p.accountId);
    expect(seen[0].body.kind).toBe('move.request');
    expect(seen[0].body.requestId).toBe(eventBody('request').requestId);
  });

  it('an event with a forged signature is dropped and audited', async () => {
    const p = await proxy(['move.send']);
    p.client.emitEvent(eventBody('request'), { forge: true });
    await until(() => auditFor('move-event-refused').length === 1, 3000, 'audit');
    expect(seen).toHaveLength(0);
    expect(JSON.parse(auditFor('move-event-refused')[0].detail).reason).toBe('bad_signature');
    expect(p.client.state).toBe('connected');
  });

  it('an event for another connection is dropped', async () => {
    const p = await proxy(['move.send']);
    p.client.emitEvent({ ...eventBody('request'), connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' });
    await until(() => auditFor('move-event-refused').length === 1, 3000, 'audit');
    expect(seen).toHaveLength(0);
    expect(JSON.parse(auditFor('move-event-refused')[0].detail).reason).toBe('wrong_target');
  });

  it('an unknown event kind is refused and audited once per 10 min, without closing the connection', async () => {
    const p = await proxy(['move.send']);
    for (let i = 0; i < 30; i++) p.client.emitEvent({ kind: 'move.bogus', moveId: MOVE_ID });
    await until(() => auditFor('move-event-refused').length >= 1, 3000, 'audit');
    await new Promise((r) => setTimeout(r, 200));
    expect(auditFor('move-event-refused')).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('an event failing the strict schema is refused (a failed phase without code)', async () => {
    const p = await proxy(['move.send']);
    const { code: _c, ...noCode } = { ...eventBody('phase'), phase: 'failed', ok: false, code: 'x' };
    p.client.emitEvent(noCode);
    await until(() => auditFor('move-event-refused').length === 1, 3000, 'audit');
    expect(seen).toHaveLength(0);
    expect(JSON.parse(auditFor('move-event-refused')[0].detail).reason).toBe('invalid_event');
  });

  it('a burst of valid move events never closes the connection, duplicates are not refused', async () => {
    const p = await proxy(['move.send']);
    const connects = p.client.stats.connects;
    for (let i = 0; i < 60; i++) p.client.emitEvent(i % 2 ? eventBody('phase') : eventBody('progress'));
    await until(() => seen.length === 60, 5000, 'events');
    expect(p.client.state).toBe('connected');
    expect(p.client.stats.connects).toBe(connects);
    expect(auditFor('move-event-refused')).toHaveLength(0);
    expect(auditFor('command-result')).toHaveLength(0);
  });

  it('a throwing hook does not close the connection', async () => {
    const p = await proxy(['move.send']);
    s.built.hub.deps.onProxyEvent = () => { throw new Error('boom'); };
    for (let i = 0; i < 30; i++) p.client.emitEvent(eventBody('phase'));
    await new Promise((r) => setTimeout(r, 300));
    expect(p.client.state).toBe('connected');
  });
});

describe('move commands', () => {
  it('lists move-event-refused in AUDIT_ACTIONS', () => {
    expect(AUDIT_ACTIONS).toContain('move-event-refused');
  });

  it('maps the allow entries per role', () => {
    expect(requiredEntries('move.open', {})).toEqual(['move.send']);
    expect(requiredEntries('move.offer', {})).toEqual(['move.receive']);
    expect(requiredEntries('move.start', {})).toEqual(['move.receive']);
    expect(requiredEntries('move.cancel', { role: 'source' })).toEqual(['move.send']);
    expect(requiredEntries('move.cancel', { role: 'target' })).toEqual(['move.receive']);
    expect(requiredEntries('move.finish', { role: 'target' })).toEqual(['move.receive']);
    expect(requiredEntries('move.finish', { role: 'source' })).toEqual(['move.send']);
  });

  it('summariseArgs drops token, tokenHash and targetPublicKey', () => {
    const o = summariseArgs('move.offer', cmdArgs('offer'));
    expect(JSON.stringify(o)).not.toContain('example-move-token');
    expect(o).not.toHaveProperty('token');
    expect(o.moveId).toBe(MOVE_ID);
    expect(summariseArgs('move.open', cmdArgs('open'))).not.toHaveProperty('tokenHash');
    expect(summariseArgs('move.go', cmdArgs('go'))).not.toHaveProperty('targetPublicKey');
  });

  it('move.cancel role target requires move.receive in the proxy\'s reported allow list', async () => {
    const p = await proxy(['move.send']);
    const target = { ...cmdArgs('cancel'), role: 'target', copied: 'delete' };
    expect(() => s.built.commands.create('admin@example.com', p.accountId, p.proxyId, 'move.cancel', target)).toThrow(/not_allowed_on_proxy/);
    const row = s.built.commands.create('admin@example.com', p.accountId, p.proxyId, 'move.cancel', { v: 1, moveId: MOVE_ID, role: 'source' });
    await until(() => s.built.commands.get(p.accountId, p.proxyId, row.id).state === 'done', 5000, 'done');
  });

  it('all nine move commands can be created and answered', async () => {
    const p = await proxy(['move.send', 'move.receive']);
    for (const c of ['targets', 'open', 'offer', 'answer', 'start', 'go', 'release', 'finish', 'cancel']) {
      const row = s.built.commands.create('system', p.accountId, p.proxyId, `move.${c}` as any, cmdArgs(c));
      await until(() => s.built.commands.get(p.accountId, p.proxyId, row.id).state === 'done', 5000, `${c} done`);
    }
  });

  it('token never stored after final', async () => {
    const p = await proxy(['move.receive']);
    const args = cmdArgs('offer');
    const row = s.built.commands.create('system', p.accountId, p.proxyId, 'move.offer', args);
    // While open the proxy needs the token to be resent, so it is stored; the audit never has it.
    expect(JSON.stringify(auditFor('command-create'))).not.toContain(args.token);
    await until(() => s.built.commands.get(p.accountId, p.proxyId, row.id).state === 'done', 5000, 'done');
    const db = s.built.db;
    const stored = (db.prepare('SELECT args FROM commands WHERE id = ?').get(row.id) as { args: string }).args;
    expect(stored).not.toContain(args.token);
    expect(JSON.parse(stored).moveId).toBe(MOVE_ID);
    expect(JSON.stringify(auditFor('command-create'))).not.toContain(args.token);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain(args.token);
    expect(JSON.stringify(s.built.commands.get(p.accountId, p.proxyId, row.id))).not.toContain(args.token);
  });

  it('token not stored after a refused or given-up offer either', async () => {
    const p = await proxy(['move.receive']);
    p.client.refuseNext = { code: 'busy' };
    const args = cmdArgs('offer');
    const row = s.built.commands.create('system', p.accountId, p.proxyId, 'move.offer', args);
    await until(() => s.built.commands.get(p.accountId, p.proxyId, row.id).state === 'refused', 5000, 'refused');
    const stored = (s.built.db.prepare('SELECT args FROM commands WHERE id = ?').get(row.id) as { args: string }).args;
    expect(stored).not.toContain(args.token);
  });
});
