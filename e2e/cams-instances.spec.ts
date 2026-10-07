import { expect, test } from '@playwright/test';
import { join } from 'path';
import { api, signIn, uniq } from './helpers';

test.beforeEach(async ({ context }) => signIn(context));

test('a cams instance: served accounts, a route and a hidden route, a code shown once with both commands, rotate, block', async ({ page }, info) => {
  const accA = await api(page, 'POST', '/accounts', { name: uniq(info, 'ca'), displayName: 'Cams A' });
  const accB = await api(page, 'POST', '/accounts', { name: uniq(info, 'cb'), displayName: 'Cams B' });
  await api(page, 'POST', `/accounts/${accA.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
  await api(page, 'POST', `/accounts/${accA.id}/proxies`, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster' });
  const name = uniq(info, 'cms');
  await page.goto('/#/cams-instances');
  await page.getByTestId('cms-name').fill(name);
  await page.getByTestId('cms-display').fill('Instance');
  await page.getByTestId(`cms-account-${accA.name}`).check();
  await page.getByTestId('cms-create').click();
  await expect(page.getByTestId('cms-title')).toHaveText('Instance');
  await expect(page.getByTestId('cms-state')).toHaveText('pending');
  // A second served account.
  await page.getByTestId(`cms-serve-${accB.name}`).check();
  await page.getByTestId('cms-served-save').click();
  await expect(page.getByTestId(`cms-serve-${accB.name}`)).toBeChecked();
  // Routes: the Pi over loopback, the cluster proxy hidden.
  await page.getByTestId('route-url-pi').fill('http://127.0.0.1:8480');
  await page.getByTestId('route-save-pi').click();
  await expect(page.getByTestId('route-remove-pi')).toBeVisible();
  await page.getByTestId('route-hidden-cluster').check();
  await page.getByTestId('route-save-cluster').click();
  await expect(page.getByTestId('route-remove-cluster')).toBeVisible();
  // The code, once.
  await page.getByTestId('cms-code').click();
  await expect(page.getByTestId('cms-code-value')).toHaveValue(/^CAC1(-[0-9A-Z]{4}){5}$/);
  await expect(page.getByTestId('cms-cmd-cluster')).toContainText('kubectl exec -i -n cams');
  await expect(page.getByTestId('cms-cmd-pi')).toContainText('docker compose exec -T cams node dist/server/cli.js admin-enroll --url');
  const fp = await page.getByTestId('cms-server-fp').textContent();
  await expect(page.getByTestId('cms-code-fp')).toHaveText(fp!);
  await expect(page.getByTestId('cms-code-close')).toBeDisabled();
  await page.getByTestId('cms-code-stored').check();
  await page.getByTestId('cms-code-close').click();
  await expect(page.getByTestId('cms-code-dialog')).toHaveCount(0);
  await expect(page.getByTestId('cms-live-code')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/CAC1-/);
  // Rotate, then block.
  await page.getByTestId('cms-rotate').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('body')).toContainText('last rotation asked');
  await page.getByTestId('cms-block').click();
  await page.getByTestId('confirm-input').fill(name);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('cms-state')).toHaveText('blocked');
  await page.goto('/#/cams-instances');
  await expect(page.getByTestId(`cms-state-${name}`)).toHaveText('blocked');
});

test('import on the account page: dry run, accept mismatches, apply, again → no changes; export', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'imp'), displayName: 'Import' });
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'cluster', displayName: 'Cluster', runsOn: 'cluster', url: 'https://cluster-proxy.example.net' });
  const inst = await api(page, 'POST', '/cams-instances', { name: uniq(info, 'icms'), displayName: 'I', accounts: [acc.id] });
  await page.goto(`/#/accounts/${acc.id}/import`);
  await page.getByTestId('import-file').setInputFiles(join(__dirname, '../test/fixtures/import/cluster.json'));
  await expect(page.getByTestId('import-file-info')).toContainText('cluster.json');
  await page.getByTestId('import-dry-run').click();
  await expect(page.getByTestId('import-result')).toContainText('new camera cam1');
  await expect(page.getByTestId('import-result')).toContainText('proxy pi: matched by url');
  // The proxies are not enrolled here: two mismatches block Apply until accepted.
  await expect(page.getByTestId('import-apply')).toBeDisabled();
  for (const box of await page.getByTestId('import-mismatches').locator('input[type=checkbox]').all()) await box.check();
  await page.getByTestId('import-apply').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('import-applied')).toBeVisible();
  await page.getByTestId('import-dry-run').click();
  await expect(page.getByTestId('import-no-changes')).toBeVisible();
  await page.getByTestId('tab-cameras').click();
  await expect(page.getByTestId('camera-row-cam2')).toBeVisible();
  // Export (a download).
  await page.getByTestId('tab-import').click();
  const download = page.waitForEvent('download');
  await page.getByTestId(`export-${inst.name}`).click();
  expect((await download).suggestedFilename()).toBe(`cameras-${acc.name}-${inst.name}.json`);
});

test('the dashboard lists cams instances', async ({ page }, info) => {
  const name = uniq(info, 'dcms');
  await api(page, 'POST', '/cams-instances', { name, displayName: 'Dash instance', accounts: [] });
  await page.goto('/#/');
  await expect(page.getByTestId(`dash-cms-${name}`)).toContainText('never pulled');
  await page.getByTestId('nav-cams').click();
  await expect(page.getByTestId(`cms-row-${name}`)).toBeVisible();
});
