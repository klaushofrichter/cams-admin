import { expect, request, test } from '@playwright/test';
import { api, signIn, uniq } from './helpers';
import { BASE } from './env';

test.beforeEach(async ({ context }) => signIn(context));

test('a diagnostics token is shown once with the save command, reads /diag without a session, and stops after revoke', async ({ page }, info) => {
  // Room under the live-token cap whatever earlier runs left.
  for (const t of (await api(page, 'GET', '/diag-tokens')).items) if (t.state === 'active') await api(page, 'POST', `/diag-tokens/${t.id}/revoke`);
  const name = uniq(info, 'diag').slice(0, 64);
  await page.goto('/#/diagnostics');
  await page.getByTestId('diag-name').fill(name);
  await page.getByTestId('diag-days').fill('1');
  await page.getByTestId('diag-issue').click();
  const field = page.getByTestId('shown-token');
  await expect(field).toHaveValue(/^cad_[A-Za-z0-9_-]{43}$/);
  const token = await field.inputValue();
  await expect(page.getByTestId('diag-save')).toContainText('pbpaste > ~/.config/cams-admin/diag-token');
  await page.getByTestId('shown-stored').check();
  await page.getByTestId('shown-close').click();
  expect(await page.content()).not.toContain(token);
  await expect(page.getByTestId(`diag-state-${name}`)).toHaveText('active');

  // A fresh client without the session cookie.
  const anon = await request.newContext();
  try {
    const r = await anon.get(`${BASE}/api/v1/diag/proxies`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status()).toBe(200);
    expect((await anon.get(`${BASE}/api/v1/dashboard`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
    await page.getByTestId(`diag-revoke-${name}`).click();
    await expect(page.getByTestId(`diag-state-${name}`)).toHaveText('revoked');
    expect((await anon.get(`${BASE}/api/v1/diag/proxies`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
  } finally {
    await anon.dispose();
  }
});

test('an operations token is shown once with its scopes, listed as active, and revoked', async ({ page }, info) => {
  // Room under the live-token cap whatever earlier runs left.
  for (const t of (await api(page, 'GET', '/ops-tokens')).items) if (t.state === 'active') await api(page, 'POST', `/ops-tokens/${t.id}/revoke`);
  const name = uniq(info, 'ops').slice(0, 64);
  await page.goto('/#/diagnostics');
  await page.getByTestId('ops-name').fill(name);
  await page.getByTestId('ops-days').fill('1');
  // Each scope's tick sits on the line of its name, just ahead of it.
  const tick = await page.getByTestId('ops-scope-tokens').boundingBox();
  const word = await page.getByTestId('ops-scope-tokens').locator('xpath=following-sibling::code[1]').boundingBox();
  expect(tick && word).toBeTruthy();
  expect(Math.abs((tick!.y + tick!.height / 2) - (word!.y + word!.height / 2))).toBeLessThan(6);
  expect(word!.x).toBeGreaterThan(tick!.x);
  await page.getByTestId('ops-scope-tokens').check();
  await page.getByTestId('ops-issue').click();
  const field = page.getByTestId('shown-token');
  await expect(field).toHaveValue(/^cao_[A-Za-z0-9_-]{43}$/);
  const token = await field.inputValue();
  // Copy says so for a moment, and the clipboard holds the token.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('shown-copy').click();
  await expect(page.getByTestId('shown-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await expect(page.getByTestId('shown-copy')).toHaveText('Copy', { timeout: 5000 });
  await expect(page.getByTestId('ops-save')).toContainText('pbpaste > ~/.config/cams-admin/ops-token');
  await page.getByTestId('shown-stored').check();
  await page.getByTestId('shown-close').click();
  expect(await page.content()).not.toContain(token);
  await expect(page.getByTestId(`ops-state-${name}`)).toHaveText('active');
  await expect(page.getByTestId(`ops-row-${name}`)).toContainText('tokens');

  // Gone after a reload.
  await page.reload();
  expect(await page.content()).not.toContain(token);
  await expect(page.getByTestId(`ops-state-${name}`)).toHaveText('active');

  await page.getByTestId(`ops-revoke-${name}`).click();
  await expect(page.getByTestId(`ops-state-${name}`)).toHaveText('revoked');
});

test('long-lived tokens: 180 days and "Never expires" are shown in orange, "never" as the expiry; 30 days is not', async ({ page }, info) => {
  // Desktop only, and it revokes only its own tokens: the tests above clear the lists and the live cap is 5.
  test.skip(info.project.name === 'phone', 'shares the live-token cap with the tests above');
  const mine: string[] = [];
  const issue = async (name: string, days: string | null) => {
    await page.getByTestId('ops-name').fill(name);
    if (days === null) await page.getByTestId('ops-never').check();
    else { await page.getByTestId('ops-never').uncheck(); await page.getByTestId('ops-days').fill(days); }
    await page.getByTestId('ops-scope-moves').check();
    await page.getByTestId('ops-issue').click();
    await page.getByTestId('shown-stored').check();
    await page.getByTestId('shown-close').click();
  };
  await page.goto('/#/diagnostics');
  const n30 = uniq(info, 'ops30').slice(0, 64), n180 = uniq(info, 'ops180').slice(0, 64), never = uniq(info, 'opsnever').slice(0, 64);
  try {
    await issue(n30, '30');
    await expect(page.getByTestId('ops-long-note')).toHaveCount(0);
    await page.getByTestId('ops-days').fill('180');
    await expect(page.getByTestId('ops-long-note')).toHaveText('Long-lived token (over 90 days)');
    await issue(n180, '180');
    await issue(never, null);
    await expect(page.getByTestId('ops-days')).toBeDisabled();
    await expect(page.getByTestId('ops-long-note')).toHaveText('Never expires');

    const color = (id: string) => page.getByTestId(id).evaluate((e) => getComputedStyle(e).color);
    const warning = await page.evaluate(() => { const s = document.createElement('span'); s.style.color = 'var(--warning)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; });
    expect(await color(`ops-expires-${n180}`)).toBe(warning);
    expect(await color(`ops-expires-${never}`)).toBe(warning);
    expect(await color(`ops-expires-${n30}`)).not.toBe(warning);
    await expect(page.getByTestId(`ops-expires-${n30}`)).not.toHaveAttribute('title');
    await expect(page.getByTestId(`ops-expires-${n180}`)).toHaveAttribute('title', 'Long-lived token (expires in over 90 days)');
    await expect(page.getByTestId(`ops-expires-${never}`)).toHaveText('never');
    await expect(page.getByTestId(`ops-expires-${never}`)).toHaveAttribute('title', 'Never expires');

    // Over 180 days: the form does not send it.
    await page.getByTestId('ops-never').uncheck();
    await page.getByTestId('ops-days').fill('181');
    expect(await page.getByTestId('ops-days').evaluate((e) => (e as HTMLInputElement).validity.rangeOverflow)).toBe(true);

    // A diagnostics token that never expires.
    const dn = uniq(info, 'diagnever').slice(0, 64);
    await page.getByTestId('diag-name').fill(dn);
    await page.getByTestId('diag-never').check();
    await page.getByTestId('diag-issue').click();
    await page.getByTestId('shown-stored').check();
    await page.getByTestId('shown-close').click();
    await expect(page.getByTestId(`diag-expires-${dn}`)).toHaveText('never');
    await expect(page.getByTestId(`diag-expires-${dn}`)).toHaveAttribute('title', 'Never expires');
    mine.push(dn);

    // The dashboard's badge names them (not the 30-day one) and leads to the token lists.
    await page.goto('/#/');
    const badge = page.getByTestId('dash-long-tokens');
    await expect(badge).toHaveText(/^\d+ long tokens$/);
    for (const n of [n180, never, dn]) await expect(badge).toHaveAttribute('title', new RegExp(`[:,] ${n}(,|$)`));
    expect(await badge.getAttribute('title')).not.toContain(n30);
    expect(await badge.evaluate((e) => getComputedStyle(e).color)).toBe(warning);
    await badge.click();
    await expect(page).toHaveURL(/#\/diagnostics$/);
    await expect(page.getByTestId('ops-tokens')).toBeVisible();
  } finally {
    for (const t of (await api(page, 'GET', '/ops-tokens')).items) if (t.state === 'active' && [n30, n180, never].includes(t.name)) await api(page, 'POST', `/ops-tokens/${t.id}/revoke`);
    for (const t of (await api(page, 'GET', '/diag-tokens')).items) if (t.state === 'active' && mine.includes(t.name)) await api(page, 'POST', `/diag-tokens/${t.id}/revoke`);
  }
});
