// Which proxies, cams instances and hosts one run covers.
import type { TokenCheckConfig } from './config';
import type { Diag, Scope } from './check';

export type Target = { kind: 'account'; name: string } | { kind: 'host'; name: string } | { kind: 'all' };

export function parseArgs(argv: string[]): { target: Target; json: boolean; config?: string } | { help: true } | { error: string } {
  let target: Target | undefined;
  let json = false;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--help' || a === '-h') return { help: true };
      else if (a === '--json') json = true;
      else if (a === '--config') config = val();
      else if (a === '--account' || a === '--host' || a === '--all') {
        if (target) return { error: 'give one of --account, --host or --all' };
        target = a === '--all' ? { kind: 'all' } : { kind: a === '--account' ? 'account' : 'host', name: val() };
      } else return { error: `unknown argument ${a}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (!target) return { error: 'give --account <name>, --host <name> or --all' };
  return { target, json, ...(config ? { config } : {}) };
}

export function accountId(cfg: TokenCheckConfig, name: string): string | undefined {
  if (/^acc_[A-Za-z0-9]+$/.test(name)) return name;
  return cfg.accounts[name];
}

export function resolveScope(cfg: TokenCheckConfig, diag: Diag, t: Target): Scope {
  const hostEntry = (h: TokenCheckConfig['hosts'][number]) => ({ name: h.name, ...(h.proxy ? { proxy: h.proxy } : {}), ...(h.cams ? { cams: h.cams.instance } : {}), ssh: !!h.ssh });
  if (t.kind === 'all') {
    const accountIds = [...new Set([...diag.proxies.map((p) => p.accountId), ...diag.instances.flatMap((i) => i.accounts)])];
    return { label: 'all hosts and accounts', accountIds, proxies: diag.proxies, instances: diag.instances, hosts: cfg.hosts.map(hostEntry), all: true };
  }
  if (t.kind === 'host') {
    const h = cfg.hosts.find((x) => x.name === t.name);
    if (!h) throw new Error(`no host ${t.name} in the config (hosts: ${cfg.hosts.map((x) => x.name).join(', ')})`);
    const proxies = diag.proxies.filter((p) => p.name === h.proxy);
    const instances = diag.instances.filter((i) => i.name === h.cams?.instance);
    return { label: `host ${h.name}`, accountIds: [...new Set(proxies.map((p) => p.accountId))], proxies, instances, hosts: [hostEntry(h)], all: false };
  }
  const acc = accountId(cfg, t.name);
  if (!acc) throw new Error(`account ${t.name} is not in the config's "accounts" (name → acc_ id); give its acc_ id or add it`);
  const proxies = diag.proxies.filter((p) => p.accountId === acc);
  const instances = diag.instances.filter((i) => i.accounts.includes(acc));
  const pn = new Set(proxies.map((p) => p.name));
  const inames = new Set(instances.map((i) => i.name));
  const hosts = cfg.hosts.filter((h) => (h.proxy && pn.has(h.proxy)) || (h.cams && inames.has(h.cams.instance))).map(hostEntry);
  return { label: `account ${t.name}`, accountIds: [acc], proxies, instances, hosts, all: false };
}
