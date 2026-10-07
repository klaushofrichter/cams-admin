import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync, statSync } from 'fs';
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
