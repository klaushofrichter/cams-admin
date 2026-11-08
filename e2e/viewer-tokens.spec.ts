import { expect, test } from '@playwright/test';
import { api, signIn, uniq } from './helpers';

// Viewer tokens on an account's Users tab (design 2026-11-05): add, copy,
// the QR window, validity, revoke and valid again, accounts, delete.
test.beforeEach(async ({ context }) => {
  await signIn(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('add a token, copy it, see its QR code, change validity and accounts, revoke, delete', async ({ page }, info) => {
  const name = uniq(info, 'vt');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Viewer tokens' });
  const other = await api(page, 'POST', '/accounts', { name: `${name}-2`.slice(0, 32), displayName: 'Other' });
  await page.goto(`/#/accounts/${acc.id}/users`);
  await expect(page.getByTestId('vt-empty')).toBeVisible();
  await expect(page.getByTestId('vt-days')).toHaveValue('7');
  await expect(page.getByTestId(`vt-pick-${name}`)).toBeChecked();

  // Add: the QR window opens with the code and the link's host.
  await page.getByTestId('vt-name').fill('Kitchen tablet');
  await page.getByTestId('vt-add').click();
  const win = page.getByTestId('vt-qr-window');
  await expect(win).toBeVisible();
  await expect(win).toContainText('cams.skylar.technology');
  await expect(page.getByTestId('vt-qr-code')).toHaveAttribute('viewBox', '0 0 45 45'); // version 5 + quiet zone 4
  await page.getByTestId('vt-copy-link').click();
  await expect(page.getByTestId('vt-copy-link')).toHaveText('Copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^https:\/\/cams\.skylar\.technology\/token#t=cav_[0-9A-Za-z]{22}$/);
  expect(link.length).toBeLessThanOrEqual(65);
  await page.getByTestId('vt-qr-close').click();
  await expect(win).toHaveCount(0);

  const row = page.getByTestId('vt-row-Kitchen tablet');
  await expect(page.getByTestId('vt-state-Kitchen tablet')).toHaveText('valid');
  await expect(page.getByTestId('vt-accounts-Kitchen tablet')).toHaveText(name);
  // The page never holds the token after the window closed.
  const token = link.split('#t=')[1];
  expect(await page.content()).not.toContain(token);

  // Copy, any time: the same token.
  await page.getByTestId('vt-copy-Kitchen tablet').click();
  await expect(page.getByTestId('vt-copy-Kitchen tablet')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // Validity: revoke, then valid again for 30 days with the same token.
  await page.getByTestId('vt-validity-Kitchen tablet').click();
  await page.getByTestId('vt-revoke').click();
  await expect(page.getByTestId('vt-state-Kitchen tablet')).toHaveText('revoked');
  await page.getByTestId('vt-validity-Kitchen tablet').click();
  await page.getByTestId('vt-validity-days').selectOption('30');
  await page.getByTestId('vt-validity-save').click();
  await expect(page.getByTestId('vt-state-Kitchen tablet')).toHaveText('valid');
  await page.getByTestId('vt-copy-Kitchen tablet').click();
  await expect(page.getByTestId('vt-copy-Kitchen tablet')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // Accounts: add the other account.
  await page.getByTestId('vt-edit-accounts-Kitchen tablet').click();
  await page.getByTestId(`vt-acc-${other.name}`).check();
  await page.getByTestId('vt-accounts-save').click();
  await expect(page.getByTestId('vt-accounts-Kitchen tablet')).toContainText(other.name);
  await page.goto(`/#/accounts/${other.id}/users`);
  await expect(page.getByTestId('vt-row-Kitchen tablet')).toBeVisible();

  // QR code from the list.
  await page.getByTestId('vt-qr-Kitchen tablet').click();
  await expect(page.getByTestId('vt-qr-window')).toBeVisible();
  await page.getByTestId('vt-qr-close').click();

  // Delete (confirmed): gone from both accounts.
  await page.getByTestId('vt-delete-Kitchen tablet').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('vt-empty')).toBeVisible();
  await page.goto(`/#/accounts/${acc.id}/users`);
  await expect(page.getByTestId('vt-empty')).toBeVisible();
  await expect(row).toHaveCount(0);

  // Every step is in the audit log, never the token.
  const audit = await api(page, 'GET', '/audit?limit=200');
  const actions = audit.items.filter((x: { targetLabel: string }) => x.targetLabel === 'Kitchen tablet').map((x: { action: string }) => x.action);
  for (const a of ['viewer-token-create', 'viewer-token-copy', 'viewer-token-revoke', 'viewer-token-validity', 'viewer-token-accounts', 'viewer-token-delete']) expect(actions).toContain(a);
  expect(JSON.stringify(audit)).not.toContain(token);
});

test('a token role: admin on add (orange, one-line warning), back to viewer per token; audited (spec 2026-11-08 B6)', async ({ page }, info) => {
  const name = uniq(info, 'vtr');
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Token roles' });
  await page.goto(`/#/accounts/${acc.id}/users`);
  await expect(page.getByTestId('vt-role')).toHaveValue('viewer');
  await expect(page.getByTestId('vt-admin-warning')).toHaveCount(0);
  await page.getByTestId('vt-name').fill('Kit admin');
  await page.getByTestId('vt-role').selectOption('admin');
  await expect(page.getByTestId('vt-admin-warning')).toContainText('An admin token can confirm held cameras');
  await page.getByTestId('vt-add').click();
  await page.getByTestId('vt-qr-close').click();
  // The warning belongs to the form's choice: back on viewer, it goes, even with an admin token listed (orange row).
  await expect(page.getByTestId('vt-role')).toHaveValue('viewer');
  await expect(page.getByTestId('vt-admin-warning')).toHaveCount(0);
  const sel = page.getByTestId('vt-role-Kit admin');
  await expect(sel).toHaveValue('admin');
  await expect(sel).toHaveClass(/warn/);
  await sel.selectOption('viewer');
  await expect.poll(async () => (await api(page, 'GET', `/viewer-tokens?account=${acc.id}`)).items[0].role).toBe('viewer');
  await expect(page.getByTestId('vt-role-Kit admin')).toHaveValue('viewer');
  const audit = await api(page, 'GET', `/audit?account=${acc.id}&action=viewer-token-role`);
  expect(audit.items[0].detail).toMatchObject({ role: 'viewer', from: 'admin' });
});
