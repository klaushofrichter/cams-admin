import { expect, test } from '@playwright/test';
import { api, client, enroll, signIn, uniq } from './helpers';
import { BASE } from './env';

test.beforeEach(async ({ context }) => signIn(context));

async function proxyWith(page: import('@playwright/test').Page, name: string, commands: { allow: string[] } | null) {
  const acc = await api(page, 'POST', '/accounts', { name, displayName: 'Tokens' });
  const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name: 'p1', displayName: 'P1', runsOn: 'local-host' });
  const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
  const key = await enroll(BASE, code);
  const c = client(key, undefined, commands ? { commands } : {});
  c.start();
  return { acc, px, c };
}

test('a client token is shown once, then only its state: issue → active, retire → retiring, revoke → revoked', async ({ page }, info) => {
  const { acc, px, c } = await proxyWith(page, uniq(info, 'tok'), { allow: ['tokens.apply'] });
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('commands-policy')).toHaveText('allowed: tokens.apply');
    await expect(page.getByTestId('issue-admin')).toBeDisabled();
    await expect(page.getByTestId('issue-admin-why')).toHaveText('the proxy does not allow tokens.apply.admin');
    await page.getByTestId('token-label').fill('cams e2e');
    await page.getByTestId('issue-client').click();
    const field = page.getByTestId('shown-token');
    await expect(field).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    const token = await field.inputValue();
    await expect(page.getByTestId('shown-close')).toBeDisabled();
    await page.getByTestId('shown-stored').check();
    await page.getByTestId('shown-close').click();
    await expect(page.getByTestId('shown-once')).toHaveCount(0);
    expect(await page.content()).not.toContain(token);
    const state = page.locator('[data-testid^="token-state-"]').first();
    await expect(state).toHaveText('active');
    await expect(page.getByTestId('commands-list')).toContainText('tokens.apply');
    await expect(page.getByTestId('commands-list')).toContainText('done');
    // Retire in 1 h.
    await page.getByTestId('retire-hours').fill('1');
    await page.locator('[data-testid^="token-retire-"]').first().click();
    await expect(state).toHaveText('retiring');
    // Revoke (confirmed).
    await page.locator('[data-testid^="token-revoke-"]').first().click();
    await page.getByTestId('confirm-ok').click();
    await expect(state).toHaveText('revoked');
    expect(await page.content()).not.toContain(token);
    // The dashboard shows the policy.
    await page.goto('/#/');
    await expect(page.getByTestId('proxy-commands-p1').first()).toBeVisible();
  } finally {
    await c.stop('shutdown');
  }
});

test('a proxy without commands says so and offers no Issue buttons', async ({ page }, info) => {
  const { acc, px, c } = await proxyWith(page, uniq(info, 'p1tok'), null);
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('live-state')).toHaveAttribute('data-state', 'online');
    await expect(page.getByTestId('commands-policy')).toHaveText('this proxy version takes no commands');
    await expect(page.getByTestId('issue-client')).toHaveCount(0);
    await expect(page.getByTestId('issue-admin')).toHaveCount(0);
  } finally {
    await c.stop('shutdown');
  }
});

test('a revoke while the proxy takes no commands shows "not yet on proxy" until it does', async ({ page }, info) => {
  const { acc, px, c } = await proxyWith(page, uniq(info, 'rvk'), { allow: ['tokens.apply'] });
  try {
    await page.goto(`/#/accounts/${acc.id}/proxies/${px.id}`);
    await expect(page.getByTestId('commands-policy')).toHaveText('allowed: tokens.apply');
    await page.getByTestId('issue-client').click();
    await page.getByTestId('shown-stored').check();
    await page.getByTestId('shown-close').click();
    const state = page.locator('[data-testid^="token-state-"]').first();
    await expect(state).toHaveText('active');
    c.commands!.enabled = false; // the env kill switch on the proxy
    await expect(page.getByTestId('commands-policy')).toHaveText('commands are off on the proxy (environment)');
    await page.locator('[data-testid^="token-revoke-"]').first().click();
    await page.getByTestId('confirm-ok').click();
    await expect(state).toHaveText('revoked, not yet on proxy');
    c.commands!.enabled = true;
    await expect(state).toHaveText('revoked', { timeout: 10_000 });
  } finally {
    await c.stop('shutdown');
  }
});
