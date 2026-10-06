import { expect, test } from '@playwright/test';
import { api, signIn, uniq } from './helpers';

test.beforeEach(async ({ context }) => signIn(context));

test('create an account, users (duplicate refused here, allowed elsewhere), a proxy, a camera, a sim', async ({ page }, info) => {
  const a = uniq(info, 'acct');
  const b = uniq(info, 'other');
  await page.goto('/#/accounts');
  await page.getByTestId('new-account-name').fill(a);
  await page.getByTestId('new-account-display').fill('Account A');
  await page.getByTestId('new-account-submit').click();
  await expect(page.getByTestId('account-title')).toHaveText('Account A');
  await expect(page.getByTestId('no-admin-warning')).toBeVisible();
  // Users.
  await page.getByTestId('tab-users').click();
  await page.getByTestId('user-email').fill('Viewer@Example.com');
  await page.getByTestId('user-role').selectOption('admin');
  await page.getByTestId('user-add').click();
  await expect(page.getByTestId('user-row-viewer@example.com')).toBeVisible();
  await expect(page.getByTestId('no-admin-warning')).toHaveCount(0);
  await page.getByTestId('user-email').fill('viewer@example.com');
  await page.getByTestId('user-add').click();
  await expect(page.getByTestId('user-error')).toContainText('already a user');
  const other = await api(page, 'POST', '/accounts', { name: b, displayName: 'Other' });
  await api(page, 'POST', `/accounts/${other.id}/users`, { email: 'viewer@example.com', role: 'viewer' });
  await page.reload();
  if (info.project.name === 'desktop') await expect(page.getByTestId('user-others-viewer@example.com')).toContainText(b);
  // A proxy.
  await page.getByTestId('tab-proxies').click();
  await page.getByTestId('proxy-name').fill('pi');
  await page.getByTestId('proxy-display').fill('Garage Pi');
  await page.getByTestId('proxy-add').click();
  await expect(page.getByTestId('proxy-title')).toHaveText('Garage Pi');
  await expect(page.getByTestId('live-state')).toHaveAttribute('data-state', 'pending');
  // A camera and a sim.
  await page.goBack();
  await page.getByTestId('tab-cameras').click();
  await page.getByTestId('camera-cams-id').fill('sim1');
  await page.getByTestId('camera-name').fill('Sim one');
  await page.getByTestId('camera-kind').selectOption('sim');
  await page.getByTestId('camera-add').click();
  await expect(page.getByTestId('camera-row-sim1')).toBeVisible();
  await page.getByTestId('tab-sims').click();
  await page.getByTestId('sim-control-sim1').fill('http://127.0.0.1:29502');
  await page.getByTestId('sim-save-sim1').click();
  await expect(page.getByTestId('sim-control-sim1')).toHaveValue('http://127.0.0.1:29502');
});
