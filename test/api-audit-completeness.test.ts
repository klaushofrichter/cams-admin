import { afterAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const REV = `sha256:${'a'.repeat(64)}`;
const P3_ALLOW = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action:camera-test', 'camera.name.set', 'proxy.restart'];

// Spec §11.2: every write records exactly one audit entry. The table below
// lists every write route; a write route missing from it fails the test.
describe('audit completeness', () => {
  const dir = tmpDir();
  const a = testApp(dir);
  afterAll(() => a.close());
  const count = () => (a.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
  const ids: Record<string, string> = {};

  const IMPORT_FILE = { v: 1, kind: 'cams-export', exportedAt: 1, camsVersion: 't', source: 'cameras-file', cameras: [{ id: 'imp1', name: 'Imp', host: '192.0.2.40', protocol: 'https', user: 'cams' }], counts: { preferencesUsers: 0, proxySwitchOff: 0, tlsCas: 0, tlsPins: 0 } };
  type Row = [method: 'post' | 'patch' | 'put' | 'delete', pattern: string, path: () => string, body: () => unknown, action: string | string[]];
  const table: Row[] = [
    ['post', '/accounts', () => '/accounts', () => ({ name: 'home', displayName: 'Home' }), 'account-create'],
    ['patch', '/accounts/:accountId', () => `/accounts/${ids.acc}`, () => ({ displayName: 'H', version: 1 }), 'account-update'],
    ['post', '/accounts/:accountId/users', () => `/accounts/${ids.acc}/users`, () => ({ email: 'u@example.com', role: 'viewer' }), 'user-create'],
    ['patch', '/accounts/:accountId/users/:userId', () => `/accounts/${ids.acc}/users/${ids.usr}`, () => ({ role: 'admin', version: 1 }), 'user-update'],
    ['post', '/accounts/:accountId/proxies', () => `/accounts/${ids.acc}/proxies`, () => ({ name: 'pi', displayName: 'Pi', runsOn: 'cloud' }), 'proxy-create'],
    ['patch', '/accounts/:accountId/proxies/:proxyId', () => `/accounts/${ids.acc}/proxies/${ids.prx}`, () => ({ notes: 'n', version: 1 }), 'proxy-update'],
    // P4: cams instances (a route needs a proxy of a served account).
    ['post', '/cams-instances', () => '/cams-instances', () => ({ name: 'cluster', displayName: 'Cluster', accounts: [ids.acc] }), 'cams-instance-create'],
    ['patch', '/cams-instances/:instanceId', () => `/cams-instances/${ids.cms}`, () => ({ displayName: 'C', version: 1 }), 'cams-instance-update'],
    ['put', '/cams-instances/:instanceId/routes/:proxyId', () => `/cams-instances/${ids.cms}/routes/${ids.prx}`, () => ({ url: 'http://127.0.0.1:8480', hidden: false }), 'route-update'],
    ['delete', '/cams-instances/:instanceId/routes/:proxyId', () => `/cams-instances/${ids.cms}/routes/${ids.prx}`, () => ({}), 'route-update'],
    ['post', '/cams-instances/:instanceId/enrollment-codes', () => `/cams-instances/${ids.cms}/enrollment-codes`, () => ({ lifetimeH: 1 }), 'cams-enrollment-code-create'],
    ['delete', '/cams-instances/:instanceId/enrollment-codes/:codeId', () => `/cams-instances/${ids.cms}/enrollment-codes/${ids.cenr}`, () => ({}), 'cams-enrollment-code-cancel'],
    ['post', '/cams-instances/:instanceId/keys/:keyId/revoke', () => `/cams-instances/${ids.cms}/keys/${ids.ckey}/revoke`, () => ({}), 'cams-key-revoke'],
    // The apply is bound to its dry run (review M2): both records.
    ['post', '/accounts/:accountId/import', () => `/accounts/${ids.acc}/import`, () => ({ instanceId: ids.cms, file: IMPORT_FILE, apply: true, planId: a.importer.run('admin@example.com', ids.acc, ids.cms, IMPORT_FILE, { apply: false, acceptMismatch: [], createProxies: false, hideUnlisted: false }).planId }), ['import-run', 'import-apply', 'camera-create']],
    // Per-instance camera overrides (migration 7), on the camera the import created.
    ['put', '/cams-instances/:instanceId/camera-overrides/:cameraId', () => `/cams-instances/${ids.cms}/camera-overrides/${ids.impcam}`, () => ({ host: 'from-proxy', cameraUser: 'proxy' }), 'camera-override-set'],
    ['delete', '/cams-instances/:instanceId/camera-overrides/:cameraId', () => `/cams-instances/${ids.cms}/camera-overrides/${ids.impcam}`, () => ({}), 'camera-override-clear'],
    ['post', '/cams-instances/:instanceId/rotate', () => `/cams-instances/${ids.cms}/rotate`, () => ({}), 'cams-rotate'],
    ['post', '/cams-instances/:instanceId/block', () => `/cams-instances/${ids.cms}/block`, () => ({}), 'cams-instance-block'],
    ['delete', '/cams-instances/:instanceId', () => `/cams-instances/${ids.cms}`, () => ({ confirmName: 'cluster' }), 'cams-instance-delete'],
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
    // P3: every settings change, camera action and restart is one command-create (R3-19).
    ['post', '/accounts/:accountId/proxies/:proxyId/config/refresh', () => `/accounts/${ids.acc}/proxies/${ids.prx}/config/refresh`, () => ({}), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/config/preview', () => `/accounts/${ids.acc}/proxies/${ids.prx}/config/preview`, () => ({ set: { 'sse.pingS': 7 } }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/config/apply', () => `/accounts/${ids.acc}/proxies/${ids.prx}/config/apply`, () => ({ previewId: ids.preview }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/config/rollback/preview', () => `/accounts/${ids.acc}/proxies/${ids.prx}/config/rollback/preview`, () => ({ cmdId: ids.applied }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/config/rollback/apply', () => `/accounts/${ids.acc}/proxies/${ids.prx}/config/rollback/apply`, () => ({ previewId: ids.rbPreview }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/actions', () => `/accounts/${ids.acc}/proxies/${ids.prx}/actions`, () => ({ camera: 'cam1', action: 'camera-test' }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/cameras/:camera/name', () => `/accounts/${ids.acc}/proxies/${ids.prx}/cameras/cam1/name`, () => ({ name: 'Porch' }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/restart', () => `/accounts/${ids.acc}/proxies/${ids.prx}/restart`, () => ({ confirm: 'proxy.restart' }), 'command-create'],
    ['post', '/accounts/:accountId/cameras', () => `/accounts/${ids.acc}/cameras`, () => ({ camsId: 's1', name: 'S1', kind: 'sim' }), 'camera-create'],
    ['patch', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({ name: 'S one', version: 1 }), 'camera-update'],
    ['put', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({ runsOn: 'mac' }), 'sim-update'],
    ['delete', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({}), 'sim-delete'],
    ['delete', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({}), 'camera-delete'],
    ['post', '/accounts/:accountId/proxies/:proxyId/block', () => `/accounts/${ids.acc}/proxies/${ids.prx}/block`, () => ({}), 'proxy-block'],
    ['delete', '/accounts/:accountId/proxies/:proxyId', () => `/accounts/${ids.acc}/proxies/${ids.prx}`, () => ({}), 'proxy-delete'],
    ['delete', '/accounts/:accountId/users/:userId', () => `/accounts/${ids.acc}/users/${ids.usr}`, () => ({}), 'user-delete'],
    // Camera moves (Task 8): one record each; the moves are made by hand in the matching phase.
    ['post', '/moves/:moveId/cancel', () => `/moves/${ids.mvCancel}/cancel`, () => ({ copied: 'delete', confirm: 'cancel' }), 'move-cancel'],
    ['post', '/moves/:moveId/end-transfer', () => `/moves/${ids.mvEnd}/end-transfer`, () => ({ confirm: 'end transfer' }), 'move-end-transfer'],
    ['post', '/moves/:moveId/give-up', () => `/moves/${ids.mvGive}/give-up`, () => ({ confirm: 'give up' }), 'move-give-up'],
    ['delete', '/moves/:moveId', () => `/moves/${ids.mvRejected}`, () => ({}), 'move-delete'],
    // move.begin: a clean precheck (no fix), so the move-begin record and the command's.
    ['post', '/moves', () => '/moves', () => ({ sourceProxyId: ids.bgs, targetProxyId: ids.bgt, cameraId: 'beginporch', bounds: null }), ['move-begin', 'command-create']],
    // Diagnostics tokens (issue #45).
    ['post', '/diag-tokens', () => '/diag-tokens', () => ({ name: 'mac', days: 1 }), 'diag-token-issue'],
    ['post', '/diag-tokens/:tokenId/revoke', () => `/diag-tokens/${ids.dgt}/revoke`, () => ({}), 'diag-token-revoke'],
    // Operations tokens.
    ['post', '/ops-tokens', () => '/ops-tokens', () => ({ name: 'script', scopes: ['moves'], days: 1 }), 'ops-token-issue'],
    ['post', '/ops-tokens/:tokenId/revoke', () => `/ops-tokens/${ids.opt}/revoke`, () => ({}), 'ops-token-revoke'],
    ['post', '/backup/now', () => '/backup/now', () => ({}), 'backup-now'],
    ['delete', '/accounts/:accountId', () => `/accounts/${ids.acc}`, () => ({ confirmName: 'home' }), 'account-delete'],
    // Last: it ends every session, this test's too.
    ['post', '/sessions/end', () => '/sessions/end', () => ({}), 'sessions-ended'],
  ];

  it('the table covers every write route of the API', () => {
    expect(a.writeRoutes().sort()).toEqual(table.map(([m, p]) => `${m.toUpperCase()} ${p}`).sort());
  });

  it.each(table.map((r) => [`${r[0].toUpperCase()} ${r[1]}`, r] as const))('%s writes exactly its audit records', async (_n, [m, pattern, path, body, action]) => {
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
    if (action === 'cams-instance-create') ids.cms = r.body.id;
    if (action === 'cams-enrollment-code-create') {
      ids.cenr = r.body.id;
      ids.ckey = 'key_00000000000000000009';
      a.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, 'cpk', 'fp', 1, 1)`).run(ids.ckey, ids.cms);
    }
    if (action === 'enrollment-code-cancel') {
      // An enrolled key for the revoke row, and a report for the adopt row.
      a.db.prepare(`UPDATE proxies SET state='enrolled' WHERE id=?`).run(ids.prx);
      a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000001', ?, 'pk', 'fp', 1, 1)`).run(ids.prx);
      ids.key = 'key_00000000000000000001';
      // A P2 proxy that allows tokens.apply (for the token rows).
      // A stored settings view first, so the heartbeat below queues no read of its own.
      a.config.storeView(ids.prx, 'cmd_0123456789ABCDEFGHJK', { revision: REV, cameras: ['cam1'], omittedCameras: [], paths: { 'sse.pingS': { v: 30, s: 'default' } }, settable: { 'sse.pingS': { type: 'integer' } } });
      a.status.hello(ids.prx, 'v2', Date.now(), ['status', 'commands']);
      a.status.heartbeat(ids.prx, { summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply', ...P3_ALLOW], seenWindow: 1000 } }, truncated: false }, Date.now());
    }
    // The proxy isn't connected: finish the P3 commands by hand, as the proxy would.
    const finish = (id: string, result: object) => a.db.prepare(`UPDATE commands SET state = 'done', finished_at = ?, result = ? WHERE id = ?`).run(Date.now(), JSON.stringify({ body: { phase: 'done', status: 'ok', result } }), id);
    const change = { dryRun: false, baseRevision: REV, revision: REV, changes: [{ path: 'sse.pingS', from: 30, to: 7, sourceFrom: 'default', sourceTo: 'override' }], unchanged: [] };
    if (pattern.endsWith('/config/preview')) finish(ids.preview = r.body.commandId, { ...change, dryRun: true });
    if (pattern.endsWith('/config/apply')) finish(ids.applied = r.body.commandId, change);
    if (pattern.endsWith('/config/rollback/preview')) finish(ids.rbPreview = r.body.commandId, { ...change, dryRun: true, of: ids.applied });
    if (actions[0] === 'token-revoke') a.tokens.onHeartbeat(ids.prx, { revision: 99 }); // a proxy ahead (restored cams-admin), for the confirm-restore row
    if (actions[0] === 'token-issue') {
      ids.tok = r.body.tokenId;
      a.db.prepare(`UPDATE proxy_tokens SET state = 'active' WHERE id = ?`).run(ids.tok); // as if the proxy confirmed it
    }
    if (action === 'diag-token-issue') ids.dgt = r.body.item.id;
    if (action === 'ops-token-issue') ids.opt = r.body.item.id;
    if (action === 'camera-create') ids.cam = r.body.id;
    if (action === 'camera-create') {
      // Two moves for the move rows: proxies and cameras of their own, in copying.
      const mk = (tag: string, phase = 'copying') => {
        const px = [`prx_${tag}s`, `prx_${tag}t`];
        for (const [i, id] of px.entries()) a.db.prepare(`INSERT INTO proxies (id, account_id, name, display_name, runs_on, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'cluster', 'enrolled', 1, 1)`).run(id, ids.acc, `${tag}${i}`, `${tag}${i}`);
        a.db.prepare(`INSERT INTO cameras (id, account_id, proxy_id, cams_id, proxy_camera_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'pc', 'M', 'camera', 1, 1)`).run(`cam_${tag}`, ids.acc, px[0], `m${tag}`);
        const id = `mv_${tag.padEnd(20, '0')}`;
        a.db.prepare(`INSERT INTO moves (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(id, ids.acc, `cam_${tag}`, px[0], px[1], `rq_${tag}`, phase);
        return id;
      };
      ids.mvCancel = mk('c');
      ids.mvEnd = mk('e');
      ids.mvGive = mk('g', 'returning');
      ids.mvRejected = mk('r', 'rejected');
      a.db.prepare('UPDATE moves SET ended_at = 1 WHERE id = ?').run(ids.mvRejected);
      // Two online proxies that take moves, and a camera on the first, for the POST /moves row.
      const live = (tag: string) => {
        const id = `prx_${tag.padEnd(20, '0')}`;
        a.db.prepare(`INSERT INTO proxies (id, account_id, name, display_name, runs_on, state, url, tls_site, tls_servername, created_at, updated_at) VALUES (?, ?, ?, ?, 'cluster', 'enrolled', 'http://192.0.2.9:8480', 'site-bg', ?, 1, 1)`).run(id, ids.acc, tag, tag, `${tag}.internal`);
        a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, ?, 1, 1)`).run(`key_${tag.padEnd(20, '0')}`, id, `pk${tag}`, `fp${tag}`);
        a.status.hello(id, 'v2', Date.now(), ['status', 'commands']);
        a.status.heartbeat(id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now(), site: 'site-bg' }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['move.send', 'move.receive'], seenWindow: 1000 } }, truncated: false }, Date.now());
        return id;
      };
      ids.bgs = live('BGSRC');
      ids.bgt = live('BGTGT');
      a.db.prepare(`INSERT INTO cameras (id, account_id, proxy_id, cams_id, proxy_camera_id, name, kind, created_at, updated_at) VALUES ('cam_bgbegin', ?, ?, 'beginporch', 'pc', 'B', 'camera', 1, 1)`).run(ids.acc, ids.bgs);
    }
    // The account goes next: its moves must end first (an active one refuses the delete); ended ones go with it.
    if (action === 'backup-now') a.db.exec('UPDATE moves SET ended_at = 1 WHERE ended_at IS NULL');
    if (actions.includes('import-apply')) ids.impcam = (a.db.prepare(`SELECT id FROM cameras WHERE cams_id = 'imp1'`).get() as { id: string }).id;
    expect(count() - before).toBe(actions.length);
    expect(a.audit.list({ limit: actions.length }).items.map((x) => x.action).sort()).toEqual([...actions].sort());
  });
});
