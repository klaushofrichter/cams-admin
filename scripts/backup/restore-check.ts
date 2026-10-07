// Helpers of scripts/backup/restore-test.sh (spec §13.6). Never used against
// the real bucket.
//   bucket   create the test bucket (S3_ENDPOINT, BACKUP_S3_BUCKET)
//   seed     --url U --cookie C --key FILE     accounts, users, proxies, cameras, a code redeemed by the test client
//   snapshot --url U --cookie C               POST /api/v1/backup/snapshot
//   dump     --db FILE [--tables a,b]          per-table row counts and content hashes (JSON)
//   fetch-snapshot --out FILE                  the newest snapshot, gunzipped
//   hello    --key FILE --connect URL          one handshake + one acked heartbeat
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Store } from '../../server/backup/store';
import { enroll, ProxyClient } from '../../test-client/client';
import { readKeyFile, writeKeyFile } from '../../test-client/keyfile';
import { makeSummary } from '../../test-client/summaries';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) throw new Error(`--${n} is required`);
  return args[i + 1];
};
const env = (n: string) => process.env[n] ?? (() => { throw new Error(`${n} is required`); })();

const TABLES = ['accounts', 'account_users', 'proxies', 'proxy_keys', 'enrollment_codes', 'cameras', 'sims', 'proxy_status', 'status_events', 'audit_log', 'sessions', 'jobs', 'meta', 'commands', 'proxy_tokens', 'proxy_token_state',
  'cams_instances', 'cams_instance_keys', 'cams_enrollment_codes', 'cams_instance_accounts', 'cams_instance_routes', 'config_revision', 'proxy_config', 'cams_camera_overrides'];

async function api(url: string, cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}/api/v1${path}`, {
    method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  const cmd = args[0];
  if (cmd === 'bucket') {
    const s3 = new S3Client({ region: 'us-east-1', endpoint: env('S3_ENDPOINT'), forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: env('BACKUP_S3_BUCKET') }));
    return;
  }
  if (cmd === 'seed') {
    const url = opt('url'), cookie = opt('cookie');
    for (const name of ['alpha', 'beta', 'gamma']) {
      const a = await api(url, cookie, 'POST', '/accounts', { name, displayName: name.toUpperCase() });
      await api(url, cookie, 'POST', `/accounts/${a.id}/users`, { email: `admin@${name}.example.com`, role: 'admin' });
      await api(url, cookie, 'POST', `/accounts/${a.id}/users`, { email: 'shared@example.com', role: 'viewer' });
      const p = await api(url, cookie, 'POST', `/accounts/${a.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host', hostKind: 'mac', caFingerprints: ['AB'.repeat(32)] });
      const cam1 = await api(url, cookie, 'POST', `/accounts/${a.id}/cameras`, { camsId: `${name}-cam1`, name: 'Cam 1', kind: 'camera', proxyId: p.id, proxyCameraId: 'cam1', host: '192.0.2.41', cameraUser: 'cams' });
      const s = await api(url, cookie, 'POST', `/accounts/${a.id}/cameras`, { camsId: `${name}-sim1`, name: 'Sim 1', kind: 'sim' });
      await api(url, cookie, 'PUT', `/accounts/${a.id}/cameras/${s.id}/sim`, { runsOn: 'mac', controlUrl: 'http://127.0.0.1:29502' });
      if (name === 'alpha') {
        const c = await api(url, cookie, 'POST', `/accounts/${a.id}/proxies/${p.id}/enrollment-codes`, { lifetimeH: 1 });
        const k = await enroll(url, c.code, { version: 'restore-test', cameraIds: ['cam1'] });
        writeKeyFile(opt('key'), k);
        await hello(k.connectUrl, opt('key'));
        // P4: a cams instance serving alpha, with a route and a live code.
        const inst = await api(url, cookie, 'POST', '/cams-instances', { name: 'restore', displayName: 'Restore', accounts: [a.id] });
        await api(url, cookie, 'PUT', `/cams-instances/${inst.id}/routes/${p.id}`, { url: 'http://127.0.0.1:8480', hidden: false });
        // A camera override (migration 7): the restore must bring the row back.
        await api(url, cookie, 'PUT', `/cams-instances/${inst.id}/camera-overrides/${cam1.id}`, { host: 'from-proxy', cameraUser: 'proxy' });
        await api(url, cookie, 'POST', `/cams-instances/${inst.id}/enrollment-codes`, { lifetimeH: 1 });
      }
    }
    return;
  }
  if (cmd === 'snapshot') {
    const r = await api(opt('url'), opt('cookie'), 'POST', '/backup/now', {});
    if (!r.ok) throw new Error(`backup now failed: litestream ${r.litestream.error ?? 'ok'}, snapshot ${r.snapshot.error ?? 'ok'}`);
    console.log(`backup now: litestream ${r.litestream.status}, snapshot ${r.snapshot.key} (${r.snapshot.bytes} bytes)`);
    return;
  }
  if (cmd === 'dump') {
    const db = new DatabaseSync(opt('db'), { readOnly: true });
    const tables = args.includes('--tables') ? opt('tables').split(',') : TABLES;
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const out: Record<string, unknown> = { integrity };
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all();
      out[t] = { rows: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16) };
    }
    db.close();
    console.log(JSON.stringify(out));
    return;
  }
  if (cmd === 'fetch-snapshot') {
    const st = s3Store({ bucket: env('BACKUP_S3_BUCKET'), region: 'us-east-1', endpoint: env('S3_ENDPOINT') });
    const all = (await st.list(`${env('BACKUP_S3_PREFIX')}snapshots/`)).sort((a, b) => b.lastModified - a.lastModified);
    if (!all.length) throw new Error('no snapshot in the bucket');
    writeFileSync(opt('out'), gunzipSync(await st.get(all[0].key)));
    console.log(`fetched ${all[0].key}`);
    return;
  }
  if (cmd === 'hello') {
    await hello(opt('connect'), opt('key'));
    console.log('hello ok');
    return;
  }
  throw new Error('usage: bucket | seed | snapshot | dump | fetch-snapshot | hello');
}

async function hello(connectUrl: string, keyFile: string) {
  const key = { ...readKeyFile(keyFile), connectUrl };
  const c = new ProxyClient({ key, summary: () => makeSummary({ cameras: 1, now: Date.now() }), backoffCapMs: 500, rejectedRetryMs: 600_000 });
  c.start();
  const t0 = Date.now();
  while (c.stats.acked < 1) {
    if (c.state === 'rejected' || Date.now() - t0 > 15_000) {
      await c.stop();
      throw new Error(`hello failed: ${c.state}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await c.stop('shutdown');
}

main().catch((e) => {
  process.stderr.write(`restore-check: ${(e as Error).message}\n`);
  process.exit(1);
});
