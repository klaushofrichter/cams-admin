import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, copyFileSync, existsSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch } from './helpers/cams';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { generateToken } from '../server/tokens/service';

// Security review 2026-10-07 (M5): a restore must not bring back a blocked
// instance, a revoked cams key or revoked cams-held tokens. They are kept in
// a journal next to the database (not in it), replayed at every start.
describe('cams revocations survive a restore', () => {
  const dir = tmpDir();
  let s: Running;
  afterAll(() => s.stop());

  it('a key revoked (and its tokens) and an instance blocked after the backup are revoked again after the restore', async () => {
    s = await startServer(dir, { TICK_MS: '60000' });
    const acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    const px = await s.api('POST', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
    s.built.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(px.id);
    s.built.status.hello(px.id, 'v2', Date.now(), ['status', 'commands']);
    s.built.status.heartbeat(px.id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 } }, truncated: false }, Date.now());
    const a = await s.api('POST', '/cams-instances', { name: 'a', displayName: 'A', accounts: [acc.id] });
    const b = await s.api('POST', '/cams-instances', { name: 'b', displayName: 'B', accounts: [acc.id] });
    for (const i of [a, b]) await s.api('PUT', `/cams-instances/${i.id}/routes/${px.id}`, { url: null, hidden: false });
    const ka = await enrollCamsKey(s, a.id);
    await enrollCamsKey(s, b.id);
    const t = await signedFetch(s, ka, 'POST', '/cams/v1/tokens', { v: 1, proxyId: px.id, kind: 'client', hash: generateToken().hash });
    const tokenId = (await t.json()).tokenId;
    // The backup.
    const backup = join(dir, 'backup.db');
    s.built.db.exec(`VACUUM INTO '${backup}'`);
    // After it: a's key revoked (and its token), b blocked.
    await s.api('POST', `/cams-instances/${a.id}/keys/${ka.keyId}/revoke`, {});
    await s.api('POST', `/cams-instances/${b.id}/block`, {});
    const journal = join(s.dir, 'cams-revocations.jsonl');
    expect(existsSync(journal)).toBe(true);
    expect(statSync(journal).mode & 0o077).toBe(0);
    // The restore: the database goes back to the backup.
    await s.stop();
    const db = join(s.dir, 'cams-admin.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    rmSync(backup + '-wal', { force: true });
    (await import('fs')).copyFileSync(backup, db);
    s = await s.restart();
    const q = (sql: string, ...args: string[]) => s.built.db.prepare(sql).get(...args);
    expect(q('SELECT revoked_at IS NOT NULL r FROM cams_instance_keys WHERE id = ?', ka.keyId)).toEqual({ r: 1 });
    expect(q('SELECT state FROM proxy_tokens WHERE id = ?', tokenId)).toEqual({ state: 'revoked' });
    expect(q('SELECT state FROM cams_instances WHERE id = ?', b.id)).toEqual({ state: 'revoked' });
    // A keep-alive socket to the stopped server may be reused once: retry on a closed socket.
    const r = await signedFetch(s, ka, 'GET', '/cams/v1/config').catch(() => signedFetch(s, ka, 'GET', '/cams/v1/config'));
    expect(r.status).toBe(401);
    expect(s.built.audit.list({ action: 'cams-instance-block', limit: 5 }).items[0]).toMatchObject({ actorType: 'system', detail: expect.objectContaining({ replayed: true }) });
  });
});

// Code review 2026-11-14: a viewer token's access reduced after the backup
// (an account removed, admin lowered to viewer) stays reduced after a
// restore; an older journal without these entries still replays.
describe('viewer-token access reductions survive a restore', () => {
  const dir = tmpDir();
  let s: Running;
  afterAll(() => s.stop());

  const restore = async (backup: string) => {
    await s.stop();
    const db = join(s.dir, 'cams-admin.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    rmSync(backup + '-wal', { force: true });
    copyFileSync(backup, db);
    s = await s.restart();
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('an account removed and a demotion after the backup are applied again; an old-format journal line still replays', async () => {
    const keyFile = join(dir, 'viewer.key');
    writeFileSync(keyFile, randomBytes(32).toString('base64'));
    chmodSync(keyFile, 0o600);
    s = await startServer(dir, { TICK_MS: '60000', VIEWER_TOKEN_KEY_FILE: keyFile });
    const home = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    const away = await s.api('POST', '/accounts', { name: 'away', displayName: 'Away' });
    const t = (await s.api('POST', '/viewer-tokens', { name: 'Tablet', accountIds: [home.id, away.id], role: 'admin', days: 30 })).item;
    const old = (await s.api('POST', '/viewer-tokens', { name: 'Old', accountIds: [home.id], days: 30 })).item;
    // The backup.
    const backup = join(dir, 'backup.db');
    s.built.db.exec(`VACUUM INTO '${backup}'`);
    await tick();
    // After it: away removed, admin lowered to viewer.
    await s.api('PUT', `/viewer-tokens/${t.id}/accounts`, { accountIds: [home.id], version: t.version });
    await s.api('POST', `/viewer-tokens/${t.id}/role`, { role: 'viewer' });
    // A revoke in the format older releases wrote (the journal may hold lines from before this change).
    const journal = join(s.dir, 'cams-revocations.jsonl');
    appendFileSync(journal, JSON.stringify({ at: Date.now(), kind: 'viewer-token', tokenId: old.id, change: 'revoked' }) + '\n');
    await restore(backup);
    // From the database: a keep-alive socket to the stopped server may be closed under a fetch.
    const q = (sql: string, ...args: string[]) => s.built.db.prepare(sql).all(...args);
    expect(q('SELECT account_id FROM viewer_token_accounts WHERE token_id = ?', t.id)).toEqual([{ account_id: home.id }]);
    expect(q('SELECT role FROM viewer_tokens WHERE id = ?', t.id)).toEqual([{ role: 'viewer' }]);
    expect(q('SELECT revoked_at IS NOT NULL r FROM viewer_tokens WHERE id = ?', old.id)).toEqual([{ r: 1 }]);
    expect(s.built.audit.list({ action: 'viewer-token-accounts', limit: 5 }).items[0]).toMatchObject({ actorType: 'system', detail: expect.objectContaining({ replayed: true }) });
    expect(s.built.audit.list({ action: 'viewer-token-role', limit: 5 }).items[0]).toMatchObject({ actorType: 'system', detail: expect.objectContaining({ replayed: true }) });
  });
});
