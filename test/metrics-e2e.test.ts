// Heartbeat and metric correctness, end to end (spec §15.4, Klaus's
// emphasis): every field of the health summary the proxy sends arrives, is
// stored, is answered by the API and is in what the proxy page renders; the
// derived values are right; a silent proxy ages out; skew and restarts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';
import { enrolled, makeClient, resetAccounts, startServer, until, type Running } from './helpers/server';
import { makeSummary } from '../test-client/summaries';
import { summaryLeaves } from '../web/src/lib/summaryTree';

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; const?: unknown; enum?: unknown[] };
const STRICT = JSON.parse(readFileSync(join(__dirname, '../contract/v1/strict/health-summary.schema.json'), 'utf8')) as Schema;

// Every leaf path of the strict schema (arrays as index 0), with its schema.
function schemaLeaves(s: Schema, path: (string | number)[] = []): { path: (string | number)[]; s: Schema }[] {
  const nonNull = s.anyOf?.filter((x) => x.type !== 'null');
  if (nonNull && nonNull.length === 1) return schemaLeaves(nonNull[0], path);
  if (s.properties) return Object.entries(s.properties).flatMap(([k, v]) => schemaLeaves(v, [...path, k]));
  if (s.type === 'array' && s.items) return schemaLeaves(s.items, [...path, 0]);
  return [{ path, s }];
}
const get = (o: any, p: (string | number)[]) => p.reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o: any, p: (string | number)[], v: unknown) {
  let x = o;
  for (let i = 0; i < p.length - 1; i++) {
    if (x[p[i]] == null) x[p[i]] = typeof p[i + 1] === 'number' ? [] : {};
    x = x[p[i]];
  }
  x[p[p.length - 1]] = v;
}
// The richest fixture: four cameras, a Pi's host figures, a site CA, the Archive threshold.
function base() {
  const s: any = makeSummary({ cameras: 2, now: Date.now(), pi: true, site: true });
  s.thresholds.archiveWarnPercent = 80;
  s.camera.reboot = 'back';
  return s;
}

let s: Running;
const dir = tmpDir();
beforeAll(async () => { resetAccounts(); s = await startServer(dir, { HEARTBEAT_MIN_GAP_MS: '0', LIMIT_MSG_PER_MIN: '100000', OFFLINE_AFTER_S: '3' }); });
afterAll(async () => { await s.stop(); });

describe('every summary field arrives, is stored, answered and shown', () => {
  const leaves = schemaLeaves(STRICT);

  it('the schema and the fixture agree on the fields', () => {
    const fixturePaths = new Set(summaryLeaves(base()).map((l) => l.path.replace(/\.\d+(\.|$)/g, '.0$1')));
    const schemaPaths = new Set(leaves.map((l) => l.path.join('.')));
    for (const p of fixturePaths) if (!p.endsWith('items') || p.includes('.')) expect(schemaPaths.has(p) || [...schemaPaths].some((x) => x.startsWith(p + '.')), `fixture field ${p} not in the schema`).toBe(true);
    expect(leaves.length).toBeGreaterThan(100);
  });

  it(`all ${schemaLeaves(STRICT).length} leaves, one heartbeat each`, async () => {
    const p = await enrolled(s, 'fields');
    let current = base();
    const c = makeClient(p.key, { summary: () => current, heartbeatS: 1000, minIntervalS: 0 });
    c.start();
    await until(() => c.stats.acked >= 1, 5000, 'first ack');
    const asserted: string[] = [];
    let i = 0;
    for (const leaf of leaves) {
      i++;
      const t = leaf.s.type;
      const old = get(current, leaf.path);
      let value: unknown;
      if (leaf.s.const !== undefined) value = leaf.s.const; // schema: 1 can't change
      else if (t === 'integer') value = 7000 + i;
      else if (t === 'number') value = 0.25 + i;
      else if (t === 'boolean') value = !(old === true);
      else value = `L${i}-${leaf.path.join('-')}`.slice(0, 64); // strings, enums (lenient), item values
      const next = structuredClone(current);
      set(next, leaf.path, value);
      current = next;
      const acked = c.stats.acked;
      c.heartbeatNow();
      await until(() => c.stats.acked > acked, 3000, `ack for ${leaf.path.join('.')}`);
      const stored = s.built.status.row(p.proxyId)!.summary as Record<string, unknown>;
      expect(get(stored, leaf.path), `stored ${leaf.path.join('.')}`).toEqual(value);
      const api = await s.api('GET', `/accounts/${p.accountId}/proxies/${p.proxyId}/status`);
      expect(get(api.summary, leaf.path), `API ${leaf.path.join('.')}`).toEqual(value);
      expect(summaryLeaves(api.summary), `shown ${leaf.path.join('.')}`).toContainEqual({ path: leaf.path.join('.'), text: String(value) });
      asserted.push(leaf.path.join('.'));
    }
    await c.stop();
    // A field of the schema without an assertion fails here.
    expect(asserted.sort()).toEqual(leaves.map((l) => l.path.join('.')).sort());
  }, 120_000);
});

