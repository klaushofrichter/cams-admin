import { expect, test } from '@playwright/test';
import { join } from 'path';
import { api, signIn, uniq } from './helpers';

test.beforeEach(async ({ context }) => signIn(context));

test('a cams instance: served accounts, routes default-deny (one loopback route), a code shown once with both commands, rotate, block', async ({ page }, info) => {
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
  // Routes are default-deny: nothing is visible until routed; the Pi over loopback, the cluster proxy left out.
  await expect(page.getByTestId('route-state-pi')).toHaveText('not visible');
  await page.getByTestId('route-visible-pi').check();
  await page.getByTestId('route-url-pi').fill('http://127.0.0.1:8480');
  await page.getByTestId('route-save-pi').click();
  await expect(page.getByTestId('route-state-pi')).toHaveText('visible');
  await expect(page.getByTestId('route-state-cluster')).toHaveText('not visible');
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
  // No default instance: the dry run waits until one is picked.
  await expect(page.getByTestId('import-instance')).toHaveValue('');
  await expect(page.getByTestId('import-dry-run')).toBeDisabled();
  await page.getByTestId('import-instance').selectOption(inst.id);
  await page.getByTestId('import-dry-run').click();
  await expect(page.getByTestId('import-result')).toContainText('new camera cam1');
  await expect(page.getByTestId('import-result')).toContainText('proxy pi: matched by url');
  await expect(page.getByTestId('import-result')).toContainText('route pi → (registered URL)');
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

test('a file that looks like another instance\'s export: a warning, and Apply needs its own confirmation', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'oth'), displayName: 'Other' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
  const c1 = await api(page, 'POST', '/cams-instances', { name: uniq(info, 'oc'), displayName: 'C', accounts: [acc.id] });
  const p1 = await api(page, 'POST', '/cams-instances', { name: uniq(info, 'op'), displayName: 'P', accounts: [acc.id] });
  await api(page, 'PUT', `/cams-instances/${p1.id}/routes/${px.id}`, { url: 'http://127.0.0.1:8480', hidden: false });
  await page.goto(`/#/accounts/${acc.id}/import`);
  await page.getByTestId('import-instance').selectOption(c1.id);
  await page.getByTestId('import-file').setInputFiles(join(__dirname, '../test/fixtures/import/cutover-pi.json'));
  await page.getByTestId('import-create-proxies').check();
  await page.getByTestId('import-dry-run').click();
  await expect(page.getByTestId('import-other-instance')).toContainText(`Is this ${p1.name}'s export? You picked ${c1.name}.`);
  await expect(page.getByTestId('import-apply')).toBeDisabled();
  await page.getByTestId('import-confirm-instance').check();
  await expect(page.getByTestId('import-apply')).toBeEnabled();
});

test('camera overrides on the instance page; the camera\'s registry fields on the Cameras tab (issue #25)', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'ovr'), displayName: 'Overrides' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'cam1', name: 'Den', kind: 'camera', host: '192.0.2.164', cameraUser: 'cams' });
  const inst = await api(page, 'POST', '/cams-instances', { name: uniq(info, 'ovc'), displayName: 'Ov', accounts: [acc.id] });
  await page.goto(`/#/cams-instances/${inst.id}`);
  const t = `${acc.name}-cam1`;
  await expect(page.getByTestId(`ov-host-${t}`)).toHaveAttribute('placeholder', '192.0.2.164');
  await expect(page.getByTestId(`ov-state-${t}`)).toHaveCount(0);
  await page.getByTestId(`ov-host-${t}`).fill('from-proxy');
  await page.getByTestId(`ov-user-${t}`).fill('proxy');
  await page.getByTestId(`ov-save-${t}`).click();
  await expect(page.getByTestId(`ov-state-${t}`)).toHaveText('override');
  await expect(page.getByTestId(`ov-user-${t}`)).toHaveValue('proxy');
  await page.getByTestId(`ov-clear-${t}`).click();
  await expect(page.getByTestId(`ov-state-${t}`)).toHaveCount(0);
  await expect(page.getByTestId(`ov-host-${t}`)).toHaveValue('');
  // The registry name (what cams shows), edited on the account's Cameras tab.
  await page.goto(`/#/accounts/${acc.id}/cameras`);
  await page.getByTestId('camera-edit-cam1').click();
  await expect(page.getByTestId('camera-edit-form')).toContainText('not the camera\'s own (OSD) name');
  await page.getByTestId('camera-edit-name').fill('Backyard Left');
  await page.getByTestId('camera-edit-save').click();
  await expect(page.getByTestId('camera-edit-form')).toHaveCount(0);
  await expect(page.getByTestId('camera-row-cam1')).toContainText('Backyard Left');
});

test('the dashboard lists cams instances', async ({ page }, info) => {
  const name = uniq(info, 'dcms');
  await api(page, 'POST', '/cams-instances', { name, displayName: 'Dash instance', accounts: [] });
  await page.goto('/#/');
  await expect(page.getByTestId(`dash-cms-${name}`)).toContainText('never pulled');
  await page.getByTestId('nav-cams').click();
  await expect(page.getByTestId(`cms-row-${name}`)).toBeVisible();
});
