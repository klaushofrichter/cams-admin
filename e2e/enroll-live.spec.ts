import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { summaryLeaves } from '../web/src/lib/summaryTree';

test.beforeEach(async ({ context }) => signIn(context));

test('a code is shown once, a proxy enrolls, the dashboard turns green live, then grey and offline', async ({ page }, info) => {
  const name = uniq(info, 'live');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Live' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await page.getByTestId('code-create').click();
  const code = (await page.getByTestId('code-value').textContent())!.trim();
  await expect(page.getByTestId('code-command')).toContainText('admin-enroll --url');
  await page.reload();
  await expect(page.getByTestId('code-box')).toHaveCount(0); // shown once
  await expect(page.getByTestId('code-live')).toBeVisible();
  // The fake proxy enrolls and connects.
  const key = await enroll(BASE, code, { version: 'e2e', cameraIds: ['cam1', 'cam2'] });
  // Redeemed but not yet connected (live, without a reload): the code is gone, the key pending.
  await expect(page.getByTestId('code-live')).toHaveCount(0);
  await expect(page.getByTestId(`key-state-${key.keyId}`)).toHaveText('pending: waiting for its first connection');
  const c = client(key);
  c.start();
  // Its first hello makes it the active key (live, without a reload).
  await expect(page.getByTestId(`key-state-${key.keyId}`)).toHaveText('active');
  await page.goto('/#/');
  const row = page.getByTestId(`dash-account-${name}`);
  await expect(row.getByTestId('proxy-state-p1')).toHaveAttribute('data-state', 'online');
  await expect(row.getByTestId('cam-chip-p1-cam1')).toHaveAttribute('data-online', 'true');
  // Gone without a bye: still online, then offline within OFFLINE_AFTER_S (3 s); cameras grey.
  c.abort();
  await expect(row.getByTestId('proxy-state-p1')).toHaveAttribute('data-state', 'offline', { timeout: 6000 });
  await expect(row.getByTestId('cam-chip-p1-cam1')).toHaveAttribute('data-online', 'null');
});

test('a shown code disappears live once a proxy redeems it', async ({ page }, info) => {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, 'redeem'), displayName: 'Redeem' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await page.getByTestId('code-create').click();
  const code = (await page.getByTestId('code-value').textContent())!.trim();
  await expect(page.getByTestId('code-live')).toBeVisible();
  const key = await enroll(BASE, code);
  await expect(page.getByTestId('code-box')).toHaveCount(0);
  await expect(page.getByTestId('code-live')).toHaveCount(0);
  await expect(page.getByTestId(`key-state-${key.keyId}`)).toHaveText('pending: waiting for its first connection');
});

test('reconciliation: adopt a reported camera; a pin mismatch shows red; every summary field is on the page', async ({ page }, info) => {
  const name = uniq(info, 'recon');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Recon' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host', caFingerprints: ['AB'.repeat(32)] });
  const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
  const key = await enroll(BASE, code);
  const summary = makeSummary({ cameras: 4, now: Date.now(), site: true, offline: ['cam3'] });
  const c = client(key, () => ({ ...summary, generatedAt: Date.now() }), { proxyInfo: () => makeProxyInfo({ now: Date.now(), site: 'garage', caFingerprint: ['SHA256:' + 'CD'.repeat(32)] }) });
  c.start();
  await page.goto('/#/');
  const row = page.getByTestId(`dash-account-${name}`);
  await expect(row.getByTestId('badge-pin-p1')).toBeVisible();
  await expect(row.getByTestId('badge-reported-p1')).toContainText('4 reported');
  await row.getByTestId('proxy-link-p1').click();
  await expect(page.getByTestId('pin-status')).toContainText('MISMATCH');
  await page.getByTestId('adopt-cam2').click();
  await expect(page.getByTestId('reconcile-reported-cam2')).toHaveCount(0);
  // All fields: every leaf of what was sent is rendered.
  await page.getByTestId('all-fields-toggle').click();
  const leaves = summaryLeaves(summary).filter((l) => l.path !== 'generatedAt');
  for (const l of leaves) await expect(page.getByTestId(`sum-${l.path}`), l.path).toHaveText(l.text);
  // Take the reported pin into the registry: green, and the registry field shows it.
  await page.getByTestId('pins-from-report').click();
  await expect(page.getByTestId('pin-status')).toContainText('matches', { timeout: 5000 });
  await expect(page.getByTestId('pins-from-report')).toHaveCount(0);
  await expect(page.getByTestId('proxy-fingerprints')).toHaveValue('SHA256:' + 'CD'.repeat(32));
  await c.stop();
});

