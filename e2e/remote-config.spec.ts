// P3 in the browser (plan Task 7): the Settings card (dry-run diff, apply,
// changed on the proxy, conflicts), Roll back from the Commands card, and the
// camera actions with their typed confirmation. The proxy is the test
// client with the reference proxy (test-client/config.ts).
import { expect, test, type Page } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { RefProxyConfig } from '../test-client/config';

test.beforeEach(async ({ context }) => signIn(context));

const SETTINGS = ['config.get', 'config.set', 'config.unset', 'config.rollback'];

async function proxyWith(page: Page, name: string, allow: string[]) {
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Remote config' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
  const key = await enroll(BASE, code);
  const ref = new RefProxyConfig({ cameras: ['cam1', 'cam2'] });
  const c = client(key, undefined, { commands: { allow: [...allow], config: ref } });
  c.start();
  return { acc, px, c, ref };
}

async function setValue(page: Page, path: string, value: string) {
  await page.getByTestId(`settings-input-${path}`).fill(value);
}

test('settings: change, review the diff, apply; roll back from Commands; a local edit shows and reloads', async ({ page }, info) => {
  const { acc, px, c, ref } = await proxyWith(page, uniq(info, 'cfg'), SETTINGS);
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('settings-value-sse.pingS')).toHaveText('30');
    await expect(page.getByTestId('settings-why-cameras.cam1.host')).toHaveText('never remote (addresses, ports, files, trust, users)');
    await expect(page.getByTestId('settings-input-cameras.cam1.host')).toHaveCount(0);
    await expect(page.getByTestId('settings-why-storage.maxPercent')).toHaveText('storage settings are local only');
    // A lowered retention period is refused before Review.
    await setValue(page, 'retention.clipsDays', '30');
    await expect(page.getByTestId('settings-input-error-retention.clipsDays')).toContainText('only higher from cams-admin');
    await setValue(page, 'retention.clipsDays', '90');
    // Change → Review → the diff → Apply.
    await setValue(page, 'sse.pingS', '7');
    await page.getByTestId('settings-review').click();
    await expect(page.getByTestId('diff-row-sse.pingS')).toContainText('30');
    await expect(page.getByTestId('diff-row-sse.pingS')).toContainText('7');
    await page.getByTestId('settings-apply').click();
    await expect(page.getByTestId('settings-value-sse.pingS')).toHaveText('7');
    await expect(page.getByTestId('settings-by-sse.pingS')).toContainText('set by cams-admin');
    expect(ref.current('sse.pingS')).toBe(7);
    // Roll back from the Commands card.
    const applied = page.locator('[data-testid^="command-rollback-"]').first();
    await applied.click();
    await expect(page.getByTestId('rollback-diff')).toContainText('sse.pingS');
    await page.getByTestId('rollback-apply').click();
    await expect(page.getByTestId('settings-value-sse.pingS')).toHaveText('30');
    expect(ref.current('sse.pingS')).toBe(30);
    // A local edit on the proxy: the banner, then Reload.
    ref.localEdit({ 'sse.maxClients': 25 });
    await expect(page.getByTestId('settings-changed')).toBeVisible();
    await page.getByTestId('settings-reload').click();
    await expect(page.getByTestId('settings-value-sse.maxClients')).toHaveText('25');
    await expect(page.getByTestId('settings-changed')).toHaveCount(0);
  } finally {
    await c.stop('shutdown');
  }
});

test('settings: a local edit between Review and Apply shows the conflict; Use mine re-previews', async ({ page }, info) => {
  const { acc, px, c, ref } = await proxyWith(page, uniq(info, 'cfl'), SETTINGS);
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('settings-value-sse.pingS')).toHaveText('30');
    await setValue(page, 'sse.pingS', '7');
    await page.getByTestId('settings-review').click();
    await expect(page.getByTestId('diff-row-sse.pingS')).toBeVisible();
    ref.localEdit({ 'sse.pingS': 9 });
    await page.getByTestId('settings-apply').click();
    // Either the re-read beat the click (stale preview) or the proxy answered conflict: both show the proxy's value next to mine.
    await expect(page.getByTestId('conflict')).toBeVisible();
    await expect(page.getByTestId('conflict-row-sse.pingS')).toContainText('9');
    await expect(page.getByTestId('conflict-row-sse.pingS')).toContainText('7');
    await page.getByTestId('conflict-mine').click();
    await expect(page.getByTestId('diff-row-sse.pingS')).toContainText('9');
    await page.getByTestId('settings-apply').click();
    await expect(page.getByTestId('settings-value-sse.pingS')).toHaveText('7');
    expect(ref.current('sse.pingS')).toBe(7);
  } finally {
    await c.stop('shutdown');
  }
});

test('camera actions: camera-test runs; camera-reboot is disabled until allowed, then asks for the typed name', async ({ page }, info) => {
  const { acc, px, c, ref } = await proxyWith(page, uniq(info, 'act'), ['camera.action:camera-test', 'camera.name.set']);
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}?camera=cam1`);
    await expect(page.getByTestId('settings-not-allowed')).toContainText('Allow config.get');
    await page.getByTestId('action-cam1-camera-test').click();
    await expect(page.getByTestId('action-result-cam1')).toContainText('camera-test');
    await expect(page.getByTestId('action-result-cam1')).toContainText('done');
    const reboot = page.getByTestId('action-cam1-camera-reboot');
    await expect(reboot).toBeDisabled();
    c.commands!.allow.push('camera.action:camera-reboot');
    c.heartbeatNow();
    await expect(reboot).toBeEnabled();
    await reboot.click();
    await expect(page.getByTestId('confirm')).toBeVisible();
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    await page.getByTestId('confirm-input').fill('camera-reboot');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('action-result-cam1')).toContainText('camera-reboot');
    await expect(page.getByTestId('action-result-cam1')).toContainText('done');
    expect(ref.actions.calls.map((x) => x.action)).toEqual(['camera-test', 'camera-reboot']);
    // Rename (camera.name.set), shown verified.
    await page.getByTestId('rename-cam2').fill('Back yard');
    await page.getByTestId('rename-save-cam2').click();
    await expect(page.getByTestId('action-result-cam2')).toContainText('verified');
  } finally {
    await c.stop('shutdown');
  }
});

test('a hostile value in the view is rendered as text', async ({ page }, info) => {
  const { acc, px, c } = await proxyWith(page, uniq(info, 'xss'), SETTINGS);
  try {
    const hostile = '<script>window.__p3xss=1</script><img src=x onerror="window.__p3xss=2">' + 'x'.repeat(10 * 1024);
    c.overrideConfigGetResult = {
      revision: `sha256:${'c'.repeat(64)}`, schema: 1, cameras: ['cam1'], omittedCameras: [],
      paths: { 'cameras.cam1.name': { v: hostile, s: 'file' }, 'sse.pingS': { v: 30, s: 'default' } }, settable: { 'sse.pingS': { type: 'integer' }, 'camsAdmin.url': { type: 'string' } },
    };
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('settings-value-cameras.cam1.name')).toContainText('<script>window.__p3xss=1</script>');
    expect(await page.evaluate(() => (window as unknown as { __p3xss?: number }).__p3xss)).toBeUndefined();
    expect(await page.content()).toContain('&lt;script&gt;window.__p3xss=1');
  } finally {
    await c.stop('shutdown');
  }
});
