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
