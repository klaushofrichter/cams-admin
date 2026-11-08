// What a Delete takes with it (account-move findings 2026-11-07): the confirmation names what goes and what stays,
// with counts from GET …/delete-preview (read only). The counts must match what the delete really does.
import { afterEach, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

const built: { close(): Promise<void> }[] = [];
afterEach(async () => { while (built.length) await built.pop()!.close(); });

describe('delete preview', () => {
  const dir = tmpDir();
  const app = () => { const a = testApp(dir); built.push(a); return a; };

  // An account with two proxies (p, q), cameras, finished moves, commands, tokens, a cams route, a user.
  async function fleet(a: ReturnType<typeof app>) {
    const acc = (await a.api('post', '/accounts', { name: 'home', displayName: 'Home' })).body;
    const p = (await a.api('post', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' })).body;
    const q = (await a.api('post', `/accounts/${acc.id}/proxies`, { name: 'mini', displayName: 'Mini', runsOn: 'local-host' })).body;
    await a.api('post', `/accounts/${acc.id}/users`, { email: 'u@example.com', role: 'viewer' });
    const c1 = (await a.api('post', `/accounts/${acc.id}/cameras`, { camsId: 'c1', name: 'One', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1' })).body;
    await a.api('post', `/accounts/${acc.id}/cameras`, { camsId: 'c2', name: 'Two', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam2' });
    await a.api('post', `/accounts/${acc.id}/cameras`, { camsId: 'c3', name: 'Three', kind: 'camera', proxyId: q.id, proxyCameraId: 'cam1' });
    const db = a.db;
    const t = Date.now();
    const move = db.prepare(`INSERT INTO moves (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, created_at, updated_at, ended_at) VALUES (?,?,?,?,?,?, 'done', ?,?,?)`);
    move.run('mov_A', acc.id, c1.id, q.id, p.id, 'req_A', t, t, t);
    move.run('mov_B', acc.id, c1.id, p.id, q.id, 'req_B', t, t, t);
    const cmd = db.prepare(`INSERT INTO commands (id, account_id, proxy_id, actor, command, args, state, created_at) VALUES (?,?,?, 'system', 'config.get', '{}', 'done', ?)`);
    for (const id of ['cmd_1', 'cmd_2', 'cmd_3']) cmd.run(id, acc.id, p.id, t);
    cmd.run('cmd_4', acc.id, q.id, t);
    const tok = db.prepare(`INSERT INTO proxy_tokens (id, account_id, proxy_id, kind, holder, label, hash, state, issued_revision, created_at, created_by) VALUES (?,?,?, 'client', 'manual', 'x', ?, ?, 1, ?, 'admin@example.com')`);
    tok.run('tok_1', acc.id, p.id, `sha256:${'1'.repeat(64)}`, 'active', t);
    tok.run('tok_2', acc.id, p.id, `sha256:${'2'.repeat(64)}`, 'revoked', t);
    db.prepare(`INSERT INTO cams_instances (id, name, display_name, state, created_at, updated_at) VALUES ('cms_1', 'cluster', 'Cluster', 'enrolled', ?, ?)`).run(t, t);
    db.prepare(`INSERT INTO cams_instance_accounts (instance_id, account_id) VALUES ('cms_1', ?)`).run(acc.id);
    db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id) VALUES ('cms_1', ?)`).run(p.id);
    return { acc, p, q };
  }

  it('a proxy: moves, tokens, viewer routes and keys go; cameras and commands stay; the audit log stays', async () => {
    const a = app();
    const { acc, p } = await fleet(a);
    const r = await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/delete-preview`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cameras: 2, moves: 2, activeMoves: 0, tokens: 2, liveTokens: 1, routes: 1, keys: 0, commands: 3, switches: [] });
    // What the dialog says is what happens.
    expect((await a.api('delete', `/accounts/${acc.id}/proxies/${p.id}`)).status).toBe(204);
    const n = (sql: string, ...args: string[]) => (a.db.prepare(sql).get(...args) as { n: number }).n;
    expect(n('SELECT count(*) n FROM moves')).toBe(0);
    expect(n('SELECT count(*) n FROM proxy_tokens')).toBe(0);
    expect(n('SELECT count(*) n FROM cams_instance_routes')).toBe(0);
    expect(n(`SELECT count(*) n FROM cameras WHERE account_id = ? AND proxy_id IS NULL`, acc.id)).toBe(2);
    expect(n(`SELECT count(*) n FROM commands WHERE proxy_id IS NULL`)).toBe(3);
    expect(n(`SELECT count(*) n FROM audit_log WHERE action = 'proxy-delete'`)).toBe(1);
  });

  it('a proxy: another account, an unknown proxy → 404; read only (no audit)', async () => {
    const a = app();
    const { acc, p } = await fleet(a);
    const other = (await a.api('post', '/accounts', { name: 'other', displayName: 'Other' })).body;
    expect((await a.api('get', `/accounts/${other.id}/proxies/${p.id}/delete-preview`)).status).toBe(404);
    expect((await a.api('get', `/accounts/${acc.id}/proxies/prx_ZZZZZZZZZZZZZZZZZZZZ/delete-preview`)).status).toBe(404);
    const before = (a.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
    await a.api('get', `/accounts/${acc.id}/proxies/${p.id}/delete-preview`);
    expect((a.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n).toBe(before);
  });

  it('an account: everything in it goes, the cams instances and viewer tokens lose it; the audit log stays', async () => {
    const a = app();
    const { acc } = await fleet(a);
    const r = await a.api('get', `/accounts/${acc.id}/delete-preview`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ users: 1, proxies: 2, cameras: 3, moves: 2, activeMoves: 0, commands: 4, tokens: 2, routes: 1, switches: 0, camsInstances: 1, viewerTokens: 0 });
    expect((await a.api('get', '/accounts/acc_ZZZZZZZZZZZZZZZZZZZZ/delete-preview')).status).toBe(404);
    expect((await a.api('delete', `/accounts/${acc.id}`, { confirmName: 'home' })).status).toBe(204);
    const n = (sql: string) => (a.db.prepare(sql).get() as { n: number }).n;
    for (const t of ['moves', 'commands', 'proxy_tokens', 'cams_instance_routes', 'cameras', 'proxies', 'account_users', 'cams_instance_accounts']) expect(n(`SELECT count(*) n FROM ${t}`), t).toBe(0);
    expect(n(`SELECT count(*) n FROM cams_instances`)).toBe(1);
    expect(n(`SELECT count(*) n FROM audit_log WHERE action = 'account-delete'`)).toBe(1);
  });
});
