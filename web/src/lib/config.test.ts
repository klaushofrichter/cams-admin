import { describe, expect, it } from 'vitest';
import { EFFECT, waitCommand, widens, groupPaths, isRemoteSettable, narrowNote, narrowOk, parseValue, rollbackable, stateLine, valueText, type ConfigView } from './config';

const view: ConfigView = {
  revision: `sha256:${'a'.repeat(64)}`, schema: 1, cameras: ['cam1'], omittedCameras: [], fetchedAt: 1, cmdId: 'cmd_0123456789ABCDEFGHJK',
  paths: {
    'sse.pingS': { v: 30, s: 'default' },
    'sse.maxClients': { v: 20, s: 'env' },
    'retention.clipsDays': { v: 90, s: 'override', by: { cmdId: 'cmd_0123456789ABCDEFGHJK', actor: 'a@example.com', at: 1 } },
    'analytics.googleVision.monthlyLimit': { v: 1000, s: 'default' },
    'storage.maxPercent': { v: 90, s: 'default' },
    'camsAdmin.url': { v: 'https://x.example', s: 'file' },
    'cameras.cam1.name': { v: 'Front', s: 'file' },
    'cameras.cam1.host': { v: '192.0.2.10', s: 'file' },
  },
  settable: {
    'sse.pingS': { type: 'integer', min: 5, max: 300 }, 'sse.maxClients': { type: 'integer' }, 'retention.clipsDays': { type: 'integer', dir: 'more' },
    'analytics.googleVision.monthlyLimit': { type: 'integer', dir: 'less' }, 'cameras.*.name': { type: 'string', pattern: '^[^\\u0000-\\u001f]{1,64}$' },
    'storage.maxPercent': { type: 'integer' }, 'camsAdmin.url': { type: 'string' },
  },
};

