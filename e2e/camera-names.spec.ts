// Camera names (camera name sync design 2026-11-06, Task 5): the camera holds its name. The edit form sends a
// new name of a camera behind a proxy to the camera (the proxy's rename command) and shows the outcome; the record
// follows the proxy's next report. The proxy is the test client; its report carries the name the camera holds.
import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { RefProxyConfig } from '../test-client/config';
import { makeSummary } from '../test-client/summaries';

test.beforeEach(async ({ context }) => signIn(context));

test('a camera behind a proxy is renamed at the camera; the record follows the report; the rules are checked as typed', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'cnm'), displayName: 'Names' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'garage', name: 'Garage', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam1' });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  // The name the camera holds, as the proxy reports it.
  let held = 'Garage';
  const summary = () => {
    const s = makeSummary({ cameras: 2, now: Date.now() }) as any;
    s.cameras[0].camera.name = held;
    s.cameras[0].camera.nameSource = 'camera';
    return s;
  };
  const c = client(key, summary, { commands: { allow: ['camera.name.set'], config: new RefProxyConfig({ cameras: ['cam1', 'cam2'] }) } });
  c.start();
  try {
    await page.goto(`/#/accounts/${acc.id}/cameras`);
    await page.getByTestId('camera-edit-garage').click();
    await expect(page.getByTestId('camera-edit-name-note')).toContainText("The name is the camera's own");
    // The camera's rules, before anything is sent.
    await page.getByTestId('camera-edit-name').fill('Garage_door');
    await expect(page.getByTestId('camera-edit-name-error')).toHaveText('not allowed: _');
    await expect(page.getByTestId('camera-edit-save')).toBeDisabled();
    await page.getByTestId('camera-edit-name').fill('Garage door');
    await page.getByTestId('camera-edit-save').click();
    await expect(page.getByTestId('camera-rename-result')).toHaveText(`The camera is now "Garage door"; cams-admin follows at its proxy's next report (about 30 s).`);
    await expect(page.getByTestId('camera-edit-form')).toHaveCount(0);
    // The record changes only with the report.
    await expect(page.getByTestId('camera-row-garage')).not.toContainText('Garage door');
    held = 'Garage door';
    await expect(page.getByTestId('camera-row-garage')).toContainText('Garage door', { timeout: 10_000 });
    // Adding a camera behind a proxy: the typed name is a placeholder.
    await expect(page.getByTestId('camera-name-placeholder')).toHaveCount(0);
    await page.getByTestId('camera-proxy').selectOption(px.id);
    await expect(page.getByTestId('camera-name-placeholder')).toHaveText("The camera's own name replaces this when its proxy reports it.");
    // The name is optional behind a proxy: the form submits without it, the record takes the reported name.
    await page.getByTestId('camera-cams-id').fill('side');
    await expect(page.getByTestId('camera-name')).not.toHaveAttribute('required', '');
    await page.getByTestId('camera-proxy-cam').fill('cam2');
    await page.getByTestId('camera-add').click();
    await expect(page.getByTestId('camera-row-side')).toBeVisible();
    await expect(page.getByTestId('camera-error')).toHaveCount(0);
    // No queued renames: with the proxy gone the rename is refused, and the form keeps the typed name.
    await c.stop();
    await page.getByTestId('camera-edit-garage').click();
    await page.getByTestId('camera-edit-name').fill('Side door');
    await expect(async () => {
      await page.getByTestId('camera-edit-save').click();
      await expect(page.getByTestId('camera-error')).toHaveText('The proxy is offline: a rename needs it connected. Try again when it is online.', { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expect(page.getByTestId('camera-edit-name')).toHaveValue('Side door');
  } finally {
    await c.stop();
  }
});

test('a camera without a proxy keeps a record-only name', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'cnd'), displayName: 'Direct' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'porch', name: 'Porch', kind: 'camera', host: '192.0.2.40' });
  await page.goto(`/#/accounts/${acc.id}/cameras`);
  await page.getByTestId('camera-edit-porch').click();
  await expect(page.getByTestId('camera-edit-name-note')).toHaveText("This camera has no proxy: the name is only cams-admin's record.");
  await page.getByTestId('camera-edit-name').fill('Front porch');
  await page.getByTestId('camera-edit-save').click();
  await expect(page.getByTestId('camera-edit-form')).toHaveCount(0);
  await expect(page.getByTestId('camera-row-porch')).toContainText('Front porch');
});
