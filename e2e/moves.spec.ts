import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { ENV } from './env';
import { BASE } from './env';
import { api, client, enroll, signIn, uniq } from './helpers';

test.beforeEach(async ({ context }) => signIn(context));

// Two connected fake proxies (so the move service does not fail the move for an absent proxy) in one new account.
async function twoProxies(page: import('@playwright/test').Page, info: import('@playwright/test').TestInfo, base: string) {
  const acc = await api(page, 'POST', '/accounts', { name: uniq(info, base), displayName: 'Moves' });
  const out: { id: string; stop: () => void }[] = [];
  for (const [name, displayName] of [['old', 'Old proxy'], ['new', 'New proxy']]) {
    const px = await api(page, 'POST', `/accounts/${acc.id}/proxies`, { name, displayName, runsOn: 'cluster' });
    const code = (await api(page, 'POST', `/accounts/${acc.id}/proxies/${px.id}/enrollment-codes`, {})).code;
    const c = client(await enroll(BASE, code), undefined, { commands: { allow: ['move.send', 'move.receive'] } });
    c.start();
    out.push({ id: px.id, stop: () => c.abort() });
  }
  return { acc, a: out[0], b: out[1] };
}

// A camera on the first proxy and a move between two proxies in `phase`, straight into the database (RFC 5737 addresses).
function insertMove(accountId: string, src: string, tgt: string, phase: string, n: number): string {
  const db = new DatabaseSync(ENV.DB_FILE);
  db.exec('PRAGMA busy_timeout = 5000');
  const id = `mv_${Array.from({ length: 20 }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('')}`;
  const cam = `cam_${id.slice(3)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,host,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cam, accountId, src, `porch${n}`, `pc${n}`, `Porch ${n}`, 'camera', '192.0.2.10', now, now);
  db.prepare(`INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,reason,plan,token_hash,target_ip,target_public_key,leaf_fingerprint,bytes_total,bytes_done,rate_bps,eta_s,budget_exceeded_at,created_at,updated_at,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(id, accountId, cam, src, tgt, `rq_${id}`, phase, null, JSON.stringify({ transfer: true, kinds: ['clips'], space: 'all', budgetS: 60 }), 'sha256:' + 'ab'.repeat(32), '192.0.2.77', 'TARGET-PUBLIC-KEY-MATERIAL', 'SHA256:AAAA', 2048, 1024, 50, 20, phase === 'awaiting-approval' ? now : null, now, now);
  if (phase === 'copying') db.prepare('INSERT INTO move_chunks (move_id,chunk_id,state) VALUES (?,?,?)').run(id, 'c1', 'pending');
  db.close();
  return id;
}

test('moves page lists a move and cancels it', async ({ page }, info) => {
  const { acc, a, b } = await twoProxies(page, info, 'mv');
  const id = insertMove(acc.id, a.id, b.id, 'awaiting-approval', 1);
  await page.goto('/#/moves');
  await expect(page.getByRole('heading', { name: 'Moves' })).toBeVisible();
  const row = page.getByTestId(`move-row-${id}`);
  await expect(row).toContainText('Porch 1');
  await expect(row).toContainText('Old proxy');
  await expect(row).toContainText('New proxy');
  await expect(row).toContainText('1.0 KiB of 2.0 KiB (50%)');
  await expect(page.getByTestId(`move-phase-${id}`)).toHaveText('waiting for approval');
  await expect(page.getByTestId(`move-budget-${id}`)).toHaveText('Over time budget');
  // A move under way: a count on the Moves menu item and a line on the Dashboard.
  await expect(page.getByTestId('nav-moves-active')).toBeVisible();
  await page.goto('/#/');
  await expect(page.getByTestId(`dash-move-${id}`)).toContainText('Porch 1: Old proxy → New proxy');
  await page.goto('/#/moves');
  await expect(page.getByTestId(`move-detail-${id}`).getByTestId('move-end-transfer')).toHaveCount(0);
  // The proxy page links to the active move.
  await page.goto(`/#/accounts/${acc.id}/proxies/${a.id}`);
  await expect(page.getByTestId('proxy-active-move')).toContainText('Porch 1');
  await page.goto('/#/moves');
  await page.getByTestId(`move-detail-${id}`).getByTestId('move-cancel').click();
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.getByTestId('move-copied-delete').check();
  await expect(page.getByTestId('move-copied-hint')).toContainText('Only content the move copied is deleted');
  await page.getByTestId('confirm-input').fill('cancel');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId(`move-phase-${id}`)).toHaveText(/cancelling|cancelled/);
  await expect(page.locator('body')).not.toContainText(/TARGET-PUBLIC-KEY|sha256:/);
});

