import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

// Spec §11.2: every write records exactly one audit entry. The table below
// lists every write route; a write route missing from it fails the test.
describe('audit completeness', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());
  const count = () => (a.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
  const ids: Record<string, string> = {};

  type Row = [method: 'post' | 'patch' | 'put' | 'delete', pattern: string, path: () => string, body: () => unknown, action: string | string[]];
  const table: Row[] = [
    ['post', '/accounts', () => '/accounts', () => ({ name: 'home', displayName: 'Home' }), 'account-create'],
    ['patch', '/accounts/:accountId', () => `/accounts/${ids.acc}`, () => ({ displayName: 'H', version: 1 }), 'account-update'],
    ['post', '/accounts/:accountId/users', () => `/accounts/${ids.acc}/users`, () => ({ email: 'u@example.com', role: 'viewer' }), 'user-create'],
    ['patch', '/accounts/:accountId/users/:userId', () => `/accounts/${ids.acc}/users/${ids.usr}`, () => ({ role: 'admin', version: 1 }), 'user-update'],
    ['post', '/accounts/:accountId/proxies', () => `/accounts/${ids.acc}/proxies`, () => ({ name: 'pi', displayName: 'Pi', runsOn: 'cloud' }), 'proxy-create'],
    ['patch', '/accounts/:accountId/proxies/:proxyId', () => `/accounts/${ids.acc}/proxies/${ids.prx}`, () => ({ notes: 'n', version: 1 }), 'proxy-update'],
    ['post', '/accounts/:accountId/proxies/:proxyId/enrollment-codes', () => `/accounts/${ids.acc}/proxies/${ids.prx}/enrollment-codes`, () => ({}), 'enrollment-code-create'],
    ['delete', '/accounts/:accountId/proxies/:proxyId/enrollment-codes/:codeId', () => `/accounts/${ids.acc}/proxies/${ids.prx}/enrollment-codes/${ids.enr}`, () => ({}), 'enrollment-code-cancel'],
    ['post', '/accounts/:accountId/proxies/:proxyId/keys/:keyId/revoke', () => `/accounts/${ids.acc}/proxies/${ids.prx}/keys/${ids.key}/revoke`, () => ({}), 'key-revoke'],
    ['post', '/accounts/:accountId/proxies/:proxyId/adopt', () => `/accounts/${ids.acc}/proxies/${ids.prx}/adopt`, () => ({ proxyCameraId: 'cam2', kind: 'camera' }), 'camera-adopt'],
    // P2: a token change is its own record plus the tokens.apply it queues.
    ['post', '/accounts/:accountId/proxies/:proxyId/tokens', () => `/accounts/${ids.acc}/proxies/${ids.prx}/tokens`, () => ({ kind: 'client', label: 'cams' }), ['token-issue', 'command-create']],
    ['post', '/accounts/:accountId/proxies/:proxyId/tokens/:tokenId/retire', () => `/accounts/${ids.acc}/proxies/${ids.prx}/tokens/${ids.tok}/retire`, () => ({ hours: 24 }), ['token-retire', 'command-create']],
    ['post', '/accounts/:accountId/proxies/:proxyId/tokens/:tokenId/revoke', () => `/accounts/${ids.acc}/proxies/${ids.prx}/tokens/${ids.tok}/revoke`, () => ({}), ['token-revoke', 'command-create']],
    ['post', '/accounts/:accountId/proxies/:proxyId/tokens/confirm-restore', () => `/accounts/${ids.acc}/proxies/${ids.prx}/tokens/confirm-restore`, () => ({}), ['command-create']],
    ['post', '/accounts/:accountId/proxies/:proxyId/tokens/apply', () => `/accounts/${ids.acc}/proxies/${ids.prx}/tokens/apply`, () => ({}), ['command-create']],
    ['post', '/accounts/:accountId/cameras', () => `/accounts/${ids.acc}/cameras`, () => ({ camsId: 's1', name: 'S1', kind: 'sim' }), 'camera-create'],
    ['patch', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({ name: 'S one', version: 1 }), 'camera-update'],
    ['put', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({ runsOn: 'mac' }), 'sim-update'],
    ['delete', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({}), 'sim-delete'],
    ['delete', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({}), 'camera-delete'],
    ['post', '/accounts/:accountId/proxies/:proxyId/block', () => `/accounts/${ids.acc}/proxies/${ids.prx}/block`, () => ({}), 'proxy-block'],
    ['delete', '/accounts/:accountId/proxies/:proxyId', () => `/accounts/${ids.acc}/proxies/${ids.prx}`, () => ({}), 'proxy-delete'],
    ['delete', '/accounts/:accountId/users/:userId', () => `/accounts/${ids.acc}/users/${ids.usr}`, () => ({}), 'user-delete'],
    ['post', '/backup/now', () => '/backup/now', () => ({}), 'backup-now'],
    ['delete', '/accounts/:accountId', () => `/accounts/${ids.acc}`, () => ({ confirmName: 'home' }), 'account-delete'],
    // Last: it ends every session, this test's too.
    ['post', '/sessions/end', () => '/sessions/end', () => ({}), 'sessions-ended'],
  ];

  it('the table covers every write route of the API', () => {
    expect(a.writeRoutes().sort()).toEqual(table.map(([m, p]) => `${m.toUpperCase()} ${p}`).sort());
  });

  it.each(table.map((r) => [`${r[0].toUpperCase()} ${r[1]}`, r] as const))('%s writes exactly its audit records', async (_n, [m, , path, body, action]) => {
    const actions = Array.isArray(action) ? action : [action];
    const before = count();
    const r = await a.api(m, path(), body());
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    // Ids for the next rows.
    if (action === 'account-create') ids.acc = r.body.id;
    if (action === 'user-create') ids.usr = r.body.id;
    if (action === 'proxy-create') {
      ids.prx = r.body.id;
    }
    if (action === 'enrollment-code-create') ids.enr = r.body.id;
    if (action === 'enrollment-code-cancel') {
      // An enrolled key for the revoke row, and a report for the adopt row.
      a.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(ids.prx);
      a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000001', ?, 'pk', 'fp', 1, 1)`).run(ids.prx);
      ids.key = 'key_00000000000000000001';
      // A P2 proxy that allows tokens.apply (for the token rows).
      a.status.hello(ids.prx, 'v2', Date.now(), ['status', 'commands']);
      a.status.heartbeat(ids.prx, { summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 } }, truncated: false }, Date.now());
    }
    if (actions[0] === 'token-revoke') a.tokens.onHeartbeat(ids.prx, { revision: 99 }); // a proxy ahead (restored cams-admin), for the confirm-restore row
    if (actions[0] === 'token-issue') {
      ids.tok = r.body.tokenId;
      a.db.prepare(`UPDATE proxy_tokens SET state = 'active' WHERE id = ?`).run(ids.tok); // as if the proxy confirmed it
    }
    if (action === 'camera-create') ids.cam = r.body.id;
    expect(count() - before).toBe(actions.length);
    expect(a.audit.list({ limit: actions.length }).items.map((x) => x.action).sort()).toEqual([...actions].sort());
  });
});
