// P4 in the local stack (start.sh): two cams instances through the API and
// their enrollment by the reference cams client (test-client/cams.ts):
//   cms-main  serves alpha and beta, every proxy routed at its registered URL (the cluster's cams)
//   cms-pi    serves alpha only, alpha-1 over a loopback route; nothing else is
//             routed to it (routes are default-deny: the Pi's cams)
// Key files (mode 600) in --keys; prints nothing secret.
//   tsx cams-setup.ts --url U --cookie-file F --keys DIR
import { readFileSync } from 'fs';
import { join } from 'path';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { enrollCams } from '../../test-client/cams';

const args = process.argv.slice(2);
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1];
const url = opt('url');
const cookie = readFileSync(opt('cookie-file'), 'utf8').trim();

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  const accounts = (await api('GET', '/accounts')).items as { id: string; name: string }[];
  const acc = (n: string) => accounts.find((a) => a.name === n)?.id ?? (() => { throw new Error(`no account ${n}`); })();
  const main = await api('POST', '/cams-instances', { name: 'cms-main', displayName: 'cams (main)', accounts: [acc('alpha'), acc('beta')] });
  const pi = await api('POST', '/cams-instances', { name: 'cms-pi', displayName: 'cams (Pi)', accounts: [acc('alpha')] });
  for (const a of ['alpha', 'beta']) {
    for (const p of (await api('GET', `/accounts/${acc(a)}/proxies`)).items as { id: string; name: string; url: string }[]) {
      await api('PUT', `/cams-instances/${main.id}/routes/${p.id}`, { url: null, hidden: false });
      if (p.name === 'alpha-1') await api('PUT', `/cams-instances/${pi.id}/routes/${p.id}`, { url: p.url.replace('127.0.0.1', 'localhost'), hidden: false });
    }
  }
  mkdirSync(opt('keys'), { recursive: true, mode: 0o700 });
  chmodSync(opt('keys'), 0o700);
  for (const i of [main, pi]) {
    const { code } = await api('POST', `/cams-instances/${i.id}/enrollment-codes`, { lifetimeH: 1 });
    const k = await enrollCams(url, code, 'localstack-reference');
    writeFileSync(join(opt('keys'), `${i.name}.json`), JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
    console.log(`cams instance ${i.name} (${i.id}) enrolled by the reference client, key ${k.keyId}`);
  }
})().catch((e) => {
  process.stderr.write(`cams-setup: ${(e as Error).message}\n`);
  process.exit(1);
});