test('moves page ends a transfer in copying', async ({ page }, info) => {
  const { acc, a, b } = await twoProxies(page, info, 'mw');
  const id = insertMove(acc.id, a.id, b.id, 'copying', 2);
  await page.goto('/#/moves');
  await page.getByTestId(`move-detail-${id}`).getByTestId('move-end-transfer').click();
  await expect(page.getByTestId('confirm')).toContainText('The rest of the old content stays behind and is deleted with the camera on the old proxy.');
  await page.getByTestId('confirm-input').fill('end transfer');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId(`move-phase-${id}`)).not.toHaveText('copying');
});

// The Start move form. The answers of POST /moves are stubbed (a real 202 needs online proxies that pass the whole precheck); the lists come from the real API.
async function startForm(page: import('@playwright/test').Page, info: import('@playwright/test').TestInfo, base: string) {
  const { acc, a, b } = await twoProxies(page, info, base);
  await api(page, 'POST', `/accounts/${acc.id}/cameras`, { camsId: 'porch', name: 'Porch', kind: 'camera', proxyId: a.id, proxyCameraId: 'pc1' });
  const other = await api(page, 'POST', '/accounts', { name: uniq(info, `${base}o`), displayName: 'Other' });
  await api(page, 'POST', `/accounts/${other.id}/proxies`, { name: 'far', displayName: 'Far proxy', runsOn: 'cluster' });
  await page.goto('/#/moves');
  await page.getByTestId('start-move-account').selectOption(acc.id);
  await page.getByTestId('start-move-source').selectOption(a.id);
  return { acc, a, b };
}

test('start a move from the Moves page', async ({ page }, info) => {
  let posted: any = null;
  await page.route('**/api/v1/moves', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ commandId: 'cmd_x', fixed: [{ rule: 'site_ca', proxyId: 'prx_x', site: 'home' }], report: { ok: true, reason: null, rules: [] } }) });
  });
  const { a, b } = await startForm(page, info, 'ms');
  // The camera list shows the alias and the proxy's own id next to the name.
  await expect(page.getByTestId('start-move-camera').locator('option', { hasText: 'Porch (porch, pc1' })).toHaveCount(1);
  // The target list has the account's other proxy only: not the source, not another account's.
  await expect(page.getByTestId('start-move-target').locator('option', { hasText: 'Old proxy' })).toHaveCount(0);
  await expect(page.getByTestId('start-move-target').locator('option', { hasText: 'Far proxy' })).toHaveCount(0);
  await page.getByTestId('start-move-target').selectOption(b.id);
  let reloads = 0;
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().endsWith('/api/v1/moves')) reloads++; });
  await page.getByTestId('start-move-submit').click();
  await expect(page.getByTestId('start-move-ok')).toContainText('Move requested');
  await expect(page.getByTestId('start-move-ok')).toContainText('cams-admin fixed');
  expect(posted).toEqual({
    sourceProxyId: a.id, targetProxyId: b.id, cameraId: expect.stringMatching(/^cam_/),
    bounds: { transfer: true, kinds: ['clips', 'stills', 'events', 'checks', 'archive'], space: 'fit', maxBudgetS: 86400 },
  });
  await expect.poll(() => reloads).toBeGreaterThan(0);
});

test('start a move that is refused shows the reasons', async ({ page }, info) => {
  await page.route('**/api/v1/moves', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'precheck', reason: 'target_offline', fixed: [], report: { ok: false, reason: 'target_offline', rules: [{ rule: 'online', ok: false, reason: 'target_offline', detail: 'target offline' }, { rule: 'busy', ok: true, reason: 'busy' }] } }) });
  });
  const { b } = await startForm(page, info, 'mt');
  await page.getByTestId('start-move-target').selectOption(b.id);
  await page.getByTestId('start-move-submit').click();
  await expect(page.getByTestId('start-move-error')).toHaveText('target offline');
  await expect(page.getByTestId('start-move-ok')).toHaveCount(0);
});
