// Vision management in the browser (design 2026-11-05): the Account page's Vision tab. Refresh reads the
// proxy's figures; a limit within the ceiling switches Vision on; 0 switches it off; a limit above the
// ceiling is refused at the row. The proxy is the test client with the reference proxy.
import { expect, test, type Page } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { RefProxyConfig } from '../test-client/config';

test.beforeEach(async ({ context }) => signIn(context));

const ALLOW = ['config.get', 'config.set', 'analytics.usage.get'];

async function proxyWith(page: Page, name: string, settings: Record<string, number | boolean>) {
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Vision' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
  const key = await enroll(BASE, code);
  const ref = new RefProxyConfig({ cameras: ['cam1'], settings });
  const c = client(key, undefined, { commands: { allow: ALLOW, config: ref } });
  c.start();
  return { acc, px, c, ref };
}

test('vision: Refresh shows the figures; a limit within the ceiling switches it on, 0 off; above the ceiling is refused at the row', async ({ page }, info) => {
  const { acc, c, ref } = await proxyWith(page, uniq(info, 'vis'), { 'analytics.googleVision.remoteMaxMonthly': 1000, 'analytics.googleVision.monthlyLimit': 0 });
  try {
    await page.goto(`/#/accounts/${acc.id}/vision`);
    await expect(page.getByTestId('tab-vision')).toBeVisible();
    // The proxy's settings must be read before a change can be checked: Refresh until the figures show.
    await expect(async () => {
      await page.getByTestId('vision-refresh').click();
      await expect(page.getByTestId('vision-state-p1-google-vision')).toHaveText('Off', { timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId('vision-raw-p1-google-vision')).toContainText('ceiling 1,000');
    await expect(page.getByTestId('vision-asof-p1')).toContainText('ago');
    // Above the ceiling: the page's own check.
    await page.getByTestId('vision-limit-p1-google-vision').fill('5000');
    await page.getByTestId('vision-save-p1-google-vision').click();
    await expect(page.getByTestId('vision-row-error-p1-google-vision')).toContainText('up to 1,000');
    // Within it: on.
    await page.getByTestId('vision-limit-p1-google-vision').fill('800');
    await page.getByTestId('vision-save-p1-google-vision').click();
    await expect(page.getByTestId('vision-save-state-p1-google-vision')).toHaveText('Saved.', { timeout: 15_000 });
    await expect(page.getByTestId('vision-state-p1-google-vision')).toHaveText('On, no key', { timeout: 15_000 });
    expect(ref.current('analytics.googleVision.enabled')).toBe(true);
    expect(ref.current('analytics.googleVision.monthlyLimit')).toBe(800);
    // 0 = off.
    await page.getByTestId('vision-limit-p1-google-vision').fill('0');
    await page.getByTestId('vision-save-p1-google-vision').click();
    await expect(page.getByTestId('vision-state-p1-google-vision')).toHaveText('Off', { timeout: 15_000 });
    expect(ref.current('analytics.googleVision.enabled')).toBe(false);
  } finally {
    await c.stop('shutdown');
  }
});

test('vision: no ceiling at the proxy says so', async ({ page }, info) => {
  const { acc, c } = await proxyWith(page, uniq(info, 'vnc'), {});
  try {
    await page.goto(`/#/accounts/${acc.id}/vision`);
    await expect(async () => {
      await page.getByTestId('vision-refresh').click();
      await expect(page.getByTestId('vision-no-ceiling-p1-google-vision')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId('vision-no-ceiling-p1-google-vision')).toHaveText("cams-admin can't switch it on: no ceiling at the proxy");
  } finally {
    await c.stop('shutdown');
  }
});
