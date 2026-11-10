// What the hasher (hasher.py) is asked to read on a host or on the Mac. The
// spec names files and variables only; the run key is added when it is sent.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_API, DEFAULT_ROOT, type HostConfig, type TokenCheckConfig } from './config';

export type SpecItem = Record<string, unknown> & { id: string; type: string };
export interface HasherSpec { mounts?: Record<string, string>; items: SpecItem[] }

export const expandHome = (p: string, home = homedir()): string => (p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p);

// The proxy env's secrets: CAMPROXY_* names with TOKEN/PASSWORD/SECRET/KEY (the hasher filters).
const PROXY_ENV = { prefixes: ['CAMPROXY_'], secrets: ['CAMS_LOGIN_TOKEN', 'COOKIE_SECRET'], plain: ['CAMS_TOKEN_ACCOUNT', 'CAMS_TOKEN_USER', 'CONFIG_SOURCE'] };

export function hostSpec(h: HostConfig): HasherSpec {
  const root = h.root ?? DEFAULT_ROOT;
  const items: SpecItem[] = [
    { id: 'env', type: 'env', path: `${root}/config/.env`, ...PROXY_ENV },
    { id: 'envBackups', type: 'glob', pattern: `${root}/config/.env.*`, ...PROXY_ENV },
    { id: 'envBackupsTop', type: 'glob', pattern: `${root}/.env*`, ...PROXY_ENV },
    { id: 'pwFiles', type: 'files', pattern: `${root}/config/*.pw`, kind: 'secret' },
    { id: 'cameraPasswords', type: 'json', path: `${root}/data/admin/camera-passwords.json`, secrets: ['password'] },
    { id: 'switchPasswords', type: 'json', path: `${root}/data/admin/switch-passwords.json`, secrets: ['password'] },
    { id: 'cameraUsers', type: 'camusers', path: `${root}/data/config.json` },
    { id: 'proxyKey', type: 'keyfile', path: `${root}/data/admin/key.json` },
    { id: 'api', type: 'api', base: h.localApi ?? DEFAULT_API, token: { path: `${root}/config/.env`, name: 'CAMPROXY_ADMIN_TOKEN' } },
  ];
  if (h.cams) {
    const c = h.cams.root ?? `${root}/cams`;
    items.push(
      { id: 'camsEnv', type: 'env', path: h.cams.env ?? `${c}/.env`, secrets: ['CAMS_LOGIN_TOKEN', 'COOKIE_SECRET'], plain: PROXY_ENV.plain },
      { id: 'camsTokens', type: 'json', path: `${c}/data/admin/tokens.json`, secrets: ['token'], context: ['id', 'accountId', 'proxyId', 'kind', 'retiringAt'], hashField: 'hash' },
      { id: 'camsCredentials', type: 'json', path: `${c}/data/camera-credentials.json`, secrets: ['password'], context: ['user'] },
      { id: 'camsCameras', type: 'json', path: `${c}/cameras.json`, secrets: ['password', 'token', 'adminToken'], context: ['id', 'user'] },
      { id: 'camsKey', type: 'keyfile', path: `${c}/data/admin/key.json` },
      { id: 'camsCache', type: 'cache', path: `${c}/data/admin/config-cache.json` },
    );
  }
  // A container path in a *_FILE variable (/config/…, /data/…) is read at its place on the host.
  return { mounts: { '/config/': `${root}/config/`, '/data/': `${root}/data/` }, items };
}

export function macSpec(cfg: TokenCheckConfig, hosts: HostConfig[], home = homedir()): HasherSpec {
  const x = (p: string) => expandHome(p, home);
  const items: SpecItem[] = [{ id: 'diagToken', type: 'file', path: x(cfg.camsAdmin.diagTokenFile), kind: 'token' }];
  if (cfg.camsAdmin.opsTokenFile) items.push({ id: 'opsToken', type: 'file', path: x(cfg.camsAdmin.opsTokenFile), kind: 'token' });
  if (cfg.camsAdmin.signingKeyFile) items.push({ id: 'signingKey', type: 'pem', path: x(cfg.camsAdmin.signingKeyFile) });
  for (const h of hosts) {
    const p = cfg.mac.adminTokens[h.name] ?? (h.ssh ? `~/.config/cam-proxy/${h.name}-admin-token` : undefined);
    if (p) items.push({ id: `adminToken:${h.name}`, type: 'file', path: x(p), kind: 'token' });
  }
  cfg.mac.copies.forEach((c, i) => {
    items.push(c.vars ? { id: `copy:${i}`, type: 'env', path: x(c.path), secrets: c.vars } : { id: `copy:${i}`, type: 'file', path: x(c.path), kind: c.kind ?? 'secret' });
  });
  return { items };
}

const HASHER = join(__dirname, 'hasher.py');

// The hasher's program text: its source, then main() with the spec as base64
// (the run key travels inside, on stdin; never on a command line).
export function program(spec: HasherSpec, key: string): string {
  const b64 = Buffer.from(JSON.stringify({ ...spec, key }), 'utf8').toString('base64');
  return `${readFileSync(HASHER, 'utf8')}\nimport base64 as _b64\nmain(json.loads(_b64.b64decode('${b64}').decode('utf-8')))\n`;
}
