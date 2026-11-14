import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash, createHmac, generateKeyPairSync } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseConfig } from '../scripts/tokencheck/config';
import { buildPool, evaluate, exitCode, expiryStatus, formatText, parsePwName, roleOfVar, type Diag, type DiagProxy, type HostResult, type Input, type Line } from '../scripts/tokencheck/check';
import { parseArgs, resolveScope } from '../scripts/tokencheck/scope';
import { hostSpec, macSpec, program } from '../scripts/tokencheck/spec';

// Fixtures only: RFC 5737 addresses, made-up ids and marker "secrets".
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86_400_000;
const KEY = 'ab'.repeat(32);
const fp = (v: string) => createHmac('sha256', Buffer.from(KEY, 'hex')).update(v).digest('hex').slice(0, 12);
const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const tok = (v: string) => ({ fp: fp(v), sha: sha(v) });
const pw = (v: string) => ({ fp: fp(v) });

const baseCfg = {
  camsAdmin: { url: 'https://cams-admin.example.net' },
  accounts: { home: 'acc_HOME', demo: 'acc_DEMO' },
  hosts: [
    { name: 'h1', ssh: 'ops@192.0.2.10', proxy: 'p1' },
    { name: 'h2', ssh: 'ops@192.0.2.11', proxy: 'p2', cams: { instance: 'viewer2' } },
    { name: 'k8s', proxy: 'p3', cams: { instance: 'main' } },
  ],
};

describe('token-check config and arguments', () => {
  it('fills the defaults', () => {
    const c = parseConfig(baseCfg);
    expect(c.hosts[0]).toMatchObject({ root: '/srv/cam-proxy', localApi: 'http://127.0.0.1:8480' });
    expect(c.camsAdmin.diagTokenFile).toBe('~/.config/cams-admin/diag-token');
    expect(c.expiringDays).toBe(7);
  });
  it('refuses a bad shape', () => {
    expect(() => parseConfig({ ...baseCfg, camsAdmin: { url: 'http://cams-admin.example.net' } })).toThrow(/https/);
    expect(() => parseConfig({ ...baseCfg, accounts: { home: 'nope' } })).toThrow(/acc_/);
    expect(() => parseConfig({ ...baseCfg, hosts: [{ name: 'h1', ssh: 'ops@192.0.2.10; rm -rf /' }] })).toThrow(/user@address/);
    expect(() => parseConfig({ ...baseCfg, mac: { copies: [{ path: '~/x', host: 'nowhere' }] } })).toThrow(/no such host/);
    expect(() => parseConfig({ ...baseCfg, mac: { copies: [{ path: '~/x', vars: ['lower'] }] } })).toThrow(/variable names/);
  });
  it('parses the arguments', () => {
    expect(parseArgs(['--account', 'home', '--json'])).toEqual({ target: { kind: 'account', name: 'home' }, json: true });
    expect(parseArgs(['--host', 'h1'])).toEqual({ target: { kind: 'host', name: 'h1' }, json: false });
    expect(parseArgs(['--all'])).toEqual({ target: { kind: 'all' }, json: false });
    expect(parseArgs([])).toHaveProperty('error');
    expect(parseArgs(['--account'])).toHaveProperty('error');
    expect(parseArgs(['--account', 'a', '--host', 'b'])).toHaveProperty('error');
  });
  it('builds no spec that carries a value: paths and names only', () => {
    const c = parseConfig({ ...baseCfg, mac: { copies: [{ path: '~/repo/.env', vars: ['CAMPROXY_ADMIN_TOKEN'], host: 'h1' }] } });
    const hs = hostSpec(c.hosts[1]);
    expect(hs.items.map((i) => i.id)).toEqual(expect.arrayContaining(['env', 'api', 'camsTokens', 'camsKey', 'pwFiles']));
    expect(hs.mounts).toEqual({ '/config/': '/srv/cam-proxy/config/', '/data/': '/srv/cam-proxy/data/' });
    const ms = macSpec(c, c.hosts, '/home/u');
    expect(ms.items.find((i) => i.id === 'adminToken:h1')?.path).toBe('/home/u/.config/cam-proxy/h1-admin-token');
    expect(ms.items.find((i) => i.id === 'copy:0')).toMatchObject({ type: 'env', path: '/home/u/repo/.env', secrets: ['CAMPROXY_ADMIN_TOKEN'] });
    expect(ms.items.some((i) => i.id === 'adminToken:k8s')).toBe(false); // no ssh, no default copy
  });
});

