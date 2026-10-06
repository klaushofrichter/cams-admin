// The local stack's registry (start.sh): accounts, users, proxies, cameras
// and sims through the API, an enrollment code per proxy, and the test
// client's enrollment (key files, mode 600). Prints nothing secret.
//   tsx setup.ts --url U --cookie-file F --plan PLAN.json --keys DIR
import { readFileSync } from 'fs';
import { join } from 'path';
import { enroll } from '../../test-client/client';
import { writeKeyFile } from '../../test-client/keyfile';

interface Plan { accounts: { name: string; displayName: string; users: { email: string; role: string }[]; proxies: { name: string; displayName: string; port: number; cameras: { id: string; camsId: string; name: string; controlPort: number }[] }[] }[] }

const args = process.argv.slice(2);
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1];
const url = opt('url');
const cookie = readFileSync(opt('cookie-file'), 'utf8').trim();
const plan = JSON.parse(readFileSync(opt('plan'), 'utf8')) as Plan;

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  for (const a of plan.accounts) {
    const acc = await api('POST', '/accounts', { name: a.name, displayName: a.displayName });
    for (const u of a.users) await api('POST', `/accounts/${acc.id}/users`, u);
    for (const p of a.proxies) {
      const px = await api('POST', `/accounts/${acc.id}/proxies`, { name: p.name, displayName: p.displayName, runsOn: 'local-host', hostKind: 'mac', url: `http://127.0.0.1:${p.port}`, adminUiUrl: `http://127.0.0.1:${p.port}` });
      for (const c of p.cameras) {
        const cam = await api('POST', `/accounts/${acc.id}/cameras`, { camsId: c.camsId, name: c.name, kind: 'sim', proxyId: px.id, proxyCameraId: c.id, host: 'from-proxy', protocol: 'http', cameraUser: 'cams' });
        await api('PUT', `/accounts/${acc.id}/cameras/${cam.id}/sim`, { runsOn: 'mac', controlUrl: `http://127.0.0.1:${c.controlPort}`, uiUrl: `http://127.0.0.1:${c.controlPort}`, image: 'cam-sim origin/main' });
      }
      const code = (await api('POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, { lifetimeH: 1 })).code;
      const key = await enroll(url, code, { version: 'localstack-bridge', cameraIds: p.cameras.map((c) => c.id) });
      writeKeyFile(join(opt('keys'), `${a.name}-${p.name}.json`), key);
      console.log(`enrolled ${a.name}/${p.name} (${px.id})`);
    }
  }
})().catch((e) => {
  process.stderr.write(`setup: ${(e as Error).message}\n`);
  process.exit(1);
});
