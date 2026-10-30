// The camera page's onboarding card (cam-proxy onboarding design §5): the combined view of a camera, and the
// onboarding commands as the proxy allows them. The proxy is the test client with an `onboarding` report.
import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { RefProxyConfig } from '../test-client/config';

test.beforeEach(async ({ context }) => signIn(context));

test('the camera page shows a ready camera; Set time is disabled until the proxy allows camera.action:camera-time-set, then asks for the typed action name and shows the result', async ({ page }, info) => {
  // Set time is disruptive: the fleet budget (3 in 10 minutes, the whole e2e server) already pays for remote-config's two reboots.
  test.skip(info.project.name === 'phone', 'one disruptive action per e2e run (fleet budget)');
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'onb'), displayName: 'Onboarding' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
  const key = await enroll(BASE, code);
  const c = client(key, undefined, {
    commands: { allow: ['camera.onboarding.get', 'camera.action:camera-ftp-setup'], config: new RefProxyConfig({ cameras: ['cam1', 'cam2'] }) },
    onboarding: () => ({ cam1: { ready: true, missing: ['time'] }, cam2: { ready: false, missing: ['login'] } }),
  });
  c.start();
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('onboarding-chip-cam1')).toHaveText('onboarded');
    await expect(page.getByTestId('onboarding-chip-cam2')).toHaveText('onboarding');
    // Before the adopt: not in the account; Add to account.
    await page.getByTestId('onboarding-chip-cam1').click();
    await expect(page.getByTestId('camera-onboarding')).toBeVisible();
    await expect(page.getByTestId('onboarding-ready')).toHaveText('not ready');
    await expect(page.getByTestId('onboarding-missing')).toContainText('Not in the account yet');
    await page.getByTestId('onboarding-adopt').click();
    await expect(page.getByTestId('onboarding-registry')).toContainText('cam1');
    await expect(page.getByTestId('onboarding-ready')).toHaveText('ready');
    await expect(page.getByTestId('onboarding-optional')).toContainText('Time');
    // The full status from the proxy.
    await page.getByTestId('onboarding-refresh').click();
    await expect(page.getByTestId('onboarding-result')).toContainText('Refresh status: done');
    await expect(page.getByTestId('onboarding-step-login')).toContainText('✓');
    await expect(page.getByTestId('onboarding-step-time')).toContainText('✗');
    // Set time: not allowed on the proxy yet.
    await expect(page.getByTestId('onboarding-time-set')).toBeDisabled();
    await expect(page.getByTestId('onboarding-ftp-setup')).toBeEnabled();
    c.commands!.allow = [...c.commands!.allow, 'camera.action:camera-time-set'];
    c.heartbeatNow();
    await expect(page.getByTestId('onboarding-time-set')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('onboarding-time-set').click();
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    await page.getByTestId('confirm-input').fill('camera-time');
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    await page.getByTestId('confirm-input').fill('camera-time-set');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('onboarding-result')).toContainText('camera-time-set: done · verified ✓');
  } finally {
    await c.stop('shutdown');
  }
});
