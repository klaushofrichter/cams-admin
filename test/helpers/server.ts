import { join } from 'path';
import { mkdirSync } from 'fs';
import { buildServer, type Built } from '../../server/server';
import type { Clock } from '../../server/clock';
import { writeSigningKey } from './signingKey';
import { enroll, ProxyClient, type ClientOptions, type KeyFile } from '../../test-client/client';
import { makeSummary } from '../../test-client/summaries';

let n = 0;
export interface Running { built: Built; port: number; url: string; wsUrl: string; cookie: string; dir: string; api(method: string, path: string, body?: unknown): Promise<any>; stop(): Promise<void>; restart(): Promise<Running> }

// The real server (buildServer + listen) on a loopback port.
export async function startServer(dir: string, env: Record<string, string> = {}, port = 0, clock?: Clock): Promise<Running> {
  process.env.ALLOWED_EMAILS = 'admin@example.com';
  const d = join(dir, `srv${n++}`);
  mkdirSync(d, { recursive: true });
  return launch(d, writeSigningKey(join(d, 'signing.pem')), env, port, clock);
}

async function launch(d: string, keyFile: string, env: Record<string, string>, port: number, clock?: Clock): Promise<Running> {
  const fullEnv = { PUBLIC_URL: 'http://127.0.0.1:1', DB_FILE: join(d, 'cams-admin.db'), SERVER_SIGNING_KEY_FILE: keyFile, NODE_ENV: 'test', TICK_MS: '100', ...env };
  let built = buildServer(fullEnv, clock);
  const p = await built.listen(port, '127.0.0.1');
  // PUBLIC_URL must name the port for connectUrl: rebuild once the port is known.
  if (port === 0) {
    await built.close();
    built = buildServer({ ...fullEnv, PUBLIC_URL: `http://127.0.0.1:${p}` }, clock);
    await built.listen(p, '127.0.0.1');
  }
  const url = `http://127.0.0.1:${p}`;
  const cookie = built.sessions.create('admin@example.com').value;
  const r: Running = {
    built, port: p, url, wsUrl: `ws://127.0.0.1:${p}/proxy/v1/connect`, cookie, dir: d,
    async api(method, path, body) {
      const res = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      const j = text ? JSON.parse(text) : {};
      if (res.status >= 300) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${text}`), { status: res.status, body: j });
      return j;
    },
    stop: () => built.close(),
    restart: async () => {
      await built.close();
      return launch(d, keyFile, { ...env, PUBLIC_URL: url }, p, clock);
    },
  };
  return r;
}

let acc: Record<string, string> = {};
// A proxy record, a code, and the test client's enrollment.
export async function enrolled(s: Running, name: string, account = 'home'): Promise<{ key: KeyFile; proxyId: string; accountId: string }> {
  const k = `${s.url}|${account}`;
  if (!acc[k]) acc[k] = (await s.api('POST', '/accounts', { name: account, displayName: account })).id;
  const p = await s.api('POST', `/accounts/${acc[k]}/proxies`, { name, displayName: name, runsOn: 'local-host' });
  const c = await s.api('POST', `/accounts/${acc[k]}/proxies/${p.id}/enrollment-codes`, {});
  const key = await enroll(s.url, c.code, { version: 'test', cameraIds: ['cam1'] });
  return { key, proxyId: p.id, accountId: acc[k] };
}
export const resetAccounts = () => { acc = {}; };

export function makeClient(key: KeyFile, o: Partial<ClientOptions> = {}): ProxyClient {
  return new ProxyClient({ key, summary: () => makeSummary({ cameras: 2, now: Date.now() }), heartbeatS: 0.2, minIntervalS: 0.05, backoffCapMs: 200, replacedWaitMs: 100, rejectedRetryMs: 600_000, incompatibleRetryMs: 600_000, ...o });
}

export const until = async (fn: () => boolean | Promise<boolean>, ms = 5000, what = 'condition') => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
