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