describe('config (Settings UI)', () => {
  it('groups paths like the proxy\'s Settings page: top-level key, one group per camera', () => {
    const g = groupPaths(view);
    expect(g.map((x) => x.camera ? `cameras/${x.camera}` : x.group)).toEqual(['analytics', 'camsAdmin', 'retention', 'sse', 'storage', 'cameras/cam1']);
    expect(g.find((x) => x.group === 'sse')!.rows.map((r) => r.label)).toEqual(['maxClients', 'pingS']);
    expect(g.find((x) => x.camera === 'cam1')!.rows.map((r) => r.label)).toEqual(['host', 'name']);
  });
  it('editability and why: env, never remote, storage local only, narrow directions', () => {
    const row = (p: string) => groupPaths(view).flatMap((x) => x.rows).find((r) => r.path === p)!;
    expect(row('sse.pingS')).toMatchObject({ editable: true });
    expect(row('sse.pingS').why).toBeUndefined();
    expect(row('sse.maxClients')).toMatchObject({ editable: false, why: "set in the proxy's environment" });
    expect(row('camsAdmin.url')).toMatchObject({ editable: false, why: 'never remote (addresses, ports, files, trust, users)' });
    expect(row('cameras.cam1.host')).toMatchObject({ editable: false, why: 'never remote (addresses, ports, files, trust, users)' });
    expect(row('storage.maxPercent')).toMatchObject({ editable: false, why: 'storage settings are local only' });
    expect(row('retention.clipsDays')).toMatchObject({ editable: true, why: 'only higher from cams-admin' });
    expect(row('analytics.googleVision.monthlyLimit')).toMatchObject({ editable: true, why: 'only lower from cams-admin' });
    expect(row('cameras.cam1.name')).toMatchObject({ editable: true });
  });
  it('isRemoteSettable is remote-settable.json ∩ the proxy\'s settable', () => {
    expect(isRemoteSettable('sse.pingS', view.settable)).toBe(true);
    expect(isRemoteSettable('camsAdmin.url', view.settable)).toBe(false); // the proxy's settable can't widen the editor
    expect(isRemoteSettable('storage.maxPercent', view.settable)).toBe(false);
    expect(isRemoteSettable('sse.queuePerClient', view.settable)).toBe(false);
  });
  it('parseValue: types, bounds, oneOf, enum, pattern', () => {
    expect(parseValue({ type: 'integer', min: 5, max: 300 }, '7')).toEqual({ ok: true, value: 7 });
    expect(parseValue({ type: 'integer', min: 5, max: 300 }, '4')).toEqual({ ok: false, error: 'at least 5' });
    expect(parseValue({ type: 'integer', min: 5, max: 300 }, '301')).toEqual({ ok: false, error: 'at most 300' });
    expect(parseValue({ type: 'integer' }, '7.5')).toEqual({ ok: false, error: 'a whole number' });
    expect(parseValue({ type: 'integer' }, ' ')).toEqual({ ok: false, error: 'a whole number' });
    expect(parseValue({ type: 'integer', oneOf: [1, 2, 4] }, '3')).toEqual({ ok: false, error: 'one of 1, 2, 4' });
    expect(parseValue({ type: 'boolean' }, 'true')).toEqual({ ok: true, value: true });
    expect(parseValue({ type: 'boolean' }, 'yes')).toEqual({ ok: false, error: 'true or false' });
    expect(parseValue({ type: 'string', enum: ['main', 'sub'] }, 'sub')).toEqual({ ok: true, value: 'sub' });
    expect(parseValue({ type: 'string', enum: ['main', 'sub'] }, 'x')).toEqual({ ok: false, error: 'one of main, sub' });
    // M4: a proxy-supplied regex never runs in the browser (ReDoS); the proxy checks it.
    expect(parseValue({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(40) + '!')).toEqual({ ok: true, value: 'a'.repeat(40) + '!' });
    // M3: a camera name follows the contract's name rule
    expect(parseValue({ type: 'string' }, 'evil\u202Egnp', 'cameras.cam1.name')).toEqual({ ok: false, error: 'no control, bidi or zero-width characters; at most 64' });
    expect(parseValue({ type: 'string' }, 'x'.repeat(513))).toEqual({ ok: false, error: 'at most 512 characters' });
  });
  it('narrowNote and narrowOk: the input refuses a lowered retention period, a raised Vision limit and any storage edit', () => {
    expect(narrowNote('retention.clipsDays')).toBe('only higher from cams-admin (keeps data longer)');
    expect(narrowNote('ftp.maxGB')).toBe('only higher from cams-admin (keeps data longer)');
    expect(narrowNote('analytics.googleVision.dailyCap')).toBe('only lower from cams-admin (spending)');
    expect(narrowNote('storage.maxPercent')).toBe('storage settings are local only');
    expect(narrowNote('cameras.cam1.storage.sharePercent')).toBe('storage settings are local only');
    expect(narrowNote('sse.pingS')).toBeNull();
    expect(narrowOk('retention.clipsDays', 90, 30)).toBe(false);
    expect(narrowOk('retention.clipsDays', 90, 120)).toBe(true);
    expect(narrowOk('analytics.googleVision.monthlyLimit', 1000, 5000)).toBe(false);
    expect(narrowOk('analytics.googleVision.dailyCap', 0, 10)).toBe(true);
    expect(narrowOk('ftp.maxGB', undefined, 10)).toBe(false);
    expect(narrowOk('sse.pingS', 30, 5)).toBe(true);
    expect(narrowOk('retention.clipsDays', 30, true)).toBe(false); // M1
    expect(widens({ path: 'retention.clipsDays', from: 120, to: 90, sourceFrom: 'override', sourceTo: 'override' })).toBe('restores the local value: keeps less data'); // M6
    expect(widens({ path: 'analytics.googleVision.monthlyLimit', from: 500, to: 1000, sourceFrom: 'override', sourceTo: 'default' })).toBe('restores the local value: more spending');
    expect(widens({ path: 'retention.clipsDays', from: 90, to: 120, sourceFrom: 'override', sourceTo: 'override' })).toBeNull();
  });
  it('stateLine and rollbackable', () => {
    expect(stateLine({ state: 'received', outcomeCode: null })).toBe('sent, waiting for the proxy');
    expect(stateLine({ state: 'queued', outcomeCode: null })).toBe('sent, waiting for the proxy');
    expect(stateLine({ state: 'done', outcomeCode: null })).toBe('applied');
    expect(stateLine({ state: 'done', outcomeCode: null, dryRun: true })).toBe('previewed');
    expect(stateLine({ state: 'failed', outcomeCode: 'conflict' })).toBe('changed on the proxy since you loaded it');
    expect(stateLine({ state: 'refused', outcomeCode: 'rate_limited', retryAfterS: 3000 })).toBe("the proxy's limit: try again in 50 min");
    expect(stateLine({ state: 'refused', outcomeCode: 'rate_limited', retryAfterS: 20 })).toBe("the proxy's limit: try again in 1 min");
    expect(stateLine({ state: 'failed', outcomeCode: 'widening_local_only' })).toBe('failed: widening_local_only');
    const real = { command: 'config.set', dryRun: false, state: 'done', result: { changes: [{ path: 'sse.pingS' }] } };
    expect(rollbackable(real)).toBe(true);
    expect(rollbackable({ ...real, dryRun: true })).toBe(false);
    expect(rollbackable({ ...real, state: 'failed' })).toBe(false);
    expect(rollbackable({ ...real, result: { changes: [] } })).toBe(false);
    expect(rollbackable({ ...real, command: 'config.get' })).toBe(false);
    expect(rollbackable({ ...real, command: 'config.rollback' })).toBe(true);
  });
  it('valueText: unset, booleans, strings as text', () => {
    expect(valueText(undefined)).toBe('unset');
    expect(valueText(true)).toBe('true');
    expect(valueText('<b>x</b>')).toBe('<b>x</b>');
    expect(valueText(7)).toBe('7');
  });
  it('waitCommand polls until the row is final, or gives up', async () => {
    const states = ['queued', 'sent', 'received', 'done'];
    let i = 0;
    expect(await waitCommand(async () => ({ state: states[i++] }), 1000, 1)).toEqual({ state: 'done' });
    expect(i).toBe(4);
    expect(await waitCommand(async () => ({ state: 'sent' }), 5, 1)).toBeNull();
  });
  it('every disruptive action and proxy.restart has an effect sentence', () => {
    for (const a of ['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push', 'proxy.restart']) expect(EFFECT[a], a).toMatch(/\.$/);
  });
});