describe('token-check helpers', () => {
  it('expiry: ok, expiring within the window, expired, never', () => {
    expect(expiryStatus(NOW, NOW + 8 * DAY, 7).status).toBe('ok');
    expect(expiryStatus(NOW, NOW + 7 * DAY, 7).status).toBe('expiring');
    expect(expiryStatus(NOW, NOW - 1, 7).status).toBe('expired');
    expect(expiryStatus(NOW, null, 7)).toEqual({ status: 'ok', reason: 'never expires' });
  });
  it('names: password files and variables', () => {
    expect(parsePwName('cam4-admin.pw')).toEqual({ camera: 'cam4', user: 'admin' });
    expect(parsePwName('front-door-proxy.pw')).toEqual({ camera: 'front-door', user: 'proxy' });
    expect(parsePwName('poe-switch')).toEqual({});
    expect(roleOfVar('CAMPROXY_CAMERA_PASSWORD_FRONT_DOOR')).toEqual({ role: 'camera-password', camera: 'front-door' });
    expect(roleOfVar('CAMPROXY_CAMERA_PASSWORD')).toEqual({ role: 'camera-password', camera: '*' });
    expect(roleOfVar('CAMPROXY_TOKENS')).toEqual({ role: 'client-token' });
  });
  it('exit code: 1 on a problem, 2 on warnings only, else 0', () => {
    const l = (status: Line['status'], severity: Line['severity']): Line => ({ section: 's', credential: 'c', copy: 'x', status, reason: '', severity });
    expect(exitCode([l('ok', 'ok'), l('unknown', 'info')])).toBe(0);
    expect(exitCode([l('ok', 'ok'), l('unused', 'warn')])).toBe(2);
    expect(exitCode([l('unused', 'warn'), l('mismatch', 'problem')])).toBe(1);
  });
});

// ---- the evaluation on a synthetic fleet ------------------------------------

function proxy(o: Partial<DiagProxy> & { id: string; name: string; accountId: string }): DiagProxy {
  return { registryState: 'enrolled', state: 'online', lastHeartbeatAt: NOW - 5000, version: 'v1', caFingerprints: ['SHA256:' + 'A'.repeat(64)], pin: 'match', pinsNotSentTo: [], reported: { caFingerprints: ['SHA256:' + 'A'.repeat(64)], tokens: { client: 1, admin: 1, blocked: 0 }, onboarding: { cam9: { ready: true, missing: [] } } }, ...o };
}

function diag(): Diag {
  return {
    ok: true,
    proxies: [proxy({ id: 'prx_1', name: 'p1', accountId: 'acc_HOME' }), proxy({ id: 'prx_3', name: 'p3', accountId: 'acc_HOME' })],
    instances: [{ id: 'cms_MAIN', name: 'main', state: 'enrolled', accounts: ['acc_HOME'], lastSeenAt: NOW - 1000, routes: [{ proxyId: 'prx_1', accountId: 'acc_HOME', hidden: false }, { proxyId: 'prx_3', accountId: 'acc_HOME', hidden: false }], report: { current: true, tokens: { managed: 4, pending: 0, legacy: 0 }, problems: [] } }],
    tokens: [
      { proxyId: 'prx_1', proxyName: 'p1', tokens: [
        { id: 'tok_C1', kind: 'client', holder: 'cms_MAIN', holderName: 'main', label: 'cams main', state: 'active', onProxy: true, retireAt: null, revokedAt: null },
        { id: 'tok_A1', kind: 'admin', holder: 'cms_MAIN', holderName: 'main', label: 'cams main admin', state: 'active', onProxy: true, retireAt: null, revokedAt: null },
        { id: 'tok_OLD', kind: 'admin', holder: 'cms_MAIN', holderName: 'main', label: 'cams main admin', state: 'retiring', onProxy: true, retireAt: NOW - 3 * 3600_000, revokedAt: null },
        { id: 'tok_REV', kind: 'client', holder: 'manual', holderName: null, label: 'old', state: 'revoked', onProxy: true, retireAt: null, revokedAt: NOW - DAY },
      ] },
      { proxyId: 'prx_3', proxyName: 'p3', tokens: [
        { id: 'tok_C3', kind: 'client', holder: 'cms_MAIN', holderName: 'main', label: 'cams main', state: 'active', onProxy: true, retireAt: null, revokedAt: null },
      ] },
    ],
    ops: [{ id: 'opt_1', name: 'script', scopes: ['tokens'], hashPrefix: sha('cao_mac').slice(0, 8), state: 'revoked', createdAt: NOW - 30 * DAY, expiresAt: NOW + 10 * DAY, lastUsedAt: null }],
    viewers: [{ id: 'vtk_1', name: 'guest', accountIds: ['acc_HOME'], state: 'valid', createdAt: NOW - DAY, expiresAt: NOW + 2 * DAY, lastUsedAt: null, fingerprintPrefix: '0123abcd' }],
    cameras: [{ id: 'cam_1', accountId: 'acc_HOME', camsId: 'cam9', proxyId: 'prx_1', proxyCameraId: 'cam9' }],
    switches: {},
    diagIssues: [{ at: NOW - 85 * DAY, detail: { hashPrefix: sha('cad_mac').slice(0, 8), days: 90 } }],
  };
}

