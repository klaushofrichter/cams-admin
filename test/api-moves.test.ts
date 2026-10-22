// The moves API (plan Task 8): list, detail with chunk counts, cancel and
// end transfer behind typed confirms. No view field carries a token, a hash or a key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';

const dir = tmpDir();
const a = testApp(dir);
afterAll(() => a.close());

const HASH = 'sha256:' + 'ab'.repeat(32);
const KEY = 'TARGET-PUBLIC-KEY-MATERIAL';
let n = 0;
// Two proxies, a camera on the first and a move between them in `phase`.
function fixture(acc: string, phase: string) {
  const i = n++;
  const s = `prx_s${i}`, t = `prx_t${i}`, cam = `cam_${i}`, mv = `mv_${String(i).padStart(20, '0')}`;
  a.db.exec(`INSERT INTO proxies (id,account_id,name,display_name,runs_on,state,created_at,updated_at) VALUES
    ('${s}','${acc}','src${i}','Source ${i}','cluster','enrolled',1,1),('${t}','${acc}','tgt${i}','Target ${i}','cluster','enrolled',1,1);
    INSERT INTO cameras (id,account_id,proxy_id,cams_id,proxy_camera_id,name,kind,host,created_at,updated_at) VALUES ('${cam}','${acc}','${s}','porch${i}','pc${i}','Porch ${i}','camera','192.0.2.${i + 1}',1,1);`);
  a.db.prepare(`INSERT INTO moves (id,account_id,camera_id,source_proxy_id,target_proxy_id,request_id,phase,reason,plan,token_hash,target_ip,target_public_key,leaf_fingerprint,bytes_total,bytes_done,rate_bps,eta_s,budget_exceeded_at,created_at,updated_at,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(mv, acc, cam, s, t, `rq_${i}`, phase, null, JSON.stringify({ transfer: true, kinds: ['clips'], space: 'all', budgetS: 60 }), HASH, '192.0.2.77', KEY, 'SHA256:AAAA', 1000, 400, 50, 12, null, 100 + i, 100 + i);
  return { mv, s, t, cam };
}
const chunk = (mv: string, id: string, st: string) => a.db.prepare('INSERT INTO move_chunks (move_id,chunk_id,state) VALUES (?,?,?)').run(mv, id, st);

let acc: string;
let other: string;
beforeAll(() => {
  acc = (a.registry.createAccount('admin@example.com', { name: 'home', displayName: 'Home' }) as { id: string }).id;
  other = (a.registry.createAccount('admin@example.com', { name: 'away', displayName: 'Away' }) as { id: string }).id;
});

describe('moves API', () => {
  it('lists moves of an account', async () => {
    const m1 = fixture(acc, 'copying');
    fixture(other, 'approved');
    const r = await a.api('get', `/moves?accountId=${acc}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toEqual({
      id: m1.mv, accountId: acc, camsId: expect.stringMatching(/^porch/), cameraName: expect.stringMatching(/^Porch/), source: { id: m1.s, name: expect.stringMatching(/^src/) }, target: { id: m1.t, name: expect.stringMatching(/^tgt/) },
      phase: 'copying', reason: null, plan: { transfer: true, kinds: ['clips'], space: 'all', budgetS: 60 }, bytesTotal: 1000, bytesDone: 400, rateBps: 50, etaS: 12, budgetExceeded: false,
      cleanupPending: false, createdAt: expect.any(Number), updatedAt: expect.any(Number), endedAt: null,
    });
    expect((await a.api('get', '/moves')).body.items.length).toBeGreaterThanOrEqual(2);
    expect((await a.api('get', '/moves?accountId=acc_nope')).status).toBe(404);
  });

  it('detail includes chunk counts per state', async () => {
    const m = fixture(acc, 'cleaning');
    chunk(m.mv, 'c1', 'verified'); chunk(m.mv, 'c2', 'verified'); chunk(m.mv, 'c3', 'failed'); chunk(m.mv, 'c4', 'abandoned'); chunk(m.mv, 'c5', 'pending');
    const r = await a.api('get', `/moves/${m.mv}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: m.mv, phase: 'cleaning', chunks: { pending: 1, copied: 0, verified: 2, skipped: 0, failed: 1, abandoned: 1 } });
    expect((await a.api('get', '/moves/mv_NOPE')).status).toBe(404);
  });

  it('cancel needs the typed confirm', async () => {
    const m = fixture(acc, 'approved');
    expect((await a.api('post', `/moves/${m.mv}/cancel`, { copied: 'delete' })).body).toEqual({ error: 'confirm_mismatch', field: 'confirm' });
    expect((await a.api('post', `/moves/${m.mv}/cancel`, { copied: 'delete', confirm: 'yes' })).status).toBe(400);
    expect((await a.api('post', `/moves/${m.mv}/cancel`, { copied: 'x', confirm: 'cancel' })).status).toBe(400);
    expect(a.moves.store.get(m.mv)!.phase).toBe('approved');
    const ok = await a.api('post', `/moves/${m.mv}/cancel`, { copied: 'age-out', confirm: 'cancel' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ id: m.mv, phase: 'cancelled' });
    expect((await a.api('post', `/moves/${m.mv}/cancel`, { copied: 'age-out', confirm: 'cancel' })).status).toBe(409);
    expect((await a.api('post', '/moves/mv_NOPE/cancel', { copied: 'delete', confirm: 'cancel' })).status).toBe(404);
  });

  it('end transfer only in copying (409 otherwise)', async () => {
    const bad = fixture(acc, 'approved');
    expect((await a.api('post', `/moves/${bad.mv}/end-transfer`, { confirm: 'end transfer' })).status).toBe(409);
    const m = fixture(acc, 'copying');
    chunk(m.mv, 'c1', 'pending');
    expect((await a.api('post', `/moves/${m.mv}/end-transfer`, {})).body).toEqual({ error: 'confirm_mismatch', field: 'confirm' });
    expect(a.moves.store.get(m.mv)!.phase).toBe('copying');
    const ok = await a.api('post', `/moves/${m.mv}/end-transfer`, { confirm: 'end transfer' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ phase: 'cleaning' });
    expect((await a.api('get', `/moves/${m.mv}`)).body.chunks.abandoned).toBe(1);
  });

  it('no move view field contains token, hash or publicKey', async () => {
    const m = fixture(acc, 'copying');
    const texts = [(await a.api('get', '/moves')).text, (await a.api('get', `/moves/${m.mv}`)).text];
    for (const t of texts) {
      expect(t).not.toMatch(/token|hash|publicKey|public_key|sha256:|Fingerprint|leaf/i);
      expect(t).not.toContain(KEY);
      expect(t).not.toContain('192.0.2.77');
    }
  });

  it('requires a sysadmin session and CSRF', async () => {
    const m = fixture(acc, 'copying');
    const request = (await import('supertest')).default;
    expect((await request(a.app).get('/api/v1/moves')).status).toBe(401);
    const noCsrf = await request(a.app).post(`/api/v1/moves/${m.mv}/end-transfer`).set('Cookie', a.cookie).send({ confirm: 'end transfer' });
    expect(noCsrf.status).toBeGreaterThanOrEqual(400);
    expect(a.moves.store.get(m.mv)!.phase).toBe('copying');
  });
});
