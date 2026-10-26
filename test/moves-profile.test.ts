// The proxy profile in a camera move (proxy profile design §3): the precheck
// rules capacity and ftp_ports on the target's reported profile (skipped when it
// reports none), the "Move to…" list, and the space figures kept at request time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { fakeClock, type FakeClock } from './helpers/clock';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeProfile, makeProxyInfo } from '../test-client/summaries';
import type { ProxyClient } from '../test-client/client';
import { precheckReport } from '../server/moves/precheck';
import { moveView } from '../server/moves/view';

const ACTOR = 'admin@example.com';
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../contract/v1/fixtures', name), 'utf8')).message.body as Record<string, any>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rq = () => 'rq_' + Array.from({ length: 20 }, () => CROCK[randomInt(32)]).join('');
const FP = 'SHA256:' + 'CD'.repeat(32);
const NEED = 4 * 52428800; // the fixture request's summary

const dir = tmpDir();
let s: Running;
let clock: FakeClock;
const clients: ProxyClient[] = [];
let n = 0;
let ip = 60;

beforeEach(async () => {
  resetAccounts();
  clock = fakeClock(Date.now());
  s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '10000', LIMIT_HELLO_PER_PROXY: '1000', TICK_MS: '60000' }, 0, clock);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop('shutdown');
  await s.stop();
});

