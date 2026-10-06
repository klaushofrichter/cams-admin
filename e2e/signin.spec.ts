import { expect, test } from '@playwright/test';
import { setGoogleEmail } from './helpers';

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