function hostH1(): HostResult {
  return {
    items: {
      env: { exists: true, mode: '600', vars: {
        CAMPROXY_ADMIN_TOKEN: { via: 'file', file: 'admin-token', exists: true, mode: '600', ...tok('host-admin') },
        CAMPROXY_TOKENS: { via: 'env', list: [tok('legacy-client')] },
        CAMPROXY_FTP_PASSWORD: { via: 'env', ...pw('ftp-pw') },
        CAMPROXY_CAMERA_PASSWORD_CAM9: { via: 'file', file: 'cam9-proxy.pw', exists: true, mode: '644', ...pw('cam9-proxy') },
      } },
      pwFiles: { files: [{ name: 'cam9-proxy.pw', exists: true, mode: '600', ...pw('cam9-proxy') }, { name: 'cam9-admin.pw', exists: true, mode: '600', ...pw('cam9-admin') }] },
      cameraPasswords: { exists: true, mode: '600', entries: [{ path: 'cameras.cam9', ctx: {}, secrets: { password: pw('cam9-old') } }] },
      cameraUsers: { exists: true, users: { cam9: 'proxy' } },
      proxyKey: { exists: true, mode: '600', serverKeyFingerprints: ['SHA256:OTHERKEY'], proxyId: 'prx_1' },
      api: {
        admin: { state: 'connected', account: 'home', proxyId: 'prx_1' },
        tokens: { revision: 3, items: [
          { id: 'tok_C1', kind: 'client', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:11111111' },
          { id: 'tok_OLD', kind: 'admin', retireAt: NOW - 3 * 3600_000, blocked: false, live: true, hashPrefix: 'sha256:22222222' },
          { id: 'tok_REV', kind: 'client', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:33333333' },
          { id: 'tok_STRAY', kind: 'client', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:44444444' },
        ] },
        tls: { site: 's1', caFingerprint: 'SHA256:' + 'B'.repeat(64), caNotAfter: NOW + 3000 * DAY, proxy: { notAfter: NOW + 100 * DAY }, cameras: [{ id: 'cam9', notAfter: NOW + 3 * DAY, problem: null }] },
        cameras: [{ id: 'cam9', online: true, credentials: { source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD_CAM9_FILE', authOk: true }, ftp: { enabled: true, passwordSet: true, lastUpload: NOW - 3600_000, failures: 2, camera: { state: 'on', mismatch: [] } } }],
        switches: [],
      },
    },
  };
}

function input(over: Partial<Input> = {}): Input {
  const cfg = parseConfig(baseCfg);
  const d = diag();
  const scope = resolveScope(cfg, d, { kind: 'account', name: 'home' });
  return {
    now: NOW, expiringDays: 7, scope, diag: d,
    hosts: { h1: hostH1() },
    mac: { items: {
      diagToken: { exists: true, mode: '600', ...tok('cad_mac') },
      opsToken: { exists: true, mode: '600', ...tok('cao_mac') },
      signingKey: { exists: true, mode: '600', fingerprint: 'SHA256:MACKEY' },
      'adminToken:h1': { exists: true, mode: '600', ...tok('stale-admin') },
      'copy:0': { exists: true, mode: '644', vars: { SWITCH_PASSWORD: { via: 'env', ...pw('cam9-admin') } } },
    } },
    macCopies: [{ id: 'copy:0', label: 'repo/.env' }],
    accountNames: { acc_HOME: 'home' },
    ...over,
  };
}

const find = (lines: Line[], cred: RegExp, copy?: RegExp) => lines.filter((l) => cred.test(l.credential) && (!copy || copy.test(l.copy)));

describe('token-check evaluation', () => {
  const lines = evaluate(input());

  it('scopes an account to its proxies, viewers and hosts', () => {
    const s = input().scope;
    expect(s.proxies.map((p) => p.name)).toEqual(['p1', 'p3']);
    expect(s.instances.map((i) => i.name)).toEqual(['main']);
    expect(s.hosts.map((h) => h.name)).toEqual(['h1', 'k8s']);
  });

  it('cams-admin tokens: the diag token expiring from its issue record, a revoked Mac ops token, an unused viewer token', () => {
    expect(find(lines, /diagnostics token/)[0]).toMatchObject({ status: 'expiring' });
    expect(find(lines, /operations token/)[0]).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/revoked/) });
    expect(find(lines, /viewer token "guest"/)[0]).toMatchObject({ status: 'expiring' });
  });

  it('managed tokens: retiring past due, revoked but live, unknown to cams-admin, missing on the proxy', () => {
    expect(find(lines, /tok_C1/)[0]).toMatchObject({ status: 'ok', fp: 'sha256:11111111' });
    expect(find(lines, /tok_A1/)[0]).toMatchObject({ status: 'missing' });
    expect(find(lines, /tok_OLD/)[0]).toMatchObject({ status: 'expired', reason: expect.stringMatching(/past due/) });
    expect(find(lines, /tok_REV/)[0]).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/revoked in cams-admin but live/) });
    expect(find(lines, /tok_STRAY/)[0]).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/unknown to cams-admin/) });
  });

  it('a holder without an active admin token on a proxy it routes to is missing', () => {
    const p3 = lines.filter((l) => l.section === 'proxy p3' && /tokens of cams main/.test(l.credential));
    expect(p3[0]).toMatchObject({ status: 'missing', reason: expect.stringMatching(/admin/) });
    // Without a host, the proxy's own counts are compared with cams-admin's.
    expect(lines.find((l) => l.section === 'proxy p3' && /counts/.test(l.credential))).toMatchObject({ status: 'mismatch' });
  });

  it('local credentials: a stale Mac admin token copy, a legacy client token without holder, a readable password file', () => {
    expect(find(lines, /local admin token/, /mac/)[0]).toMatchObject({ status: 'mismatch' });
    expect(find(lines, /CAMPROXY_TOKENS #1/)[0]).toMatchObject({ status: 'unused' });
    expect(find(lines, /file mode/, /cam9-proxy\.pw/)[0]).toMatchObject({ status: 'mismatch' });
    expect(find(lines, /file mode/, /repo\/\.env/)[0]).toMatchObject({ status: 'mismatch' });
  });

  it('signing key and site CA: pins compared with the Mac key and the registry', () => {
    expect(lines.find((l) => l.section === 'proxy p1' && l.credential === 'signing key pin')).toMatchObject({ status: 'mismatch' });
    expect(lines.find((l) => l.section === 'proxy p1' && l.credential === 'site CA')).toMatchObject({ status: 'mismatch' });
    expect(find(lines, /certificate cam9/)[0]).toMatchObject({ status: 'expiring' });
  });

  it('camera passwords: the login, aligned copies, a shadowed store copy; FTP failures', () => {
    expect(find(lines, /camera password cam9/, /proxy login/)[0]).toMatchObject({ status: 'ok' });
    expect(find(lines, /camera password cam9/, /cam9-proxy\.pw$/)[0]).toMatchObject({ status: 'ok' });
    expect(find(lines, /camera password cam9/, /camera-passwords\.json/)[0]).toMatchObject({ status: 'unused', reason: expect.stringMatching(/shadowed/) });
    expect(find(lines, /camera password cam9/, /cam9-admin\.pw/)[0]).toMatchObject({ status: 'ok', reason: expect.stringMatching(/repo\/\.env SWITCH_PASSWORD/) });
    expect(find(lines, /FTP upload cam9/)[0]).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/2 failed/) });
  });

  it('a camera copy for the login user that differs is a mismatch', () => {
    const h = hostH1();
    h.items.pwFiles!.files[0] = { name: 'cam9-proxy.pw', exists: true, mode: '600', ...pw('something-else') };
    const l = evaluate(input({ hosts: { h1: h } }));
    expect(find(l, /camera password cam9/, /cam9-proxy\.pw$/)[0]).toMatchObject({ status: 'mismatch' });
  });

  it('two hosts with the same admin token are flagged', () => {
    const cfg = parseConfig(baseCfg);
    const d = diag();
    d.proxies.push(proxy({ id: 'prx_2', name: 'p2', accountId: 'acc_HOME' }));
    const scope = resolveScope(cfg, d, { kind: 'all' });
    const h2 = hostH1();
    h2.items.api!.admin!.proxyId = 'prx_2';
    const l = evaluate(input({ diag: d, scope, hosts: { h1: hostH1(), h2 } }));
    expect(l.find((x) => x.section === 'proxy p1' && x.credential === 'local admin token' && x.copy === 'host h1')).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/same token as h2/) });
  });

  it('cams-admin down: says so, checks nothing from it', () => {
    const l = evaluate(input({ diag: { ...diag(), ok: false, error: 'HTTP 401', proxies: [], instances: [], tokens: [], ops: [], viewers: [] } }));
    expect(l[0]).toMatchObject({ credential: 'diagnostics API', status: 'mismatch' });
    expect(find(l, /diagnostics token/)[0]).toMatchObject({ status: 'expired' });
  });

  it('the pool labels every copy by place, never by value', () => {
    const pool = buildPool(input());
    expect(pool.find((p) => p.label === 'h1 config/.env CAMPROXY_ADMIN_TOKEN')).toMatchObject({ role: 'admin-token', file: 'admin-token' });
    expect(pool.find((p) => p.label === 'h1 config/cam9-admin.pw')).toMatchObject({ camera: 'cam9', user: 'admin' });
  });

  it('formats one line per credential with a summary', () => {
    const t = formatText(lines, 'token-check account home');
    expect(t).toMatch(/^token-check account home/);
    expect(t).toMatch(/\n== proxy p1\n/);
    expect(t).toMatch(/lines: \d+ ok/);
  });
});