test('hostile text renders as text', async ({ page }, info) => {
  const name = uniq(info, 'hostile');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Hostile' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  const s = makeSummary({ cameras: 1, now: Date.now() }) as any;
  s.camera.name = s.cameras[0].camera.name = '<img src=x id=pwned onerror="document.title=1">';
  s.items[0].text = '<script>window.pwned=1</script>';
  const c = client(key, () => s);
  c.start();
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await expect(page.getByTestId('summary-camera-cam1')).toContainText('<img src=x id=pwned');
  await expect(page.locator('#pwned')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await c.stop();
});

test('revoke a key, block, delete the account with its typed name; the audit log lists it all', async ({ page }, info) => {
  const name = uniq(info, 'gone');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Gone' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const key = await enroll(BASE, (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code);
  const c = client(key);
  c.start();
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  await expect(page.getByTestId('live-state')).toHaveAttribute('data-state', 'online');
  await page.getByTestId('key-revoke').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('live-state')).toHaveAttribute('data-state', 'rejected');
  await expect.poll(() => c.state).toBe('rejected');
  await page.getByTestId('block-proxy').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('live-state')).toHaveAttribute('data-state', 'revoked');
  await page.goto(`/#/accounts/${acc.id}`);
  await page.getByTestId('delete-account').click();
  await expect(page.getByTestId('account-delete-lines-goes')).toContainText('1 proxy (disconnected, keys revoked)');
  await expect(page.getByTestId('account-delete-lines-stays')).toContainText('the audit log');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.getByTestId('confirm-input').fill(name);
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/#\/accounts$/);
  await page.goto('/#/audit');
  await page.getByTestId('audit-filter-action').selectOption('account-delete');
  await expect(page.getByTestId('audit-row').first()).toContainText(name);
  for (const action of ['key-revoke', 'proxy-block', 'proxy-enrolled', 'enrollment-code-create', 'proxy-create', 'account-create']) {
    await page.getByTestId('audit-filter-action').selectOption(action);
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
  }
  await c.stop();
});

test('backup now shows its result', async ({ page }) => {
  await page.goto('/#/backup');
  await page.getByTestId('backup-now').click();
  await expect(page.getByTestId('backup-result')).toContainText('Snapshot: cams-admin/dev/snapshots/manual-');
  await expect(page.getByTestId('backup-result')).toContainText('Litestream is not configured');
});

test('the enrollment code lifetime the person picks is what the server stores and the audit says (finding 10)', async ({ page }, info) => {
  const name = uniq(info, 'life');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Life' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
  const audited = async () => {
    const a = await api(page, 'GET', `/audit?account=${acc.id}&action=enrollment-code-create&limit=1`);
    return a.items[0].detail.lifetimeH;
  };
  for (const [label, h] of [['1 h', 1], ['7 d', 168], ['24 h', 24]] as const) {
    await page.getByTestId('code-lifetime').selectOption({ label });
    const t0 = Date.now();
    await page.getByTestId('code-create').click();
    await expect(page.getByTestId('code-value')).toBeVisible();
    expect(await audited()).toBe(h);
    const st = await api(page, 'GET', `/accounts/${acc.id}/proxies/${px.id}/status`);
    expect(Math.abs(st.enrollment.expiresAt - (t0 + h * 3600_000))).toBeLessThan(60_000);
  }
  // A value set without a change event (a script, some automation) is still the one sent.
  await page.getByTestId('code-lifetime').evaluate((el: HTMLSelectElement) => { el.value = '1'; });
  await page.getByTestId('code-create').click();
  await expect.poll(audited).toBe(1);
});
