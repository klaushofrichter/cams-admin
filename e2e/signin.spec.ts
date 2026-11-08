import { expect, test } from '@playwright/test';
import { setGoogleEmail, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

test('a stranger is refused; the allowlisted admin signs in and out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('signin-google')).toBeVisible();
  await setGoogleEmail('stranger@example.org');
  await page.getByTestId('signin-google').click();
  await expect(page.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
  await setGoogleEmail('admin@example.com');
  await page.goto('/auth/google/login');
  await expect(page.getByTestId('dash-summary')).toBeVisible();
  await expect(page.getByTestId('me')).toHaveText('admin@example.com');
  await page.getByTestId('signout').click();
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('signin-google')).toBeVisible();
});

test('a newer build on the server: a Reload banner on focus, no reload by itself (finding 11)', async ({ page, context }) => {
  await signIn(context);
  // The served build.json is the one this bundle was built with: no banner.
  const served = await (await page.request.get('/build.json')).json();
  expect(served.id).toMatch(/\S/);
  expect((await page.request.get('/build.json')).headers()['cache-control']).toBe('no-store');
  await page.goto('/');
  await expect(page.getByTestId('dash-summary')).toBeVisible();
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForTimeout(300);
  await expect(page.getByTestId('new-build')).toHaveCount(0);
  // A deploy later: the server serves another build.
  await page.route('**/build.json', (r) => r.fulfill({ json: { id: 'a-newer-build' } }));
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('new-build')).toContainText('A new version of cams-admin is available');
  await expect(page.getByTestId('dash-summary')).toBeVisible();
  await page.getByTestId('new-build-reload').click();
  await page.unroute('**/build.json');
  await expect(page.getByTestId('dash-summary')).toBeVisible();
  await expect(page.getByTestId('new-build')).toHaveCount(0);
});