// ---- the hasher on fixture files (python3) ------------------------------------

const py = spawnSync('python3', ['--version']).status === 0;
const MARK = 'MARKER-SECRET';

describe.skipIf(!py)('token-check hasher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'));
  const root = join(dir, 'srv');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data', 'admin'), { recursive: true });
  mkdirSync(join(root, 'cams', 'data', 'admin'), { recursive: true });
  const w = (p: string, s: string, mode = 0o600) => { writeFileSync(join(root, p), s); chmodSync(join(root, p), mode); };
  const admin = `${MARK}-admin-0123456789abcdef0123456789`;
  w('config/.env', `# comment\nCAMPROXY_ADMIN_TOKEN_FILE=/config/admin-token\nCAMPROXY_TOKENS=${MARK}-t1, ${MARK}-t2\nexport CAMPROXY_FTP_PASSWORD="${MARK}-ftp"\nCAMPROXY_TARGET=pi\nCAMS_TOKEN_ACCOUNT=demo\nOTHER_PASSWORD=${MARK}-not-asked\n`);
  w('config/admin-token', `${admin}\n`);
  w('config/.env.bak-1', `CAMPROXY_FTP_PASSWORD=${MARK}-old-ftp\n`, 0o644);
  w('config/cam1-admin.pw', `${MARK}-ftp\n`);
  w('data/admin/camera-passwords.json', JSON.stringify({ v: 1, cameras: { cam1: { password: `${MARK}-cam1` } } }));
  w('data/config.json', JSON.stringify({ cameras: [{ id: 'cam1', user: 'proxy', host: '192.0.2.20' }] }));
  const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  w('data/admin/key.json', JSON.stringify({ v: 1, proxyId: 'prx_X', account: 'demo', privateKey: `${MARK}-private`, publicKey: pub, serverKeys: [pub] }));
  const t1 = `${MARK}-managed`;
  w('cams/data/admin/tokens.json', JSON.stringify({ v: 1, tokens: [
    { id: 'tok_1', accountId: 'acc_D', proxyId: 'prx_X', kind: 'client', token: t1, hash: `sha256:${createHash('sha256').update(t1).digest('hex')}` },
    { id: 'tok_2', accountId: 'acc_D', proxyId: 'prx_X', kind: 'admin', token: `${MARK}-bad`, hash: 'sha256:00' },
  ] }));
  w('cams/cameras.json', JSON.stringify([{ id: 'cam1', user: 'cams', password: `${MARK}-cams`, proxy: { url: 'http://192.0.2.1:8480', token: `${MARK}-t1`, adminToken: admin } }]));

  const cfg = parseConfig({ camsAdmin: { url: 'https://cams-admin.example.net' }, hosts: [{ name: 'h', ssh: 'ops@192.0.2.10', root, localApi: 'http://127.0.0.1:9', cams: { instance: 'v', root: join(root, 'cams') } }] });
  const res = spawnSync('python3', ['-'], { input: program(hostSpec(cfg.hosts[0]), KEY), encoding: 'utf8' });
  const out = JSON.parse(res.stdout) as HostResult;

  it('prints no value, only fingerprints', () => {
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(MARK);
    expect(res.stderr).not.toContain(MARK);
  });

  it('fingerprints env values, *_FILE files and comma lists; only the names it is asked for', () => {
    const v = out.items.env!.vars!;
    expect(v.CAMPROXY_ADMIN_TOKEN).toMatchObject({ via: 'file', file: 'admin-token', mode: '600', fp: fp(admin), sha: sha(admin) });
    expect(v.CAMPROXY_TOKENS.list).toEqual([tok(`${MARK}-t1`), tok(`${MARK}-t2`)]);
    expect(v.CAMPROXY_FTP_PASSWORD).toEqual({ via: 'env', fp: fp(`${MARK}-ftp`) }); // a password: no sha
    expect(v.CAMPROXY_TARGET).toBeUndefined();
    expect(v.OTHER_PASSWORD).toBeUndefined();
    expect(out.items.env!.plain).toEqual({ CAMS_TOKEN_ACCOUNT: 'demo' });
  });

  it('reads backups, password files, JSON stores and the key file', () => {
    expect(out.items.envBackups!.files[0]).toMatchObject({ name: '.env.bak-1', mode: '644' });
    expect(out.items.pwFiles!.files[0]).toMatchObject({ name: 'cam1-admin.pw', fp: fp(`${MARK}-ftp`) });
    expect(out.items.cameraPasswords!.entries![0]).toMatchObject({ path: 'cameras.cam1', secrets: { password: { fp: fp(`${MARK}-cam1`) } } });
    expect(out.items.cameraUsers!.users).toEqual({ cam1: 'proxy' });
    expect(out.items.proxyKey).toMatchObject({ proxyId: 'prx_X', serverKeyFingerprints: ['SHA256:' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').toUpperCase()] });
  });

  it('checks a held token against its stored hash; legacy cameras.json copies carry their camera id', () => {
    const e = out.items.camsTokens!.entries!;
    expect(e[0]).toMatchObject({ ctx: { id: 'tok_1', kind: 'client' }, hashOk: true, secrets: { token: tok(t1) } });
    expect(e[1]).toMatchObject({ ctx: { id: 'tok_2' }, hashOk: false });
    const c = out.items.camsCameras!.entries!;
    expect(c.map((x) => [x.path, x.ctx.id, Object.keys(x.secrets)])).toEqual([['0', 'cam1', ['password']], ['0.proxy', 'cam1', ['token', 'adminToken']]]);
  });

  it('an unreachable local API is reported by type only', () => {
    expect(out.items.api!.admin).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(out.items.api)).not.toContain(MARK);
  });

  it('the evaluation of real hasher output stays value-free', () => {
    const d = diag();
    d.proxies = [proxy({ id: 'prx_X', name: 'px', accountId: 'acc_HOME' })];
    const scope = { label: 'host h', accountIds: ['acc_HOME'], proxies: d.proxies, instances: [], hosts: [{ name: 'h', proxy: 'px', ssh: true }], all: true };
    const l = evaluate({ now: NOW, expiringDays: 7, scope, diag: d, hosts: { h: out }, mac: { items: {} }, macCopies: [], accountNames: {} });
    const text = formatText(l, 'x') + JSON.stringify(l);
    expect(text).not.toContain(MARK);
    expect(find(l, /env backup files/)[0]).toMatchObject({ status: 'unused' });
  });
});