interface Px { proxyId: string; accountId: string; client: ProxyClient; name: string }
async function proxy(profile?: () => unknown): Promise<Px> {
  const name = `pf${n++}`;
  const p = await enrolled(s, name, 'home');
  const site = `site-${name}`;
  const client = makeClient(p.key, { commands: { allow: ['move.send', 'move.receive'] }, proxyInfo: () => makeProxyInfo({ now: Date.now(), site, caFingerprint: [FP] }), ...(profile ? { profile } : {}) });
  clients.push(client);
  client.start();
  await until(() => client.state === 'connected' && !!s.built.status.row(p.proxyId)?.reported?.commands && (!profile || !!s.built.status.row(p.proxyId)?.reported?.profile), 5000, 'connected');
  const cur = s.built.registry.getProxy(p.accountId, p.proxyId);
  s.built.registry.updateProxy(ACTOR, p.accountId, p.proxyId, { url: `http://192.0.2.${ip++}:8480`, tlsSite: site, tlsServername: `${name}.${site}.internal`, caFingerprints: [FP], version: cur.version });
  return { ...p, client, name };
}
function camera(src: Px) {
  return s.built.registry.createCamera(ACTOR, src.accountId, { camsId: `c${n++}`, name: 'Porch', kind: 'camera', proxyId: src.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
}
function request(src: Px, target: string) {
  const { proxyId: _p, connId: _c, bounds: _b, ...rest } = fx('valid-event-move-request.json');
  const requestId = rq();
  src.client.emitEvent({ ...rest, requestId, target, camera: { ...rest.camera, proxyCameraId: 'cam1' } });
  return requestId;
}
const answerOf = async (src: Px, requestId: string) => {
  const got = () => src.client.receivedCommands.filter((m) => m.body.command === 'move.answer' && m.body.args.requestId === requestId);
  await until(() => got().length > 0, 5000, 'answer');
  return got()[0].body.args as Record<string, any>;
};
const report = (src: Px, tgt: Px, cameraId: string) => precheckReport({ db: s.built.db, registry: s.built.registry, status: s.built.status, store: s.built.moves.store }, { accountId: src.accountId, sourceProxyId: src.proxyId, targetProxyId: tgt.proxyId, cameraId });

describe('camera moves and the proxy profile', () => {
  it('a full target: refused camera_limit before any offer, with the detail; not in the Move to… list', async () => {
    const src = await proxy();
    const tgt = await proxy(() => makeProfile({ cameras: 3, held: 3, passive: { from: 30000, to: 30039 } }));
    const cam = camera(src);
    const r = report(src, tgt, cam.id);
    expect(r).toMatchObject({ ok: false, reason: 'camera_limit' });
    expect(r.rules.map((x) => x.rule)).toEqual(['different_proxies', 'same_account', 'target_online', 'target_receives', 'capacity', 'ftp_ports', 'not_busy', 'site_ca', 'ca_covers_camera', 'routed', 'no_host_override']);
    expect(r.rules.find((x) => x.rule === 'capacity')).toEqual({ rule: 'capacity', ok: false, reason: 'camera_limit', detail: `${tgt.name} holds 3 of 3 cameras` });
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId).map((t) => t.proxyId)).not.toContain(tgt.proxyId);
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'camera_limit', detail: `${tgt.name} holds 3 of 3 cameras` });
    const m = s.built.moves.store.list().find((x) => x.requestId === requestId)!;
    expect(moveView(s.built.db, m)).toMatchObject({ phase: 'rejected', refusedBy: 'cams-admin', reason: 'camera_limit' });
    expect(tgt.client.receivedCommands.some((c) => c.body.command === 'move.offer')).toBe(false);
  });

  it("the target's site CA does not cover the camera's address: refused ca_does_not_cover_camera before any offer, with the detail", async () => {
    const src = await proxy();
    const tgt = await proxy(() => makeProfile({ tls: { site: 'home', cameraSubnet: '192.0.2.80/28' } }));
    const cam = camera(src); // 192.0.2.10
    const r = report(src, tgt, cam.id);
    expect(r).toMatchObject({ ok: false, reason: 'ca_does_not_cover_camera' });
    expect(r.rules.find((x) => !x.ok)).toEqual({ rule: 'ca_covers_camera', ok: false, reason: 'ca_does_not_cover_camera', detail: `${tgt.name}'s site CA covers 192.0.2.80/28, not 192.0.2.10` });
    const requestId = request(src, tgt.proxyId);
    const a = await answerOf(src, requestId);
    expect(a).toMatchObject({ accept: false, reason: 'ca_does_not_cover_camera', detail: `${tgt.name}'s site CA covers 192.0.2.80/28, not 192.0.2.10` });
    expect(tgt.client.receivedCommands.some((c) => c.body.command === 'move.offer')).toBe(false);
    // Covered, or not reported: the rule passes.
    const ok = await proxy(() => makeProfile({ tls: { site: 'home', cameraSubnet: '192.0.2.0/28' } }));
    expect(report(src, ok, cam.id).rules.find((x) => x.rule === 'ca_covers_camera')).toMatchObject({ ok: true });
    const none = await proxy(() => makeProfile());
    expect(report(src, none, cam.id).rules.find((x) => x.rule === 'ca_covers_camera')).toMatchObject({ ok: true, detail: `${none.name} reports no camera subnet for its site CA` });
  });

  it('too few FTP passive ports on the target: refused by ftp_ports', async () => {
    const src = await proxy();
    const tgt = await proxy(() => makeProfile({ cameras: 3, held: 1, passive: { from: 30000, to: 30009 } }));
    const cam = camera(src);
    expect(report(src, tgt, cam.id).rules.find((x) => !x.ok)).toEqual({ rule: 'ftp_ports', ok: false, reason: 'camera_limit', detail: `${tgt.name}'s FTP passive range 30000-30009 has 10 ports; 2 cameras need 20` });
  });

  it('a target with room: the move keeps the space figures of the request; without a profile both rules pass and no figures', async () => {
    const src = await proxy();
    const tgt = await proxy(() => makeProfile({ cameras: 3, held: 1, budgetBytes: 100_000_000, usedBytes: 40_000_000 }));
    camera(src);
    expect(s.built.moves.eligibleTargets(src.accountId, src.proxyId).map((t) => t.proxyId)).toContain(tgt.proxyId);
    // A stored settings view that is not JSON: no caps, never a throw.
    s.built.db.prepare(`INSERT INTO proxy_config (proxy_id, revision, view, cmd_id, fetched_at) VALUES (?, ?, '{not json', 'cmd_x', 1)`).run(tgt.proxyId, 'sha256:' + 'a'.repeat(64));
    const requestId = request(src, tgt.proxyId);
    await until(() => s.built.moves.store.list().some((x) => x.requestId === requestId), 5000, 'move row');
    const m = s.built.moves.store.list().find((x) => x.requestId === requestId)!;
    expect(m.phase).not.toBe('rejected');
    expect(m.space).toEqual({ at: clock.now(), needBytes: NEED, budgetBytes: 100_000_000, usedBytes: 40_000_000, leftBytes: 60_000_000, fits: false, overCaps: [] });
    expect(moveView(s.built.db, m).space).toEqual(m.space);

    const old = await proxy();
    const src2 = await proxy();
    const cam2 = camera(src2);
    const r = report(src2, old, cam2.id);
    expect(r.rules.filter((x) => x.rule === 'capacity' || x.rule === 'ftp_ports')).toEqual([
      { rule: 'capacity', ok: true, reason: 'camera_limit', detail: `${old.name} reports no profile` },
      { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: `${old.name} reports no profile` },
    ]);
  });
});
