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

  // No GUI address: a pointer to the form, no link, no warning, nothing to save.
  await expect(page.getByTestId('proxy-no-address')).toHaveText('no GUI address set: enter it under Registry');
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

test('the Proxies table: labelled columns, readable host, GUI link with its reach marked, no overflow', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'pxt'), displayName: 'Proxy table' });
  const [lan, pub, bare] = [uniq(info, 'lan'), uniq(info, 'pub'), uniq(info, 'bare')];
  const garage = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: lan, displayName: 'Garage', runsOn: 'local-host', hostKind: 'pc', adminUiUrl: 'http://garage.local:8480', url: 'https://viewer-address-long-enough-to-wrap.proxy.example.net:8480' });
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: pub, displayName: 'Hosted', runsOn: 'cloud', adminUiUrl: 'https://a-rather-long-gui-address-for-a-proxy.example.net:8480/gui' });
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: bare, displayName: 'Bare', runsOn: 'cluster' });
  await page.goto(`/#/accounts/${acc.id}/proxies`);
  const phone = info.project.name === 'phone';

  const heads = page.getByTestId(`proxy-item-${lan}`).locator('xpath=ancestor::table').locator('thead th');
  await expect(heads).toHaveText(['Proxy', 'Host', 'State', 'Proxy GUI', 'Viewer address']);
  await expect(page.getByTestId('proxy-viewer-head')).toHaveAttribute('title', 'How cams viewers reach this proxy');

  await expect(page.getByTestId(`proxy-open-${lan}`)).toHaveAttribute('href', `#/accounts/${acc.id}/proxies/${garage.id}`);
  await expect(page.getByTestId(`proxy-item-host-${lan}`)).toHaveText('This network · PC');
  await expect(page.getByTestId(`proxy-item-host-${pub}`)).toHaveText('Cloud');
  await expect(page.getByTestId(`proxy-item-host-${bare}`)).toHaveText('Cluster');

  const gui = page.getByTestId(`proxy-item-address-${lan}`);
  await expect(gui).toHaveAttribute('href', 'http://garage.local:8480/');
  await expect(gui).toHaveAttribute('target', '_blank');
  await expect(gui).toHaveAttribute('rel', 'noopener noreferrer');
  const warning = 'Local network address: only reachable from inside that network.';
  await expect(page.getByTestId(`proxy-item-address-${lan}-marker`)).toHaveText('LAN');
  await expect(page.getByTestId(`proxy-item-address-${lan}-marker`)).toHaveAttribute('title', warning);
  await expect(page.getByTestId(`proxy-item-address-${pub}`)).toHaveAttribute('href', /^https:/);
  await expect(page.getByTestId(`proxy-item-address-${pub}-marker`)).toHaveCount(0);
  await expect(page.getByTestId(`proxy-item-address-${bare}`)).toHaveText('–');
  await expect(page.getByTestId(`proxy-item-address-${bare}`)).not.toHaveAttribute('href', /./);

  const viewer = page.getByTestId(`proxy-item-viewer-${lan}`);
  if (phone) {
    await expect(viewer).toBeHidden();
    await expect(page.getByTestId('proxy-viewer-head')).toBeHidden();
  } else {
    await expect(viewer).toHaveText('https://viewer-address-long-enough-to-wrap.proxy.example.net:8480');
    await expect(viewer).toHaveAttribute('title', 'How cams viewers reach this proxy');
    await expect(page.getByTestId(`proxy-item-viewer-${bare}`)).toHaveText('–');
  }

  // Neither the table nor the page scrolls sideways.
  const overflow = await page.getByTestId(`proxy-item-${lan}`).evaluate((row) => {
    const box = row.closest('.scroll-x')!;
    return { table: box.scrollWidth - box.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(overflow).toEqual({ table: 0, page: 0 });

  await page.goto('/#/');
  await expect(page.getByTestId(`dash-proxy-address-${lan}`)).toHaveAttribute('href', 'http://garage.local:8480/');
  await expect(page.getByTestId(`dash-proxy-address-${lan}-marker`)).toHaveText('LAN');
  await expect(page.getByTestId(`proxy-row-${bare}`).getByText('GUI', { exact: true })).toHaveCount(0);
});

test('create an account, users (duplicate refused here, allowed elsewhere), a proxy, a camera, a sim', async ({ page }, info) => {
  const a = uniq(info, 'acct');
  const b = uniq(info, 'other');
  await page.goto('/#/accounts');
  await page.getByTestId('new-account-name').fill(a);
  await page.getByTestId('new-account-display').fill('Account A');
  await expect(page.getByTestId('new-account-add-me')).toBeChecked();
  await page.getByTestId('new-account-add-me').uncheck();
  await page.getByTestId('new-account-submit').click();
  await expect(page.getByTestId('account-title')).toHaveText('Account A');
  await expect(page.getByTestId('no-admin-warning')).toContainText('nobody can open it in cams');
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
  // Delete asks first and names what goes and what stays.
  await page.getByTestId('camera-delete-sim1').click();
  await expect(page.getByTestId('camera-delete-lines-goes')).toContainText('its move records');
  await expect(page.getByTestId('camera-delete-lines-stays')).toContainText('the audit log');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('camera-row-sim1')).toBeVisible();
  await page.getByTestId('camera-delete-sim1').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('camera-row-sim1')).toHaveCount(0);
});

test('a new account: the creator is its admin by default, so cams lists it for them', async ({ page }, info) => {
  const a = uniq(info, 'mine');
  await page.goto('/#/accounts');
  await page.getByTestId('new-account-name').fill(a);
  await page.getByTestId('new-account-display').fill('Mine');
  await page.getByTestId('new-account-submit').click();
  await expect(page.getByTestId('account-title')).toHaveText('Mine');
  await expect(page.getByTestId('no-admin-warning')).toHaveCount(0);
  await page.getByTestId('tab-users').click();
  await expect(page.getByTestId('user-role-admin@example.com')).toHaveValue('admin');
  await page.goto('/#/audit');
  await page.getByTestId('audit-filter-action').selectOption('user-create');
  await expect(page.getByTestId('audit-row').first()).toContainText('admin@example.com');
});

test('delete a proxy: the dialog names what goes (moves, tokens, routes) and what stays (cameras, commands, the audit log)', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'dpx'), displayName: 'Delete proxy' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'c1', name: 'One', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam1' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'c2', name: 'Two', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam2' });
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await page.getByTestId('delete-proxy').click();
  await expect(page.getByTestId('proxy-delete-lines-stays')).toContainText('2 cameras, left in the account without a proxy');
  await expect(page.getByTestId('proxy-delete-lines-stays')).toContainText('the audit log');
  await expect(page.getByTestId('proxy-delete-lines-goes')).toContainText('its live status, history, settings and token revision');
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(new RegExp(`#/accounts/${acc.id}/proxies$`));
  await page.goto(`/#/accounts/${acc.id}/cameras`);
  await expect(page.getByTestId('camera-proxy-c1')).toHaveValue('');
});
