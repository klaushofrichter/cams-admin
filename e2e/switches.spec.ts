// PoE switches (design 2026-11-07-poe-switches-design.md): the Switches tab and the camera power line. The proxy is
// the test client; its canned switch answers say which port a camera is on.
import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { POWER_COMMANDS, SWITCH_COMMANDS } from '../contract/build';
import { RefProxyConfig } from '../test-client/config';
import { makeSummary } from '../test-client/summaries';

test.beforeEach(async ({ context }) => signIn(context));

test('add a switch, test it, survey it, see the camera on its port, and force a power-cycle', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'sw'), displayName: 'Switches' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'garage', name: 'Garage', kind: 'camera', proxyId: px.id, proxyCameraId: 'cam1', host: '192.0.2.40' });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  const c = client(key, () => makeSummary({ cameras: 2, now: Date.now() }), { commands: { allow: [...SWITCH_COMMANDS, ...POWER_COMMANDS], config: new RefProxyConfig({ cameras: ['cam1', 'cam2'] }) } });
  // A serial number is unique across accounts: one per run (desktop and phone run side by side).
  const sn = `E2E${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const read = { status: 'ok', result: { sn, firmware: 'V1.0', ports: Array.from({ length: 8 }, (_, i) => ({ port: i + 1, poe: true, watts: 0, link: false, tx: 0, rx: 0 })) } } as const;
  c.switchResults.set('switch.read', read);
  const cycles: Record<string, any>[] = [];
  // Every camera of the survey is on port 3, 4.2 W.
  c.switchResults.set('switch.survey', (a) => ({ status: 'ok', result: { sn, results: a.cameras.map((x: { camera: string }) => ({ camera: x.camera, found: true, port: 3, poe: true, watts: 4.2, link: true })) } }));
  c.switchResults.set('switch.cycle', (a) => { cycles.push(a); return { status: 'ok', result: { verified: !a.force, offAt: Date.now(), onAt: Date.now() + 1000, watts: 0 } }; });
  c.start();
  try {
    await page.goto(`/#/accounts/${acc.id}/switches`);
    await page.getByTestId('switch-name').fill('GPS-208');
    await page.getByTestId('switch-host').fill('192.0.2.50');
    await page.getByTestId('switch-add').click();
    await expect(page.getByTestId('switch-add-hint')).toHaveText("Set the password on p1's Proxy settings → PoE switches, then Test.");
    await expect(page.getByTestId('switch-state-GPS-208')).toHaveText('pending');

    await page.getByTestId('switch-test-GPS-208').click();
    await expect(page.getByTestId('switch-state-GPS-208')).toHaveText('active', { timeout: 15_000 });
    await expect(page.getByTestId('switch-sn-GPS-208')).toHaveText(sn);

    await page.getByTestId('switch-survey-GPS-208').click();
    await page.getByTestId('switch-ports-GPS-208').click();
    await expect(page.getByTestId('switch-port-camera-GPS-208-3')).toHaveText('Garage', { timeout: 20_000 });

    // The camera's power line.
    await page.goto(`/#/accounts/${acc.id}/cameras`);
    await expect(page.getByTestId('power-line-garage')).toContainText('PoE: GPS-208 port 3');

    // Force: the agreed question first, then {force:true}.
    await page.getByTestId('power-force-garage').click();
    await expect(page.getByTestId('confirm')).toContainText('Cut power on GPS-208 port 3 without verification?');
    await page.getByTestId('confirm-cancel').click();
    expect(cycles).toHaveLength(0);
    await page.getByTestId('power-force-garage').click();
    // The riskier action needs the typed word too (#166).
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    await page.getByTestId('confirm-input').fill('power-cycle');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('power-result-garage')).toHaveText('Power-cycled.', { timeout: 15_000 });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].force).toBe(true);

    // The plain power-cycle asks too: camera, switch and port named, the word typed.
    await page.getByTestId('power-cycle-garage').click();
    await expect(page.getByTestId('confirm')).toContainText('Cut power on GPS-208 port 3 to restart Garage');
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    await page.getByTestId('confirm-input').fill('power-cycle');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('power-result-garage')).toHaveText('Power-cycled.', { timeout: 15_000 });
    expect(cycles).toHaveLength(2);
    expect(cycles[1].force).toBe(false);
    // The last power-cycle stays visible after a reload.
    await page.reload();
    await expect(page.getByTestId('power-last-cycle-garage')).toContainText('Last power-cycle', { timeout: 10_000 });
    await expect(page.getByTestId('power-last-cycle-garage')).toContainText('Power-cycled.');

    // The proxy's own power-cycle action steps aside for this camera.
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}?camera=cam1`);
    await expect(page.getByTestId('power-managed-cam1')).toBeVisible();
    await expect(page.getByTestId('action-cam1-camera-powercycle')).toHaveCount(0);

    // Remove: the confirm names the camera that becomes unknown.
    await page.goto(`/#/accounts/${acc.id}/switches`);
    await page.getByTestId('switch-remove-GPS-208').click();
    await expect(page.getByTestId('confirm')).toContainText('Garage');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('switch-row-GPS-208')).toHaveCount(0, { timeout: 20_000 });
    await page.goto(`/#/accounts/${acc.id}/cameras`);
    await expect(page.getByTestId('power-line-garage')).toHaveText('Unknown');
  } finally {
    await c.stop();
  }
});

