// token-check's local configuration (docs/token-check.md): where the hosts
// are and which proxy and cams instance each runs. Addresses and paths only,
// never a secret. Kept outside the repository
// (~/.config/cams-admin/token-check.json, mode 600); the repository has
// scripts/tokencheck/token-check.example.json with placeholder addresses.

export interface CamsOnHost {
  instance: string; // the cams instance's name in cams-admin
  root?: string; // its folder on the host (compose.yaml, cameras.json, data/)
  env?: string; // the env file compose reads (default <root>/.env)
}

export interface HostConfig {
  name: string;
  ssh?: string; // user@address; absent: no shell (the cluster), cams-admin's view only
  root?: string; // cam-proxy's folder (default /srv/cam-proxy)
  proxy?: string; // the cam-proxy's name in cams-admin
  localApi?: string; // the proxy's API as seen on the host (default http://127.0.0.1:8480)
  cams?: CamsOnHost;
}

// A Mac file with secret copies. `vars`: an env file and the variables to
// fingerprint; without `vars` the whole file is one value. `host` says whose
// copy it is (compared with that host's value); `camera`/`user` mark a camera
// password copy.
export interface MacCopy {
  path: string;
  vars?: string[];
  host?: string;
  camera?: string;
  user?: string;
  kind?: 'token' | 'secret';
  label?: string;
}

export interface TokenCheckConfig {
  camsAdmin: { url: string; diagTokenFile: string; opsTokenFile?: string; signingKeyFile?: string };
  accounts: Record<string, string>; // account name → acc_ id (optional; else found from the hosts)
  hosts: HostConfig[];
  mac: { adminTokens: Record<string, string>; copies: MacCopy[] };
  expiringDays: number;
  sshTimeoutS: number;
}

export const DEFAULT_ROOT = '/srv/cam-proxy';
export const DEFAULT_API = 'http://127.0.0.1:8480';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function fail(msg: string): never {
  throw new Error(`token-check config: ${msg}`);
}

// Checks the shape and fills the defaults; refuses anything that looks like a
// secret in the file (a key named *token*/*password* holding a value that is not a path).
export function parseConfig(raw: unknown): TokenCheckConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not a JSON object');
  const o = raw as Record<string, unknown>;
  const ca = o.camsAdmin as Record<string, unknown> | undefined;
  if (!ca || !isStr(ca.url)) fail('camsAdmin.url is required');
  let url: URL;
  try { url = new URL(ca.url as string); } catch { fail('camsAdmin.url is not a URL'); }
  if (url!.protocol !== 'https:' && url!.hostname !== '127.0.0.1' && url!.hostname !== 'localhost') fail('camsAdmin.url must be https');
  const accounts: Record<string, string> = {};
  for (const [k, v] of Object.entries((o.accounts as Record<string, unknown>) ?? {})) {
    if (!isStr(v) || !/^acc_[A-Za-z0-9]+$/.test(v)) fail(`accounts.${k} must be an acc_ id`);
    accounts[k] = v;
  }
  if (!Array.isArray(o.hosts) || o.hosts.length === 0) fail('hosts must be a non-empty list');
  const names = new Set<string>();
  const hosts = o.hosts.map((h, i): HostConfig => {
    const x = h as Record<string, unknown>;
    if (!x || !isStr(x.name) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(x.name)) fail(`hosts[${i}].name must be a short lower-case name`);
    if (names.has(x.name as string)) fail(`hosts[${i}].name ${x.name} twice`);
    names.add(x.name as string);
    if (x.ssh !== undefined && (!isStr(x.ssh) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$/.test(x.ssh))) fail(`hosts[${i}].ssh must be user@address`);
    for (const k of ['root', 'proxy', 'localApi'] as const) if (x[k] !== undefined && !isStr(x[k])) fail(`hosts[${i}].${k} must be a string`);
    if (x.root !== undefined && !(x.root as string).startsWith('/')) fail(`hosts[${i}].root must be absolute`);
    let cams: CamsOnHost | undefined;
    if (x.cams !== undefined) {
      const c = x.cams as Record<string, unknown>;
      if (!c || !isStr(c.instance)) fail(`hosts[${i}].cams.instance is required`);
      cams = { instance: c.instance as string, ...(isStr(c.root) ? { root: c.root } : {}), ...(isStr(c.env) ? { env: c.env } : {}) };
    }
    return {
      name: x.name as string,
      ...(isStr(x.ssh) ? { ssh: x.ssh } : {}),
      root: (x.root as string | undefined) ?? DEFAULT_ROOT,
      ...(isStr(x.proxy) ? { proxy: x.proxy } : {}),
      localApi: (x.localApi as string | undefined) ?? DEFAULT_API,
      ...(cams ? { cams } : {}),
    };
  });
  const mac = (o.mac as Record<string, unknown> | undefined) ?? {};
  const adminTokens: Record<string, string> = {};
  for (const [k, v] of Object.entries((mac.adminTokens as Record<string, unknown>) ?? {})) {
    if (!isStr(v)) fail(`mac.adminTokens.${k} must be a path`);
    if (!names.has(k)) fail(`mac.adminTokens.${k}: no such host`);
    adminTokens[k] = v;
  }
  const copies = ((mac.copies as unknown[]) ?? []).map((c, i): MacCopy => {
    const x = c as Record<string, unknown>;
    if (!x || !isStr(x.path)) fail(`mac.copies[${i}].path is required`);
    if (x.vars !== undefined && (!Array.isArray(x.vars) || !x.vars.every((v) => isStr(v) && /^[A-Z][A-Z0-9_]*$/.test(v)))) fail(`mac.copies[${i}].vars must be variable names`);
    if (x.host !== undefined && !names.has(x.host as string)) fail(`mac.copies[${i}].host: no such host`);
    if (x.kind !== undefined && x.kind !== 'token' && x.kind !== 'secret') fail(`mac.copies[${i}].kind must be token or secret`);
    return {
      path: x.path as string,
      ...(x.vars ? { vars: x.vars as string[] } : {}),
      ...(isStr(x.host) ? { host: x.host } : {}),
      ...(isStr(x.camera) ? { camera: x.camera } : {}),
      ...(isStr(x.user) ? { user: x.user } : {}),
      ...(x.kind ? { kind: x.kind as 'token' | 'secret' } : {}),
      ...(isStr(x.label) ? { label: x.label } : {}),
    };
  });
  const expiringDays = o.expiringDays === undefined ? 7 : Number(o.expiringDays);
  if (!Number.isInteger(expiringDays) || expiringDays < 1 || expiringDays > 90) fail('expiringDays must be 1-90');
  const sshTimeoutS = o.sshTimeoutS === undefined ? 20 : Number(o.sshTimeoutS);
  if (!Number.isInteger(sshTimeoutS) || sshTimeoutS < 5 || sshTimeoutS > 300) fail('sshTimeoutS must be 5-300');
  return {
    camsAdmin: {
      url: (ca.url as string).replace(/\/+$/, ''),
      diagTokenFile: isStr(ca.diagTokenFile) ? ca.diagTokenFile : '~/.config/cams-admin/diag-token',
      ...(isStr(ca.opsTokenFile) ? { opsTokenFile: ca.opsTokenFile } : {}),
      ...(isStr(ca.signingKeyFile) ? { signingKeyFile: ca.signingKeyFile } : {}),
    },
    accounts,
    hosts,
    mac: { adminTokens, copies },
    expiringDays,
    sshTimeoutS,
  };
}