describe('derived values, ageing out, skew, restart', () => {
  it('ok, problemCount, cameras and version follow the summary', async () => {
    const p = await enrolled(s, 'derived');
    let offline: string[] = [];
    const c = makeClient(p.key, { summary: () => makeSummary({ cameras: 3, now: Date.now(), offline, version: offline.length ? 'v2' : 'v1' }) });
    c.start();
    await until(() => s.built.status.view(p.proxyId).state === 'online');
    expect(s.built.status.view(p.proxyId)).toMatchObject({ ok: true, problemCount: 0, version: 'v1', cameras: [{ ref: 'cam1', online: true }, { ref: 'cam2', online: true }, { ref: 'cam3', online: true }] });
    offline = ['cam2'];
    await until(() => s.built.status.view(p.proxyId).version === 'v2');
    expect(s.built.status.view(p.proxyId)).toMatchObject({ ok: false, problemCount: 3, cameras: [{ online: true }, { ref: 'cam2', online: false }, { online: true }] });
    const ev = (await s.api('GET', `/accounts/${p.accountId}/proxies/${p.proxyId}/status-events`)).items.map((e: { kind: string }) => e.kind);
    expect(ev).toEqual(expect.arrayContaining(['problems-changed', 'camera-offline', 'version-changed']));
    await c.stop();
  });

  it('a silent proxy is online until 3 s after its last heartbeat, then offline with cameras unknown, over SSE too', async () => {
    const p = await enrolled(s, 'ageing');
    const c = makeClient(p.key, { heartbeatS: 0.5 });
    // The SSE stream of the dashboard.
    const ctl = new AbortController();
    const sse = await fetch(`${s.url}/api/v1/live`, { headers: { Cookie: `__Host-cams_admin=${s.cookie}` }, signal: ctl.signal });
    const events: any[] = [];
    void (async () => {
      const rd = sse.body!.getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('event: status')) events.push(JSON.parse(chunk.split('\ndata: ')[1]));
        }
      }
    })();
    c.start();
    await until(() => s.built.status.view(p.proxyId).state === 'online');
    c.abort(); // gone without a bye
    const last = s.built.status.row(p.proxyId)!.lastHeartbeatAt!;
    await until(() => Date.now() - last >= 2500, 5000);
    expect(s.built.status.view(p.proxyId).state).toBe('online');
    await until(() => s.built.status.view(p.proxyId).state === 'offline', 2000, 'offline');
    expect(Date.now() - last).toBeGreaterThanOrEqual(3000);
    expect(Date.now() - last).toBeLessThan(3600);
    expect(s.built.status.view(p.proxyId).cameras).toEqual([{ ref: 'cam1', online: null }, { ref: 'cam2', online: null }]);
    await until(() => events.some((e) => e.proxyId === p.proxyId && e.state === 'offline'), 2000, 'SSE offline');
    ctl.abort();
  });

  it('clock skew of ±10 min is accepted, stored, shown as a problem, and never changes liveness', async () => {
    for (const off of [-600_000, 600_000]) {
      const p = await enrolled(s, `skew${off > 0 ? 'ahead' : 'behind'}`);
      const c = makeClient(p.key, { clockOffsetMs: off });
      c.start();
      await until(() => s.built.status.view(p.proxyId).state === 'online');
      const v = s.built.status.view(p.proxyId);
      expect(Math.abs(v.skewMs! - off)).toBeLessThan(2000);
      expect(v.skewProblem).toBe(true);
      const d = await s.api('GET', '/dashboard');
      expect(d.accounts.flatMap((a: any) => a.proxies).find((x: any) => x.id === p.proxyId)).toMatchObject({ state: 'online', skewProblem: true });
      await c.stop();
    }
  });

  it('a cams-admin restart keeps the stored status (stale), and the proxy comes back live', async () => {
    const p = await enrolled(s, 'restart');
    const c = makeClient(p.key);
    c.start();
    await until(() => s.built.status.view(p.proxyId).state === 'online');
    s = await s.restart();
    // Stored before the restart (the shutdown flush), shown stale until the hello.
    const v = s.built.status.view(p.proxyId);
    expect(v.cameras.length).toBe(2);
    await until(() => !s.built.status.view(p.proxyId).stale && s.built.status.view(p.proxyId).state === 'online', 5000, 'live again');
    await c.stop();
  });
});
