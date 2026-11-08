// Remove camera / Decommission proxy (spec 2026-11-08 B4/B5): the panels against the test client, which answers
// camera.remove.preview, camera.remove and proxy.unenroll.
import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { DECOMMISSION_COMMANDS } from '../contract/build';
import { makeSummary } from '../test-client/summaries';

test.beforeEach(async ({ context }) => signIn(context));

async function setup(page: import('@playwright/test').Page, info: import('@playwright/test').TestInfo, tag: string) {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, tag), displayName: 'Decommission' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  let cameras = 1;
  const c = client(key, () => {
    const s = makeSummary({ cameras: 1, now: Date.now() });
    if (cameras === 0) s.cameras = [];
    return s;
  }, { commands: { allow: [...DECOMMISSION_COMMANDS] } });
  c.start();
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${acc.id}/proxies/${px.id}/status`)).reported?.commands?.allow?.length ?? 0).toBe(3);
  return { acc, px, c, noCameras: () => { cameras = 0; } };
}

test('Remove from proxy: counts, delete now with the archive, typed confirm, the answer, the record gone', async ({ page }, info) => {
  const { acc, px, c } = await setup(page, info, 'rmc');
  try {
    await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'gate', name: 'Gate', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam1', host: '192.0.2.40' });
    await page.goto(`/#/accounts/${acc.id}/cameras`);
    await page.getByTestId('camera-remove-gate').click();
    const lines = page.getByTestId('remove-camera-lines');
    await expect(lines).toContainText('12 clips and 340 stills');
    await expect(page.getByTestId('remove-camera-keep')).toBeChecked();
    // The archive box only with delete now (and archived clips on the proxy).
    await expect(page.getByTestId('remove-camera-archive')).toHaveCount(0);
    await page.getByTestId('remove-camera-delete').check();
    await expect(page.getByTestId('remove-camera-archive')).not.toBeChecked();
    await expect(page.getByTestId('remove-camera-archive').locator('..')).toContainText('Also delete its archived clips (2)');
    await expect(page.getByTestId('remove-camera-lines-stays')).toContainText('2 archived clips (outside retention)');
    await page.getByTestId('remove-camera-archive').check();
    await expect(page.getByTestId('remove-camera-lines-goes')).toContainText('12 clips and 340 stills and 2 archived clips');
    await expect(page.getByTestId('remove-camera-ok')).toBeDisabled();
    await page.getByTestId('remove-camera-input').fill('gate');
    await page.getByTestId('remove-camera-ok').click();
    await expect(page.getByTestId('remove-camera-result')).toContainText('Deleted 12 clips, 340 stills, 2 archived clips.', { timeout: 15_000 });
    await expect(page.getByTestId('camera-remove-gate')).toHaveCount(0);
    expect(c.receivedCommands.filter((m) => m.body.command === 'camera.remove').map((m) => m.body.args)).toEqual([{ v: 1, camera: 'cam1', content: 'delete', archive: true }]);
    const audit = await api(page, 'GET', `/audit?account=${acc.id}&action=camera-remove`);
    expect(audit.items[0]).toMatchObject({ outcome: 'ok', detail: { content: 'delete', archive: true } });
  } finally {
    await c.stop();
  }
});

test('Remove from proxy with the proxy offline: Delete record only', async ({ page }, info) => {
  const { acc, px, c } = await setup(page, info, 'rmo');
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'gate', name: 'Gate', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam1', host: '192.0.2.40' });
  await c.stop();
  await page.goto(`/#/accounts/${acc.id}/cameras`);
  await page.getByTestId('camera-remove-gate').click();
  await expect(page.getByTestId('remove-camera-offline')).toBeVisible();
  await page.getByTestId('remove-camera-record-only').click();
  await expect(page.getByTestId('confirm')).toContainText('Delete camera gate');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('camera-delete-gate')).toHaveCount(0);
});

test('Decommission: disabled while the proxy reports cameras; then typed confirm, unenroll, record gone', async ({ page }, info) => {
  const { acc, px, c, noCameras } = await setup(page, info, 'dec');
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await page.getByTestId('decommission-proxy').click();
    await expect(page.getByTestId('decommission-lines-blocked')).toHaveText('The proxy still holds cam1: remove it first.');
    await expect(page.getByTestId('decommission-cameras').locator('a')).toHaveText('cam1');
    await expect(page.getByTestId('decommission-ok')).toBeDisabled();
    await page.getByTestId('decommission-cancel').click();
    noCameras();
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${acc.id}/proxies/${px.id}/decommission-preview`)).reportedCameras.length).toBe(0);
    await page.getByTestId('decommission-proxy').click();
    await expect(page.getByTestId('decommission-lines-goes')).toContainText('its enrollment');
    await expect(page.getByTestId('decommission-lines-stays')).toContainText("on the proxy's host");
    await page.getByTestId('decommission-input').fill('p1');
    await page.getByTestId('decommission-ok').click();
    await expect(page.getByTestId('decommission-done')).toBeVisible({ timeout: 15_000 });
    const proxies = await api(page, 'GET', `/accounts/${acc.id}/proxies`);
    expect(proxies.items).toEqual([]);
    await page.getByTestId('decommission-close').click();
    await expect(page).toHaveURL(new RegExp(`#/accounts/${acc.id}/proxies$`));
  } finally {
    await c.stop();
  }
});

test('Decommission with the proxy offline: the host is told to unenroll; Delete record only', async ({ page }, info) => {
  const { acc, px, c } = await setup(page, info, 'deo');
  await c.stop();
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await page.getByTestId('decommission-proxy').click();
  await expect(page.getByTestId('decommission-offline')).toContainText('admin-unenroll');
  await page.getByTestId('decommission-record-only').click();
  await expect(page.getByTestId('confirm')).toContainText('Delete p1');
});