test('a chained switch: two cameras behind one port are a configuration issue on the switch, its port and the dashboard', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'ch'), displayName: 'Chained' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  for (const [id, ref, host] of [['garage', 'cam1', '192.0.2.41'], ['porch', 'cam2', '192.0.2.42']]) await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: id, name: id, kind: 'camera', proxyId: px.id, proxyCameraId: ref, host });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  const c = client(key, () => makeSummary({ cameras: 2, now: Date.now() }), { commands: { allow: [...SWITCH_COMMANDS, ...POWER_COMMANDS], config: new RefProxyConfig({ cameras: ['cam1', 'cam2'] }) } });
  const sn = `E2E${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  c.switchResults.set('switch.read', { status: 'ok', result: { sn, firmware: 'V1.0', ports: [] } });
  // Both cameras on port 8: another switch hangs there.
  c.switchResults.set('switch.survey', (a) => ({ status: 'ok', result: { sn, results: a.cameras.map((x: { camera: string }) => ({ camera: x.camera, found: true, port: 8, poe: true, watts: 0, link: true })) } }));
  c.start();
  try {
    await page.goto(`/#/accounts/${acc.id}/switches`);
    await page.getByTestId('switch-name').fill('GPS-208');
    await page.getByTestId('switch-host').fill('192.0.2.51');
    await page.getByTestId('switch-add').click();
    await page.getByTestId('switch-test-GPS-208').click();
    await expect(page.getByTestId('switch-state-GPS-208')).toHaveText('active', { timeout: 15_000 });
    await page.getByTestId('switch-survey-GPS-208').click();
    await expect(page.getByTestId('switch-problem-GPS-208-8')).toHaveText('Configuration issue: another switch is chained on port 8 (2 cameras behind it). Connect each PoE switch directly to its proxy\'s network instead of through another PoE switch.', { timeout: 20_000 });
    await expect(page.getByTestId('switch-config-GPS-208')).toHaveText('configuration issue');
    await page.getByTestId('switch-ports-GPS-208').click();
    await expect(page.getByTestId('switch-port-trunk-GPS-208-8')).toHaveText('trunk (2 cameras)');
    await page.goto('/#/');
    await expect(page.getByTestId(`warn-chained-switch-${acc.name}`)).toHaveText('GPS-208: another switch chained on port 8');
  } finally {
    await c.stop();
  }
});

test('the Operating proxy of a new switch: never the cluster proxy by default; a choice when several could run it', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'swp'), displayName: 'Switch proxies' });
  // Named first, so it comes first in the account's proxy list.
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'a-cluster', displayName: 'Cluster', runsOn: 'cluster' });
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'een', displayName: 'een', runsOn: 'local-host' });
  await page.goto(`/#/accounts/${acc.id}/switches`);
  const sel = page.getByTestId('switch-proxy');
  await expect(sel.locator('option:checked')).toHaveText('een');
  await expect(sel.locator('option').last()).toHaveText('a-cluster (cluster)');
  // A second local proxy: no default, Add asks for a choice (nothing is created).
  await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' });
  await page.reload();
  await expect(sel).toHaveValue('');
  await page.getByTestId('switch-name').fill('GPS-208');
  await page.getByTestId('switch-host').fill('192.0.2.52');
  await page.getByTestId('switch-add').click();
  expect((await api(page, 'GET', `/accounts/${acc.id}/switches`)).items).toEqual([]);
  await sel.selectOption({ label: 'pi' });
  await page.getByTestId('switch-add').click();
  await expect(page.getByTestId('switch-add-hint')).toHaveText("Set the password on pi's Proxy settings → PoE switches, then Test.");
});
