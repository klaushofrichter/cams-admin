// A camera registered without a model (cam1, registered before proxies reported
// one) takes the model its proxy reports in a heartbeat. Only an empty model is
// filled: an existing one is never overwritten, and a filled one costs no more
// writes on later heartbeats.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import type { ProxyClient } from '../test-client/client';
import { ACTOR } from './helpers/registry';
import { tmpDir } from './helpers/tmp';
import { readEpoch } from '../server/db/open';

describe('camera model from the proxy report', () => {
  const dir = tmpDir();
  let s: Running;
  let client: ProxyClient | null = null;
  beforeEach(async () => {
    resetAccounts();
    s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0' });
  });
  afterEach(async () => {
    await client?.stop('shutdown');
    client = null;
    await s.stop();
  });

  it('fills an empty model once, keeps a set one, and adds no writes afterwards', async () => {
    const p = await enrolled(s, 'pi', 'home');
    const reg = s.built.registry;
    // makeSummary reports cam1 and cam2, both as model RLC-1224A.
    const empty = reg.createCamera(ACTOR, p.accountId, { camsId: 'backyard-left', name: 'Backyard Left', kind: 'camera', proxyId: p.proxyId, proxyCameraId: 'cam1', host: '192.0.2.10', protocol: 'https' });
    const set = reg.createCamera(ACTOR, p.accountId, { camsId: 'garage', name: 'Garage', kind: 'camera', model: 'CX820', proxyId: p.proxyId, proxyCameraId: 'cam2', host: '192.0.2.11', protocol: 'https' });
    expect(empty.model).toBeNull();

    client = makeClient(p.key);
    client.start();
    await until(() => reg.getCamera(p.accountId, empty.id).model === 'RLC-1224A', 5000, 'model filled');
    expect(reg.getCamera(p.accountId, set.id).model).toBe('CX820');

    const rows = s.built.db.prepare(`SELECT actor_type, action, target_id, detail FROM audit_log WHERE action = 'camera-update' AND target_id = ?`).all(empty.id) as { actor_type: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe('proxy');
    expect(JSON.parse(rows[0].detail)).toMatchObject({ fields: ['model'], model: 'RLC-1224A', from: 'proxy-report' });

    // Later heartbeats find nothing to fill: no write (after the connection's own first records settle).
    const heartbeats = async (n: number) => {
      let beats = 0;
      let last = s.built.status.row(p.proxyId)?.lastHeartbeatAt;
      await until(() => {
        const t = s.built.status.row(p.proxyId)?.lastHeartbeatAt;
        if (t !== last) { beats++; last = t; }
        return beats >= n;
      }, 5000, 'heartbeats');
    };
    await heartbeats(5);
    const epoch = readEpoch(s.built.db);
    await heartbeats(5);
    expect(readEpoch(s.built.db)).toBe(epoch);
    expect(reg.getCamera(p.accountId, empty.id).version).toBe(empty.version + 1);
  });
});
