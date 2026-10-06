import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { ENV } from './env';
import { client, enroll, signIn } from './helpers';

// A second server of its own, restarted under an open dashboard: the page
// recovers by itself (SSE reconnect), without a reload.
const PORT = 29195;
const BASE2 = `http://localhost:${PORT}`;
const DATA2 = join(tmpdir(), 'cams-admin-e2e-restart');
const env2 = { ...ENV, PORT: String(PORT), PUBLIC_URL: BASE2, DB_FILE: join(DATA2, 'cams-admin.db'), SERVER_SIGNING_KEY_FILE: join(DATA2, 'signing.pem') };

function start(fresh: boolean): Promise<ChildProcess> {
  const p = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'server.ts'), '--port', String(PORT), '--data', DATA2, ...(fresh ? [] : [])], { stdio: 'ignore' });
  return (async () => {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE2}/health`)).ok) return p; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('server did not start');
  })();
}

test('the dashboard recovers after a cams-admin restart without a reload', async ({ page, context }) => {
  // server.ts writes a new signing key each start: keep the first one.
  const { rmSync, mkdirSync } = await import('fs');
  rmSync(DATA2, { recursive: true, force: true });
  mkdirSync(DATA2, { recursive: true });
  let srv = await start(true);
  try {
    await signIn(context, BASE2, env2);
    const api = async (method: string, path: string, body?: unknown) => (await page.request.fetch(`${BASE2}/api/v1${path}`, { method, headers: { 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) })).json();
    const acc = await api('POST', '/accounts', { name: 'restart', displayName: 'Restart' });
    const px = await api('POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
    const key = await enroll(BASE2, (await api('POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
    const c = client(key);
    c.start();
    await page.goto(`${BASE2}/#/`);
    await expect(page.getByTestId('proxy-state-p1')).toHaveAttribute('data-state', 'online');
    srv.kill('SIGTERM');
    await new Promise((r) => srv.once('exit', r));
    srv = await startKeepingKey();
    // No reload: EventSource reconnects; the proxy reconnects; the row is live again.
    await expect(page.getByTestId('proxy-state-p1')).toHaveAttribute('data-state', 'online', { timeout: 15_000 });
    await expect(page.getByTestId('stale-p1')).toHaveCount(0, { timeout: 15_000 });
    await c.stop();
  } finally {
    srv.kill('SIGTERM');
  }
});

// The same data folder and the same signing key (the proxy pinned it).
async function startKeepingKey(): Promise<ChildProcess> {
  const p = spawn(process.execPath, [join(__dirname, '../dist/server/server.js')], { env: { ...process.env, ...env2 }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE2}/health`)).ok) return p; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not restart');
}
void dirname;
