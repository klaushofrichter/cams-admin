// npm run import -- --url http://127.0.0.1:29000 --session-file F --account home --instance cluster --file export.json
//                   [--apply] [--accept-mismatch id,…] [--create-proxies] [--hide-unlisted]
// An API client of POST /api/v1/accounts/:id/import (the importer runs in the
// server: it cross-checks against the live proxies). For the local stack and
// the rehearsal; production imports go through the account page. The
// session file holds a sysadmin session cookie value (npm run dev:session).
import { readFileSync } from 'fs';
import { formatImport } from './import-format';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const need = (n: string) => opt(n) ?? fail(`--${n} is required`);
const flag = (n: string) => args.includes(`--${n}`);
function fail(msg: string): never {
  process.stderr.write(`import: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const url = need('url').replace(/\/+$/, '');
  const cookie = readFileSync(need('session-file'), 'utf8').trim();
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (r.status >= 300) fail(`${method} ${path}: ${r.status} ${j.error ?? ''}${j.field ? ` (${j.field})` : ''}`);
    return j;
  };
  const account = (await api('GET', '/accounts')).items.find((a: { name: string }) => a.name === need('account')) ?? fail(`no account ${opt('account')}`);
  const instance = (await api('GET', '/cams-instances')).items.find((i: { name: string }) => i.name === need('instance')) ?? fail(`no cams instance ${opt('instance')}`);
  const file = JSON.parse(readFileSync(need('file'), 'utf8'));
  const body = {
    instanceId: instance.id, file, acceptMismatch: (opt('accept-mismatch') ?? '').split(',').filter(Boolean),
    createProxies: flag('create-proxies'), hideUnlisted: flag('hide-unlisted'),
  };
  // Apply is bound to a dry run (same plan, once, 10 min): the dry run first, its lines, then the apply.
  let result = await api('POST', `/accounts/${account.id}/import`, { ...body, apply: false });
  if (flag('apply') && !result.noChanges) {
    for (const line of formatImport(result as never)) console.log(line);
    result = await api('POST', `/accounts/${account.id}/import`, { ...body, apply: true, planId: result.planId });
  }
  for (const line of formatImport(result as never)) console.log(line);
  if (flag('apply') && !result.applied && !result.noChanges) process.exit(3);
}

main().catch((e) => fail((e as Error).message));
