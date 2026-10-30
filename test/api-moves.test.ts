// The moves API (plan Task 8): list, detail with chunk counts, cancel and
// end transfer behind typed confirms. No view field carries a token, a hash or a key.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { testApp } from './helpers/app';
import { makeProxyInfo, makeSummary } from '../test-client/summaries';
import { moveContent } from '../server/moves/view';

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
      id: m1.mv, requestId: expect.stringMatching(/^rq_/), accountId: acc, camsId: expect.stringMatching(/^porch/), cameraName: expect.stringMatching(/^Porch/), source: { id: m1.s, name: expect.stringMatching(/^Source /) }, target: { id: m1.t, name: expect.stringMatching(/^Target /) },
      phase: 'copying', reason: null, refusedBy: null, detail: null, plan: { transfer: true, kinds: ['clips'], space: 'all', budgetS: 60 }, bytesTotal: 1000, bytesDone: 400, rateBps: 50, etaS: 12, budgetExceeded: false,
      cleanupPending: false, targetCleanupPending: false, autoApprove: false, bounds: null, createdAt: expect.any(Number), updatedAt: expect.any(Number), endedAt: null,
      returnOf: null, returnId: null, check: null, archivePending: false, endRequested: false, keepDays: null, space: null,
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

  it('detail lists the content kinds: included by the plan, the summary sizes, chunk progress per kind', async () => {
    const m = fixture(acc, 'copying');
    const summary = { clips: { files: 12, bytes: 3000, rows: 12, oldest: 1, newest: 2 }, stills: { files: 5, bytes: 500, rows: 5, oldest: 1, newest: 2 }, events: { files: 0, bytes: 0, rows: 4, oldest: null, newest: null } };
    a.db.prepare('UPDATE moves SET summary = ? WHERE id = ?').run(JSON.stringify(summary), m.mv);
    chunk(m.mv, 'clips:2026-10-20', 'verified'); chunk(m.mv, 'clips:2026-10-21', 'pending'); chunk(m.mv, 'clips:2026-10-22', 'failed');
    const r = await a.api('get', `/moves/${m.mv}`);
    expect(r.body.content.basis).toBe('plan');
    const k = Object.fromEntries(r.body.content.kinds.map((x: { kind: string }) => [x.kind, x]));
    expect(r.body.content.kinds.map((x: { kind: string }) => x.kind)).toEqual(['clips', 'stills', 'events', 'checks', 'archive']);
    expect(k.clips).toEqual({ kind: 'clips', included: true, files: 12, bytes: 3000, rows: 12, chunks: { total: 3, done: 1, failed: 1, abandoned: 0 } });
    expect(k.stills).toEqual({ kind: 'stills', included: false, files: 5, bytes: 500, rows: 5, chunks: { total: 0, done: 0, failed: 0, abandoned: 0 } });
    expect(k.checks).toMatchObject({ included: false, files: null, bytes: null, rows: null });
    expect(k.events).toMatchObject({ files: 0, bytes: 0, rows: 4 });
  });

  it('moveContent: the bounds decide before a plan exists, the offer\'s per-kind space over the summary; nothing decided is null', () => {
    const summary = { clips: { files: 2, bytes: 100 }, archive: { files: 1, bytes: 9 } };
    const byBounds = moveContent({ plan: null, bounds: { transfer: true, kinds: ['clips'], space: 'fit', maxBudgetS: 60 }, summary }, [], { clips: 80 });
    expect(byBounds.basis).toBe('bounds');
    expect(byBounds.kinds.find((k) => k.kind === 'clips')).toMatchObject({ included: true, bytes: 80, files: 2 });
    expect(byBounds.kinds.find((k) => k.kind === 'archive')).toMatchObject({ included: false, bytes: 9 });
    const none = moveContent({ plan: null, bounds: null, summary }, []);
    expect(none.basis).toBeNull();
    expect(none.kinds.every((k) => k.included === null)).toBe(true);
    const noTransfer = moveContent({ plan: { transfer: false, kinds: ['clips'] }, bounds: null, summary }, []);
    expect(noTransfer.kinds.every((k) => k.included === false)).toBe(true);
  });

  it('the content lists PTZ positions when the plan names ptz, also without transfer', () => {
    const summary = { clips: { files: 2, bytes: 20, rows: 2 } };
    const chunks = [{ id: 'ptz:2026-10-30', state: 'verified' }, { id: 'clips:2026-10-30', state: 'pending' }] as any;
    const c = moveContent({ plan: { transfer: true, kinds: ['clips', 'ptz'] }, bounds: null, summary }, chunks);
    expect(c.kinds.map((x) => x.kind)).toEqual(['clips', 'stills', 'events', 'checks', 'archive', 'ptz']);
    expect(c.kinds.at(-1)).toEqual({ kind: 'ptz', included: true, files: null, bytes: null, rows: null, chunks: { total: 1, done: 1, failed: 0, abandoned: 0 } });
    const only = moveContent({ plan: { transfer: false, kinds: ['ptz'] }, bounds: null, summary }, []);
    expect(only.kinds.find((x) => x.kind === 'ptz')!.included).toBe(true);
    expect(only.kinds.filter((x) => x.kind !== 'ptz').every((x) => x.included === false)).toBe(true);
  });
  it('no ptz row otherwise', () => {
    const summary = { clips: { files: 2, bytes: 20, rows: 2 }, ptz: { files: 1, bytes: 1, rows: 1 } };
    for (const m of [{ plan: { transfer: true, kinds: ['clips'] }, bounds: null, summary }, { plan: null, bounds: { transfer: true, kinds: ['clips', 'ptz'], space: 'all', maxBudgetS: 3600 } as any, summary }, { plan: null, bounds: null, summary }]) {
      expect(moveContent(m, []).kinds.map((x) => x.kind)).toEqual(['clips', 'stills', 'events', 'checks', 'archive']);
    }
  });

  it('moveContent: events and checks are database rows, not files: the rows count comes through', () => {
    const summary = { stills: { files: 54556, bytes: 48350227367, rows: 0 }, clips: { files: 236, bytes: 290655300, rows: 142 }, events: { files: 0, bytes: 0, rows: 654 }, checks: { files: 0, bytes: 0, rows: 3 } };
    const c = moveContent({ plan: { transfer: true, kinds: ['clips', 'stills', 'events', 'checks'] }, bounds: null, summary }, []);
    const k = Object.fromEntries(c.kinds.map((x) => [x.kind, x]));
    expect(k.events).toMatchObject({ included: true, files: 0, bytes: 0, rows: 654 });
    expect(k.checks).toMatchObject({ included: true, rows: 3 });
    expect(k.stills).toMatchObject({ files: 54556, bytes: 48350227367, rows: 0 });
    expect(k.clips).toMatchObject({ files: 236, bytes: 290655300, rows: 142 });
    expect(k.archive).toMatchObject({ files: null, bytes: null, rows: null });
  });

  it('delete: only a rejected move (409 otherwise); its chunk rows go, the audit stays; a move-delete record; a live event', async () => {
    const live = fixture(acc, 'copying');
    expect((await a.api('delete', `/moves/${live.mv}`)).body).toEqual({ error: 'not_rejected' });
    expect((await a.api('delete', `/moves/${live.mv}`)).status).toBe(409);
    expect((await a.api('delete', '/moves/mv_NOPE')).status).toBe(404);
    const m = fixture(acc, 'rejected');
    a.db.prepare(`UPDATE moves SET ended_at = 200, reason = 'incompatible', detail = 'the target needs https' WHERE id = ?`).run(m.mv);
    chunk(m.mv, 'clips:2026-10-20', 'pending');
    a.audit.write({ actorType: 'system', actor: 'system', action: 'move-offer', accountId: acc, outcome: 'refused', detail: { moveId: m.mv } });
    const events: string[] = [];
    const orig = a.live.publishRegistry.bind(a.live);
    a.live.publishRegistry = (type: string, id: string) => { if (type === 'move') events.push(id); orig(type, id); };
    try {
      const r = await a.api('delete', `/moves/${m.mv}`);
      expect(r.status).toBe(204);
    } finally {
      a.live.publishRegistry = orig;
    }
    expect(events).toEqual([m.mv]);
    expect(a.moves.store.get(m.mv)).toBeNull();
    expect(a.db.prepare('SELECT count(*) n FROM move_chunks WHERE move_id = ?').get(m.mv)).toEqual({ n: 0 });
    expect((await a.api('get', `/moves/${m.mv}`)).status).toBe(404);
    const rows = a.db.prepare(`SELECT action, actor_type, actor, outcome, target_id, detail FROM audit_log WHERE json_extract(detail, '$.moveId') = ? ORDER BY rowid`).all(m.mv) as { action: string; detail: string }[];
    expect(rows.map((x) => x.action)).toEqual(['move-offer', 'move-delete']);
    expect(rows[1]).toMatchObject({ actor_type: 'sysadmin', actor: 'admin@example.com', outcome: 'ok', target_id: m.cam });
    expect(JSON.parse(rows[1].detail)).toEqual({ moveId: m.mv, camsId: expect.stringMatching(/^porch/), reason: 'incompatible', source: m.s, target: m.t });
    expect((await a.api('delete', `/moves/${m.mv}`)).status).toBe(404);
  });

  it('delete with an operations token needs the moves scope', async () => {
    const m = fixture(acc, 'rejected');
    a.db.prepare('UPDATE moves SET ended_at = 200 WHERE id = ?').run(m.mv);
    const del = (tok: string) => request(a.app).delete(`/api/v1/moves/${m.mv}`).set('Authorization', `Bearer ${tok}`);
    const routes = (await a.api('post', '/ops-tokens', { name: 'routes', scopes: ['routes'], days: 1 })).body.token as string;
    expect((await del(routes)).status).toBe(403);
    const moves = (await a.api('post', '/ops-tokens', { name: 'moves', scopes: ['moves'], days: 1 })).body.token as string;
    expect((await del(moves)).status).toBe(204);
    expect(a.moves.store.get(m.mv)).toBeNull();
    const au = a.db.prepare(`SELECT actor_type, actor FROM audit_log WHERE action = 'move-delete' AND json_extract(detail, '$.moveId') = ?`).get(m.mv) as { actor_type: string; actor: string };
    expect(au.actor_type).toBe('sysadmin');
    expect(au.actor).toMatch(/^ops-token:[0-9a-f]{8}$/);
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

  it('give up: sysadmin only, typed, only while returning; closes the return and finishes both sides, deletes nothing', async () => {
    const copying = fixture(acc, 'copying');
    expect((await a.api('post', `/moves/${copying.mv}/give-up`, { confirm: 'give up' })).status).toBe(409);
    const m = fixture(acc, 'returning');
    expect((await a.api('post', `/moves/${m.mv}/give-up`, {})).body).toEqual({ error: 'confirm_mismatch', field: 'confirm' });
    expect((await a.api('post', `/moves/${m.mv}/give-up`, { confirm: 'cancel' })).status).toBe(400);
    expect((await a.api('post', '/moves/mv_NOPE/give-up', { confirm: 'give up' })).status).toBe(404);
    // An operations token (even one with the moves scope) is refused; the move is untouched.
    const tok = (await a.api('post', '/ops-tokens', { name: 'giveup', scopes: ['moves'], days: 1 })).body.token as string;
    const viaToken = await request(a.app).post(`/api/v1/moves/${m.mv}/give-up`).set('Authorization', `Bearer ${tok}`).set('Content-Type', 'application/json').send({ confirm: 'give up' });
    expect(viaToken.status).toBe(403);
    expect(a.moves.store.get(m.mv)!.phase).toBe('returning');
    const ok = await a.api('post', `/moves/${m.mv}/give-up`, { confirm: 'give up' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ id: m.mv, phase: 'returned', reason: 'given_up' });
    const au = a.db.prepare(`SELECT actor_type, actor, outcome FROM audit_log WHERE action = 'move-give-up'`).all();
    expect(au).toEqual([{ actor_type: 'sysadmin', actor: 'admin@example.com', outcome: 'ok' }]);
    expect((await a.api('post', `/moves/${m.mv}/give-up`, { confirm: 'give up' })).status).toBe(409);
  });

  it('the view links a cancelled move and its copy back, and shows the check and the waiting End', async () => {
    const m = fixture(acc, 'cancelled');
    const r = fixture(acc, 'returning');
    const check = { complete: false, missing: { stills: 2 }, recovered: {}, failed: { archive: 1 }, expired: { clips: 3 } };
    a.db.prepare('UPDATE moves SET return_of = ? WHERE id = ?').run(m.mv, r.mv);
    a.db.prepare('UPDATE moves SET check_result = ?, keep_days = 14, end_requested = ? WHERE id = ?').run(JSON.stringify(check), JSON.stringify({ at: 5, actorType: 'sysadmin', actor: 'admin@example.com' }), m.mv);
    const orig = (await a.api('get', `/moves/${m.mv}`)).body;
    expect(orig).toMatchObject({ returnId: r.mv, returnOf: null, check, keepDays: 14, endRequested: true, archivePending: false });
    expect((await a.api('get', `/moves/${r.mv}`)).body).toMatchObject({ returnOf: m.mv, returnId: null, check: null, endRequested: false, keepDays: null });
    expect(JSON.stringify(orig)).not.toContain('admin@example.com');
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

  it('deleting a camera, proxy or account: refused 409 move_active while a move is active, removes ended moves', async () => {
    const act = fixture(acc, 'copying');
    expect(await a.api('delete', `/accounts/${acc}/cameras/${act.cam}`)).toMatchObject({ status: 409, body: { error: 'move_active' } });
    expect(await a.api('delete', `/accounts/${acc}/proxies/${act.t}`)).toMatchObject({ status: 409, body: { error: 'move_active' } });
    expect(await a.api('delete', `/accounts/${acc}/proxies/${act.s}`)).toMatchObject({ status: 409, body: { error: 'move_active' } });
    expect((await a.api('delete', `/accounts/${acc}`, { confirmName: 'home' })).body).toEqual({ error: 'move_active' });
    const gone = fixture(acc, 'done');
    a.db.prepare('UPDATE moves SET ended_at = 5 WHERE id = ?').run(gone.mv);
    chunk(gone.mv, 'c1', 'verified');
    expect((await a.api('delete', `/accounts/${acc}/cameras/${gone.cam}`)).status).toBe(204);
    expect(a.moves.store.get(gone.mv)).toBeNull();
    const p = fixture(acc, 'failed');
    a.db.prepare('UPDATE moves SET ended_at = 5 WHERE id = ?').run(p.mv);
    expect((await a.api('delete', `/accounts/${acc}/proxies/${p.t}`)).status).toBe(204);
    expect(a.moves.store.get(p.mv)).toBeNull();
    // The account: its other (ended) moves go with it once the active one ended.
    a.db.prepare('UPDATE moves SET ended_at = 5 WHERE id = ?').run(act.mv);
    const e = fixture(other, 'cancelled');
    a.db.prepare('UPDATE moves SET ended_at = 5 WHERE id = ?').run(e.mv);
    a.db.prepare(`UPDATE moves SET ended_at = 5 WHERE account_id = ?`).run(other);
    expect((await a.api('delete', `/accounts/${other}`, { confirmName: 'away' })).status).toBe(204);
    expect(a.moves.store.get(e.mv)).toBeNull();
  });

  it('source and target show the proxy display name', async () => {
    const m = fixture(acc, 'approved');
    const r = await a.api('get', `/moves/${m.mv}`);
    expect(r.body.source.name).toMatch(/^Source /);
    a.db.prepare(`UPDATE proxies SET display_name = '' WHERE id = ?`).run(m.t);
    expect((await a.api('get', `/moves/${m.mv}`)).body.target.name).toMatch(/^tgt/);
  });
  // POST /moves (move.begin plan Task 4). Two online proxies of a fresh account that allow moves, a camera on the source, one cams instance seeing both.
  const SITE_FP = 'SHA256:' + 'CD'.repeat(32);
  const BOUNDS = { transfer: true, kinds: ['clips', 'stills'], space: 'fit', maxBudgetS: 3600 };
  function beginFixture(tag: string, online = true) {
    const acct = (a.registry.createAccount('admin@example.com', { name: `bg${tag}`, displayName: 'B' }) as { id: string }).id;
    const px = (name: string, allow: string[], live = true) => {
      const p = a.registry.createProxy('admin@example.com', acct, { name, displayName: name, runsOn: 'local-host' }).id;
      a.db.prepare(`UPDATE proxies SET state = 'enrolled' WHERE id = ?`).run(p);
      const cur = a.registry.getProxy(acct, p);
      a.registry.updateProxy('admin@example.com', acct, p, { url: 'http://192.0.2.9:8480', tlsSite: `site-${tag}`, tlsServername: `${name}.internal`, caFingerprints: [SITE_FP], version: cur.version });
      a.db.prepare(`INSERT INTO proxy_keys (id, proxy_id, public_key, fingerprint, created_at, confirmed_at) VALUES (?, ?, ?, ?, 1, 1)`).run(`key_${String(n++).padStart(20, '0')}`, p, `pk${p}`, `fp${p}`);
      if (live) {
        a.status.hello(p, 'v2', Date.now(), ['status', 'commands']);
        a.status.heartbeat(p, { summary: makeSummary({ cameras: 1, now: Date.now() }), proxy: { ...makeProxyInfo({ now: Date.now(), site: `site-${tag}`, caFingerprint: [SITE_FP] }), commands: { enabled: true, paused: false, pauseReason: null, allow, seenWindow: 1000 } }, truncated: false }, Date.now());
      }
      return p;
    };
    const s = px(`s${tag}`, ['move.send', 'move.receive']);
    const t = px(`t${tag}`, ['move.send', 'move.receive'], online);
    a.registry.createCamera('admin@example.com', acct, { camsId: `porch${tag}`, name: 'Porch', kind: 'camera', proxyId: s, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
    const inst = a.camsInstances.create('admin@example.com', { name: `ci${tag}`, displayName: 'C', accounts: [acct] }).id;
    for (const p of [s, t]) a.camsInstances.setRoute('admin@example.com', inst, p, { url: null, hidden: false });
    return { acct, s, t, body: { sourceProxyId: s, targetProxyId: t, cameraId: `porch${tag}`, bounds: BOUNDS } };
  }
  const commandCount = () => (a.db.prepare(`SELECT count(*) n FROM commands WHERE command = 'move.begin'`).get() as { n: number }).n;

  it('POST /moves with a session answers 202 with commandId, fixed and report', async () => {
    const f = beginFixture('a');
    const r = await a.api('post', '/moves', f.body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ commandId: expect.any(String), fixed: [], report: { ok: true } });
    expect(commandCount()).toBe(1);
  });

  it('POST /moves answers 409 precheck with the report', async () => {
    const f = beginFixture('b', false);
    const r = await a.api('post', '/moves', f.body);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'precheck', reason: 'target_offline' });
    expect(r.body.report.rules.find((x: { rule: string }) => x.rule === 'target_online')).toMatchObject({ ok: false });
  });

  it('POST /moves with a bad body is 400 with the field', async () => {
    const f = beginFixture('c');
    const { targetProxyId: _t, ...rest } = f.body;
    expect(await a.api('post', '/moves', rest)).toMatchObject({ status: 400, body: { error: 'invalid', field: 'targetProxyId' } });
  });

  it('a session POST /moves without X-Cams-Admin is 403 csrf', async () => {
    const f = beginFixture('d');
    const r = await request(a.app).post('/api/v1/moves').set('Cookie', a.cookie).set('Content-Type', 'application/json').send(JSON.stringify(f.body));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'csrf' });
  });
});
