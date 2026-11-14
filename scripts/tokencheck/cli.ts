// scripts/token-check: credential consistency and validity for one account,
// one host or everything (docs/token-check.md). Read-only. Secret values never
// leave the hasher process that reads them (on the host, or on the Mac); this
// process sees fingerprints only, plus the diagnostics token it sends to
// cams-admin like any diag call.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { parseConfig, type TokenCheckConfig } from './config';
import { evaluate, exitCode, formatText, type Diag, type HostResult, type MacResult, type MacCopyMeta } from './check';
import { parseArgs, resolveScope } from './scope';
import { expandHome, hostSpec, macSpec, program, type HasherSpec } from './spec';

const HELP = `Usage: scripts/token-check (--account <name|acc_id> | --host <name> | --all) [--json] [--config <file>]

Checks every credential of an account (its proxies, cams instances and the
Mac's copies) or of one host: one line per credential or copy with ok,
mismatch, expired, expiring, unused, missing or unknown. Read-only.
Exit 0: no problem; 1: a mismatch, expired or missing; 2: only warnings
(expiring, unused); 3: usage or configuration error.
Config: ~/.config/cams-admin/token-check.json (docs/token-check.md).`;

function run(cmd: string, args: string[], input: string, timeoutS: number): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, error: `timed out after ${timeoutS} s` }); }, timeoutS * 1000);
    p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      // stderr is not shown as is: only its last line's first words (ssh errors), never hasher output.
      if (code !== 0) resolve({ ok: false, error: `exit ${code}${err ? `: ${err.trim().split('\n').pop()!.slice(0, 80)}` : ''}` });
      else resolve({ ok: true, out });
    });
    p.stdin.end(input);
  });
}

