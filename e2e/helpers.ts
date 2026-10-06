import { execFileSync } from 'child_process';
import { join } from 'path';
import { expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { ADMIN, BASE, ENV, GOOGLE_PORT } from './env';
import { enroll, ProxyClient, type KeyFile } from '../test-client/client';
import { makeSummary } from '../test-client/summaries';

// A sysadmin session inserted straight into the database (dev-session).
export function sessionCookie(env: Record<string, string> = ENV): string {
  return execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, '../scripts/dev-session.ts'), ADMIN], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

export async function signIn(context: BrowserContext, base = BASE, env: Record<string, string> = ENV) {
  await context.addCookies([{ name: '__Host-cams_admin', value: sessionCookie(env), domain: new URL(base).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}

export const setGoogleEmail = (email: string) => fetch(`http://127.0.0.1:${GOOGLE_PORT}/set?email=${encodeURIComponent(email)}`);

// A name unique per project and test, for parallel runs.
export const uniq = (info: TestInfo, base: string) => `${base}-${info.project.name === 'phone' ? 'p' : 'd'}${info.workerIndex}${Math.random().toString(36).slice(2, 5)}`.slice(0, 30);

export async function api(page: Page, method: string, path: string, body?: unknown) {
  const r = await page.request.fetch(`${BASE}/api/v1${path}`, { method, headers: { 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.status(), `${method} ${path}`).toBeLessThan(300);
  return r.status() === 204 ? undefined : r.json();
}

export function client(key: KeyFile, summary: () => unknown = () => makeSummary({ cameras: 2, now: Date.now() }), o: Partial<ConstructorParameters<typeof ProxyClient>[0]> = {}) {
  return new ProxyClient({ key, summary, heartbeatS: 1, minIntervalS: 0.2, backoffCapMs: 300, rejectedRetryMs: 600_000, ...o });
}

export { enroll };
