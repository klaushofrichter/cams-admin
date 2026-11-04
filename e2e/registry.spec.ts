import { expect, test } from '@playwright/test';
import { api, signIn, uniq } from './helpers';

test.beforeEach(async ({ context }) => signIn(context));

test('a proxy page: GUI address link and warning, rename in the Registry form, errors keep the typing, the lists show the address', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'pxa'), displayName: 'Proxy address' });
  const name = uniq(info, 'px');
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name, displayName: 'Before', runsOn: 'local-host' });
  const taken = uniq(info, 'pxt');
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: taken, displayName: 'Taken', runsOn: 'local-host' });
  const link = page.getByTestId('proxy-address');
  const warning = page.getByTestId('proxy-address-warning');
  const save = page.getByTestId('proxy-save');
  const address = page.getByTestId('proxy-edit-address');
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);

  // No address: a pointer to the form, no link, no warning, nothing to save.
  await expect(page.getByTestId('proxy-no-address')).toBeVisible();
  await expect(link).toHaveCount(0);
  await expect(warning).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByTestId('proxy-no-address').click();
  await expect(address).toBeFocused();

  // Loopback, local network, public.
  await address.fill('http://127.0.0.1:8480');
  await save.click();
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:8480/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(warning).toContainText('Only works on that machine itself');
  await address.fill('http://192.168.0.10:8480');
  await save.click();
  await expect(link).toHaveText('http://192.168.0.10:8480');
  await expect(warning).toContainText('Local network address');
  await address.fill('https://proxy.example.net:8480');
  await save.click();
  await expect(link).toHaveText('https://proxy.example.net:8480');
  await expect(warning).toHaveCount(0);
  await expect(save).toBeDisabled();

  // Server and name errors, with the typing left alone.
  await address.fill('ftp://proxy.example.net');
  await save.click();
  await expect(page.getByTestId('proxy-form-error')).toContainText('http:// or https://');
  await expect(address).toHaveValue('ftp://proxy.example.net');
  await expect(link).toHaveText('https://proxy.example.net:8480');
  await address.fill('https://proxy.example.net:8480');
  const nameInput = page.getByTestId('proxy-edit-name');
  await expect(nameInput).toHaveValue(name);
  await nameInput.fill('Not Valid');
  await expect(page.getByTestId('proxy-name-error')).toBeVisible();
  await expect(save).toBeDisabled();
  await nameInput.fill(taken);
  await expect(page.getByTestId('proxy-name-error')).toHaveCount(0);
  await save.click();
  await expect(page.getByTestId('proxy-form-error')).toHaveText('That name is taken.');

  // A change elsewhere reloads the page: the typing stays and the next Save needs no retry.
  const renamed = uniq(info, 'pxr');
  await nameInput.fill(renamed);
  const cur = await api(page, 'GET', `/accounts/${acc.id}/proxies/${px.id}`);
  await api(page, 'PATCH', `/accounts/${acc.id}/proxies/${px.id}`, { displayName: 'Changed elsewhere', version: cur.version });
  await expect(page.getByTestId('proxy-title')).toHaveText('Changed elsewhere');
  await expect(page.getByTestId('proxy-edit-display')).toHaveValue('Changed elsewhere');
  await expect(nameInput).toHaveValue(renamed);

  // A conflict: told so, the typing stays, the second Save goes through.
  let refused = false;
  await page.route(`**/api/v1/accounts/${acc.id}/proxies/${px.id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !refused) {
      refused = true;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'conflict' }) });
    } else await route.continue();
  });
  await save.click();
  await expect(page.getByTestId('proxy-form-error')).toContainText('Someone changed this meanwhile');
  await expect(nameInput).toHaveValue(renamed);
  await save.click();
  await expect(page.getByTestId('proxy-form-error')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();
  const saved = await api(page, 'GET', `/accounts/${acc.id}/proxies/${px.id}`);
  expect(saved).toMatchObject({ id: px.id, name: renamed, displayName: 'Changed elsewhere', adminUiUrl: 'https://proxy.example.net:8480' });

  // The lists show the address, by the new name.
  await page.goto(`/#/accounts/${acc.id}`);
  await page.getByTestId('tab-proxies').click();
  await expect(page.getByTestId(`proxy-item-address-${renamed}`)).toHaveAttribute('href', 'https://proxy.example.net:8480/');
  await page.goto('/#/');
  await expect(page.getByTestId(`dash-proxy-address-${renamed}`)).toHaveAttribute('href', 'https://proxy.example.net:8480/');
});

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
