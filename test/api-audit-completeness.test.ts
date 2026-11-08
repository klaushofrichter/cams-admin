import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';

const REV = `sha256:${'a'.repeat(64)}`;
const P3_ALLOW = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action:camera-test', 'camera.name.set', 'proxy.restart'];

// Spec §11.2: every write records exactly one audit entry. The table below
// lists every write route; a write route missing from it fails the test.
describe('audit completeness', () => {
  const dir = tmpDir();
  // A viewer token key, for the viewer token rows.
  const keyFile = join(dir, 'viewer.key');
  writeFileSync(keyFile, randomBytes(32).toString('base64'));
  chmodSync(keyFile, 0o600);
  const a = testApp(dir, { VIEWER_TOKEN_KEY_FILE: keyFile, SWITCH_READ_WAIT_MS: '20' });
  afterAll(() => a.close());
  // A rename needs the proxy on the live channel (no queued renames); the fake proxy here only reports.
  const realConnected = a.hub.connected.bind(a.hub);
  a.hub.connected = (proxyId: string) => proxyId === ids.prx || realConnected(proxyId);
  const count = () => (a.db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
  const ids: Record<string, string> = {};
  // A connected proxy for the Remove camera / Decommission rows (no camera reported for the decommission), set up when
  // the row's body is made.
  const decomSetup = (what: 'remove' | 'decommission') => {
    const px = what === 'remove' ? 'prx_RM000000000000000000' : 'prx_DC000000000000000000';
    a.db.prepare(`UPDATE commands SET state = 'done', finished_at = 1 WHERE command IN ('proxy.restart', 'camera.remove') AND state IN ('queued','sent','received')`).run();
    a.db.prepare(`INSERT INTO proxies (id, account_id, name, display_name, runs_on, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'local-host', 'enrolled', 1, 1)`).run(px, ids.acc, `dc-${what}`, `dc-${what}`);
    if (what === 'remove') a.db.prepare(`INSERT INTO cameras (id, account_id, proxy_id, cams_id, proxy_camera_id, name, kind, model, created_at, updated_at) VALUES ('cam_RM000000000000000000', ?, ?, 'rmcam', 'cam1', 'R', 'camera', 'RLC-1224A', 1, 1)`).run(ids.acc, px);
    a.status.hello(px, 'v2', Date.now(), ['status', 'commands']);
    const summary = makeSummary({ cameras: 1, now: Date.now() });
    if (what === 'decommission') summary.cameras = [];
    a.status.heartbeat(px, { summary, proxy: { ...makeProxyInfo({ now: Date.now() }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['camera.remove', 'proxy.unenroll'], seenWindow: 1000 } }, truncated: false }, Date.now());
    const hub = a.hub as unknown as { connected: (id: string) => boolean };
    const was = hub.connected.bind(a.hub);
    hub.connected = (id: string) => id === px || was(id);
    return what === 'remove' ? { content: 'keep', confirm: 'rmcam' } : { confirm: 'dc-decommission' };
  };

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
    // Vision management: a refresh is one command-create per proxy it asks (one here); a limit change its dry run.
    ['post', '/accounts/:accountId/vision/refresh', () => `/accounts/${ids.acc}/vision/refresh`, () => ({}), 'command-create'],
    ['put', '/accounts/:accountId/vision/proxies/:proxyId/providers/:provider', () => `/accounts/${ids.acc}/vision/proxies/${ids.prx}/providers/google-vision`, () => ({ monthlyLimit: 0 }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/actions', () => `/accounts/${ids.acc}/proxies/${ids.prx}/actions`, () => ({ camera: 'cam1', action: 'camera-test' }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/cameras/:camera/name', () => `/accounts/${ids.acc}/proxies/${ids.prx}/cameras/cam1/name`, () => ({ name: 'Porch' }), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/cameras/:camera/onboarding/refresh', () => `/accounts/${ids.acc}/proxies/${ids.prx}/cameras/cam1/onboarding/refresh`, () => ({}), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/restart', () => `/accounts/${ids.acc}/proxies/${ids.prx}/restart`, () => ({ confirm: 'proxy.restart' }), 'command-create'],
    ['post', '/accounts/:accountId/cameras', () => `/accounts/${ids.acc}/cameras`, () => ({ camsId: 's1', name: 'S1', kind: 'sim' }), 'camera-create'],
    ['patch', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({ name: 'S one', version: 1 }), 'camera-update'],
    ['put', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({ runsOn: 'mac' }), 'sim-update'],
    ['delete', '/accounts/:accountId/cameras/:cameraId/sim', () => `/accounts/${ids.acc}/cameras/${ids.cam}/sim`, () => ({}), 'sim-delete'],
    // Remove camera / Decommission proxy (spec 2026-11-08): the request is its command; camera-remove and proxy-unenroll
    // follow the proxy's answer (test/decommission.test.ts). Connected proxies of their own; earlier disruptive commands
    // finished by hand (the fleet gate allows one proxy at a time).
    ['post', '/accounts/:accountId/cameras/:cameraId/remove', () => `/accounts/${ids.acc}/cameras/cam_RM000000000000000000/remove`, () => decomSetup('remove'), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/decommission', () => `/accounts/${ids.acc}/proxies/prx_DC000000000000000000/decommission`, () => decomSetup('decommission'), 'command-create'],
    ['delete', '/accounts/:accountId/cameras/:cameraId', () => `/accounts/${ids.acc}/cameras/${ids.cam}`, () => ({}), 'camera-delete'],
    // Camera power: a declaration is its power record; a check, a power-cycle and a survey are their own start record
    // (camera-power-verify, camera-power-cycle, switch-survey per switch) and their first command (the camera.power.*
    // notices go to the camera's proxy only, and these cameras have none). Switches and cameras by hand.
    ['put', '/cameras/:cameraId/power', () => `/cameras/${ids.camA}/power`, () => ({ kind: 'adapter' }), 'camera-power-set'],
    ['post', '/cameras/:cameraId/power/verify', () => `/cameras/${ids.camV}/power/verify`, () => ({}), ['camera-power-verify', 'command-create']],
    ['post', '/cameras/:cameraId/power/cycle', () => `/cameras/${ids.camC}/power/cycle`, () => ({}), ['camera-power-cycle', 'command-create']],
    ['post', '/accounts/:accountId/switches/survey', () => `/accounts/${ids.acc}/switches/survey`, () => ({}), ['switch-survey', 'command-create']],
    ['post', '/switches/:switchId/survey', () => `/switches/${ids.swP2}/survey`, () => ({}), ['switch-survey', 'command-create']],
    // PoE switches: the record's own writes; a step through the operator is its command (the answer comes later).
    // Each step on a switch of its own (an open command makes a switch busy); the rows go before the proxy's delete.
    ['post', '/accounts/:accountId/switches', () => `/accounts/${ids.acc}/switches`, () => ({ name: 'GPS-208', host: '192.168.1.217', proxyId: ids.prx }), 'switch-create'],
    ['patch', '/switches/:switchId', () => `/switches/${ids.sw}`, () => ({ offSeconds: 20 }), 'switch-update'],
    ['post', '/switches/:switchId/test', () => `/switches/${ids.swTest}/test`, () => ({}), 'command-create'],
    ['post', '/switches/:switchId/move', () => `/switches/${ids.swMove}/move`, () => ({ proxyId: ids.bgs }), 'command-create'],
    ['post', '/switches/:switchId/read', () => `/switches/${ids.swRead}/read`, () => ({}), 'command-create'],
    ['delete', '/switches/:switchId', () => `/switches/${ids.sw}`, () => ({}), 'command-create'],
    ['post', '/accounts/:accountId/proxies/:proxyId/pins/from-report', () => `/accounts/${ids.acc}/proxies/${ids.prx}/pins/from-report`, () => ({}), 'proxy-update'],
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
    // Viewer tokens (design 2026-11-05).
    ['post', '/viewer-tokens', () => '/viewer-tokens', () => ({ name: 'tablet', accountIds: [ids.acc] }), 'viewer-token-create'],
    ['post', '/viewer-tokens/:tokenId/copy', () => `/viewer-tokens/${ids.vtk}/copy`, () => ({ what: 'link' }), 'viewer-token-copy'],
    ['post', '/viewer-tokens/:tokenId/validity', () => `/viewer-tokens/${ids.vtk}/validity`, () => ({ days: 30 }), 'viewer-token-validity'],
    ['put', '/viewer-tokens/:tokenId/accounts', () => `/viewer-tokens/${ids.vtk}/accounts`, () => ({ accountIds: [ids.acc], version: 2 }), 'viewer-token-accounts'],
    ['post', '/viewer-tokens/:tokenId/role', () => `/viewer-tokens/${ids.vtk}/role`, () => ({ role: 'admin' }), 'viewer-token-role'],
    ['post', '/viewer-tokens/:tokenId/revoke', () => `/viewer-tokens/${ids.vtk}/revoke`, () => ({}), 'viewer-token-revoke'],
    ['delete', '/viewer-tokens/:tokenId', () => `/viewer-tokens/${ids.vtk}`, () => ({}), 'viewer-token-delete'],
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
    if (action === 'viewer-token-create') ids.vtk = r.body.item.id;
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
      // A pin that differs from the reported one (set without an audit), for the pins/from-report row.
      a.db.prepare(`UPDATE proxies SET ca_fingerprints = ? WHERE id = ?`).run(JSON.stringify([`SHA256:${'AA'.repeat(32)}`]), ids.prx);
      a.status.hello(ids.prx, 'v2', Date.now(), ['status', 'commands']);
      a.status.heartbeat(ids.prx, { summary: makeSummary({ cameras: 2, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now(), site: 'home' }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply', ...P3_ALLOW, 'camera.onboarding.get', 'analytics.usage.get', 'switch.read', 'switch.poeOn', 'switch.forget', 'switch.locate', 'switch.survey', 'switch.cycle'], seenWindow: 1000 } }, truncated: false }, Date.now());
    }
    // The proxy isn't connected: finish the P3 commands by hand, as the proxy would.
    const finish = (id: string, result: object) => a.db.prepare(`UPDATE commands SET state = 'done', finished_at = ?, result = ? WHERE id = ?`).run(Date.now(), JSON.stringify({ body: { phase: 'done', status: 'ok', result } }), id);
    const change = { dryRun: false, baseRevision: REV, revision: REV, changes: [{ path: 'sse.pingS', from: 30, to: 7, sourceFrom: 'default', sourceTo: 'override' }], unchanged: [] };
    if (pattern.endsWith('/config/preview')) finish(ids.preview = r.body.commandId, { ...change, dryRun: true });
    if (pattern.endsWith('/config/apply')) finish(ids.applied = r.body.commandId, change);
    // An active key again (the key-revoke row revoked the first): Refresh asks online proxies only.
    if (pattern.endsWith('/config/rollback/apply')) a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_00000000000000000002', ?, 'pk2', 'fp2', 1, 1)`).run(ids.prx);
    // The Vision paths in the stored view, for the limit change's dry run.
    if (pattern.endsWith('/vision/refresh')) a.config.storeView(ids.prx, 'cmd_0123456789ABCDEFGHJK', { revision: REV, cameras: ['cam1'], omittedCameras: [], settable: { 'sse.pingS': { type: 'integer' }, 'analytics.googleVision.enabled': { type: 'boolean' }, 'analytics.googleVision.monthlyLimit': { type: 'integer' } },
      paths: { 'sse.pingS': { v: 30, s: 'default' }, 'analytics.googleVision.enabled': { v: true, s: 'file' }, 'analytics.googleVision.monthlyLimit': { v: 1000, s: 'default' }, 'analytics.googleVision.remoteMaxMonthly': { v: 0, s: 'default' } } });
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
        // Pinned as they report (else the heartbeat takes the reported pins, audited by the system).
        a.db.prepare(`INSERT INTO proxies (id, account_id, name, display_name, runs_on, state, url, tls_site, tls_servername, ca_fingerprints, created_at, updated_at) VALUES (?, ?, ?, ?, 'cluster', 'enrolled', 'http://192.0.2.9:8480', 'site-bg', ?, ?, 1, 1)`).run(id, ids.acc, tag, tag, `${tag}.internal`, JSON.stringify([`SHA256:${'CD'.repeat(32)}`]));
        a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, ?, 1, 1)`).run(`key_${tag.padEnd(20, '0')}`, id, `pk${tag}`, `fp${tag}`);
        a.status.hello(id, 'v2', Date.now(), ['status', 'commands']);
        a.status.heartbeat(id, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now(), site: 'site-bg' }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['move.send', 'move.receive', 'switch.read'], seenWindow: 1000 } }, truncated: false }, Date.now());
        return id;
      };
      ids.bgs = live('BGSRC');
      ids.bgt = live('BGTGT');
      a.db.prepare(`INSERT INTO cameras (id, account_id, proxy_id, cams_id, proxy_camera_id, name, kind, created_at, updated_at) VALUES ('cam_bgbegin', ?, ?, 'beginporch', 'pc', 'B', 'camera', 1, 1)`).run(ids.acc, ids.bgs);
    }
    if (action === 'switch-create') {
      ids.sw = r.body.id;
      // More switches on the same proxy, without audit records (each step below needs one that is not busy).
      for (const k of ['swTest', 'swMove', 'swRead']) {
        ids[k] = `sw_${k.padEnd(20, '0')}`;
        a.db.prepare(`INSERT INTO switches (id, account_id, name, model, host, ports, off_seconds, proxy_id, state, created_at, updated_at) VALUES (?, ?, ?, 'sscpoe-web', '192.168.1.2', 8, 10, ?, 'pending', 1, 1)`).run(ids[k], ids.acc, k, ids.prx);
      }
    }
    // The proxy goes later. While it operates a switch its delete is refused (409 switch_operated, no record); the
    // switches go first by hand here (their forget never comes back in this test).
    if (pattern === '/switches/:switchId' && m === 'delete') {
      const refused = await a.api('delete', `/accounts/${ids.acc}/proxies/${ids.prx}`);
      expect([refused.status, refused.body.error]).toEqual([409, 'switch_operated']);
      a.db.exec('DELETE FROM switches');
    }
    if (action === 'camera-delete') {
      const swIn = (k: string) => a.db.prepare(`INSERT INTO switches (id, account_id, name, model, host, ports, off_seconds, proxy_id, state, survey, created_at, updated_at) VALUES (?, ?, ?, 'sscpoe-web', '192.168.1.2', 8, 10, ?, 'active', 1, 1, 1)`).run(ids[k] = `sw_${k.padEnd(20, '0')}`, ids.acc, k, ids.prx);
      swIn('swP1');
      for (const [k, power] of [['camA', { kind: 'unknown' }], ['camV', { kind: 'poe', switchId: ids.swP1, port: 2, watts: 4 }], ['camC', { kind: 'poe', switchId: ids.swP1, port: 3, watts: 4 }]] as const) {
        ids[k] = `cam_PWR${k.slice(3)}`.padEnd(24, '0');
        a.db.prepare(`INSERT INTO cameras (id, account_id, cams_id, name, kind, host, power, created_at, updated_at) VALUES (?, ?, ?, ?, 'camera', ?, ?, 1, 1)`).run(ids[k], ids.acc, `p${k.toLowerCase()}`, k, '192.168.60.9', JSON.stringify(power));
      }
    }
    // A second active switch for its own survey (the first one's is still open).
    if (pattern === '/accounts/:accountId/switches/survey') a.db.prepare(`INSERT INTO switches (id, account_id, name, model, host, ports, off_seconds, proxy_id, state, survey, created_at, updated_at) VALUES (?, ?, 'swP2', 'sscpoe-web', '192.168.1.3', 8, 10, ?, 'active', 1, 1, 1)`).run(ids.swP2 = `sw_${'swP2'.padEnd(20, '0')}`, ids.acc, ids.prx);
    // The proxy's delete comes later: the switches it operates go by hand.
    if (pattern === '/switches/:switchId/survey') a.db.exec('DELETE FROM switches');
    // The account goes next: its moves must end first (an active one refuses the delete); ended ones go with it.
    if (action === 'backup-now') a.db.exec('UPDATE moves SET ended_at = 1 WHERE ended_at IS NULL');
    if (actions.includes('import-apply')) ids.impcam = (a.db.prepare(`SELECT id FROM cameras WHERE cams_id = 'imp1'`).get() as { id: string }).id;
    expect(count() - before).toBe(actions.length);
    expect(a.audit.list({ limit: actions.length }).items.map((x) => x.action).sort()).toEqual([...actions].sort());
  });
});