async function hasher(target: { ssh?: string }, spec: HasherSpec, key: string, timeoutS: number): Promise<{ items: Record<string, unknown> } | { error: string }> {
  const prog = program(spec, key);
  const r = target.ssh
    ? await run('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.min(10, timeoutS)}`, target.ssh, 'python3 -'], prog, timeoutS)
    : await run('python3', ['-'], prog, timeoutS);
  if (!r.ok) return { error: r.error };
  try {
    const j = JSON.parse(r.out) as { v: number; items: Record<string, unknown> };
    return { items: j.items };
  } catch {
    return { error: 'the hasher answered no JSON' };
  }
}

async function diagGet(cfg: TokenCheckConfig, token: string, path: string): Promise<unknown> {
  const r = await fetch(`${cfg.camsAdmin.url}/api/v1/diag${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadDiag(cfg: TokenCheckConfig): Promise<Diag> {
  const empty: Diag = { ok: false, proxies: [], instances: [], tokens: [], ops: [], viewers: [], cameras: [], switches: {}, diagIssues: [] };
  let token: string;
  try {
    token = readFileSync(expandHome(cfg.camsAdmin.diagTokenFile), 'utf8').trim();
  } catch {
    return { ...empty, error: 'no diagnostics token file' };
  }
  try {
    const items = async <T>(p: string) => ((await diagGet(cfg, token, p)) as { items: T[] }).items;
    const [proxies, instances, tokens, ops, viewers, cameras, diagIssues] = await Promise.all([
      items<Diag['proxies'][number]>('/proxies'), items<Diag['instances'][number]>('/cams-instances'), items<Diag['tokens'][number]>('/tokens'),
      items<Diag['ops'][number]>('/ops-tokens'), items<Diag['viewers'][number]>('/viewer-tokens'), items<Diag['cameras'][number]>('/cameras'),
      items<Diag['diagIssues'][number]>('/audit?action=diag-token-issue&limit=200'),
    ]);
    const switches: Diag['switches'] = {};
    for (const acc of [...new Set(proxies.map((p) => p.accountId))]) {
      try { switches[acc] = await items<Diag['switches'][string][number]>(`/accounts/${acc}/switches`); } catch { switches[acc] = []; }
    }
    return { ok: true, proxies, instances, tokens, ops, viewers, cameras, switches, diagIssues };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  } finally {
    token = '';
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ('help' in args) { console.log(HELP); return 0; }
  if ('error' in args) { console.error(`token-check: ${args.error}\n\n${HELP}`); return 3; }
  const cfgPath = expandHome(args.config ?? '~/.config/cams-admin/token-check.json');
  let cfg: TokenCheckConfig;
  try {
    const st = statSync(cfgPath);
    if ((st.mode & 0o077) !== 0) console.error(`token-check: ${cfgPath} is readable by others (chmod 600; it holds the host addresses)`);
    cfg = parseConfig(JSON.parse(readFileSync(cfgPath, 'utf8')));
  } catch (e) {
    console.error(`token-check: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? `no config at ${cfgPath} (see scripts/tokencheck/token-check.example.json)` : (e as Error).message}`);
    return 3;
  }
  const diag = await loadDiag(cfg);
  let scope;
  try {
    scope = resolveScope(cfg, diag, args.target);
  } catch (e) {
    console.error(`token-check: ${(e as Error).message}`);
    return 3;
  }
  // One random key per run: the password fingerprints compare within this run only.
  const key = randomBytes(32).toString('hex');
  const hostCfgs = cfg.hosts.filter((h) => scope.hosts.some((s) => s.name === h.name));
  const ms = macSpec(cfg, hostCfgs, homedir());
  const macCopies: MacCopyMeta[] = cfg.mac.copies.map((c, i) => ({ id: `copy:${i}`, label: c.label ?? c.path.replace(homedir(), '~'), ...(c.host ? { host: c.host } : {}), ...(c.camera ? { camera: c.camera } : {}), ...(c.user ? { user: c.user } : {}), ...(c.vars ? { vars: c.vars } : {}) }));
  const [mac, ...hostResults] = await Promise.all([
    hasher({}, ms, key, cfg.sshTimeoutS),
    ...hostCfgs.map((h) => (h.ssh ? hasher({ ssh: h.ssh }, hostSpec(h), key, cfg.sshTimeoutS) : Promise.resolve({ error: 'no ssh' }))),
  ]);
  const hosts: Record<string, HostResult> = {};
  hostCfgs.forEach((h, i) => {
    const r = hostResults[i];
    if (!h.ssh) return;
    hosts[h.name] = 'error' in r ? { error: r.error, items: {} } : { items: r.items as HostResult['items'] };
  });
  // Account names: the config's, then what the proxies and cams caches say.
  const accountNames: Record<string, string> = Object.fromEntries(Object.entries(cfg.accounts).map(([n, id]) => [id, n]));
  for (const r of Object.values(hosts)) {
    const a = r.items.api?.admin;
    const px = diag.proxies.find((p) => p.id === a?.proxyId);
    if (px && a?.account && !accountNames[px.accountId]) accountNames[px.accountId] = a.account;
    for (const acc of r.items.camsCache?.accounts ?? []) if (!accountNames[acc.id]) accountNames[acc.id] = acc.name;
  }
  const lines = evaluate({
    now: Date.now(), expiringDays: cfg.expiringDays, scope, diag, hosts,
    mac: 'error' in mac ? { items: {} } : (mac as MacResult), macCopies, accountNames,
  });
  if ('error' in mac) lines.unshift({ section: 'mac', credential: 'hasher', copy: 'mac', status: 'unknown', reason: `the Mac hasher failed (${mac.error}): no Mac copy is checked`, severity: 'info' });
  const header = `token-check ${scope.label} at ${new Date().toISOString()} (cams-admin ${diag.ok ? 'answered' : `did not answer: ${diag.error}`}; hosts ${hostCfgs.map((h) => `${h.name}${h.ssh ? (hosts[h.name]?.error ? ' (not reached)' : '') : ' (no ssh)'}`).join(', ') || 'none'})`;
  if (args.json) console.log(JSON.stringify({ scope: scope.label, at: new Date().toISOString(), exitCode: exitCode(lines), lines }, null, 2));
  else console.log(formatText(lines, header));
  return exitCode(lines);
}

main().then((code) => process.exit(code), (e: unknown) => { console.error(`token-check: ${(e as Error).message}`); process.exit(3); });
