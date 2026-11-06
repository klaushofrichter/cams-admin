import { describe, expect, it } from 'vitest';
import { ceilingOf, EFFECT, nameError, renameOutcome, waitCommand, widens, groupPaths, isRemoteSettable, narrowNote, narrowOk, parseValue, rollbackable, stateLine, valueText, type ConfigView } from './config';

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
    'analytics.googleVision.monthlyLimit': { type: 'integer', dir: 'less' },
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
    expect(row('analytics.googleVision.monthlyLimit')).toMatchObject({ editable: true, why: "only up to the proxy's local ceiling from cams-admin" });
    expect(row('cameras.cam1.name')).toMatchObject({ editable: false, why: 'never remote (addresses, ports, files, trust, users)' });
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
    // Vision (ceiling): lower always; higher only within the proxy's local ceiling; an unknown ceiling → the proxy decides.
    expect(narrowNote('analytics.googleVision.monthlyLimit')).toBe("only up to the proxy's local ceiling from cams-admin");
    expect(narrowNote('analytics.googleVision.enabled')).toBe('on from cams-admin only when the proxy sets a ceiling');
    expect(narrowOk('analytics.googleVision.monthlyLimit', 1000, 5000, 1000)).toBe(false);
    expect(narrowOk('analytics.googleVision.monthlyLimit', 5000, 3000, 1000)).toBe(true);
    expect(narrowOk('analytics.googleVision.monthlyLimit', 0, 800, 1000)).toBe(true);
    expect(narrowOk('analytics.googleVision.monthlyLimit', 1000, 5000)).toBe(true);
    expect(narrowOk('analytics.googleVision.monthlyLimit', 1000, true, 1000)).toBe(false);
    expect(narrowOk('analytics.googleVision.enabled', false, true, 0)).toBe(false);
    expect(narrowOk('analytics.googleVision.enabled', false, true, 1000)).toBe(true);
    expect(narrowOk('analytics.googleVision.enabled', true, false, 0)).toBe(true);
    expect(ceilingOf({ paths: { 'analytics.googleVision.remoteMaxMonthly': { v: 1000, s: 'file' } } }, 'analytics.googleVision.monthlyLimit')).toBe(1000);
    expect(ceilingOf({ paths: {} }, 'sse.pingS')).toBeUndefined();
    expect(narrowOk('analytics.googleVision.dailyCap', 0, 10)).toBe(true);
    expect(narrowOk('ftp.maxGB', undefined, 10)).toBe(false);
    expect(narrowOk('sse.pingS', 30, 5)).toBe(true);
    expect(narrowOk('retention.clipsDays', 30, true)).toBe(false); // M1
    expect(widens({ path: 'retention.clipsDays', from: 120, to: 90, sourceFrom: 'override', sourceTo: 'override' })).toBe('restores the local value: keeps less data'); // M6
    expect(widens({ path: 'analytics.googleVision.dailyCap', from: 50, to: 100, sourceFrom: 'override', sourceTo: 'default' })).toBe('restores the local value: more spending');
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
    expect(stateLine({ state: 'failed', outcomeCode: 'widening_local_only' })).toBe('refused by the proxy: it would lower a raise-only value, raise spending or change a local-only setting');
    expect(stateLine({ state: 'failed', outcomeCode: 'above_local_ceiling' })).toBe('refused by the proxy: above the limit its local admin allows cams-admin to set');
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
  it('nameError: the camera\'s own name rules, before anything is sent', () => {
    expect(nameError('Back yard (left) [1]')).toBeNull();
    expect(nameError('x'.repeat(32))).toBe('too long: 32 characters, at most 31');
    expect(nameError('Back_yard')).toBe('not allowed: _');
    expect(nameError(' Garage')).toBe('no leading or trailing space');
    expect(nameError('Garage Süd')).toBe('not allowed: ü');
    for (const bad of ['', 'evil\u061Cname', 'a\u202Eb']) expect(nameError(bad), JSON.stringify(bad)).not.toBeNull();
  });
  it('renameOutcome: what a rename command did, in words', () => {
    const row = (state: string, outcomeCode: string | null = null, result: unknown = null) => ({ state, outcomeCode, result });
    expect(renameOutcome(row('done', null, { name: 'Garage door', verified: true }), 'Garage door')).toBe('The camera is now "Garage door"; cams-admin follows at its proxy\'s next report (about 30 s).');
    expect(renameOutcome(row('done', null, { name: 'Garage', verified: false }), 'Garage door')).toBe('The camera holds "Garage" (asked for "Garage door"); cams-admin follows at its proxy\'s next report.');
    expect(renameOutcome(row('failed', 'camera_offline'), 'X')).toBe('The camera is offline; try again when it is online.');
    expect(renameOutcome(row('failed', 'invalid_name'), 'X')).toBe('The camera refused the name.');
    expect(renameOutcome(row('refused', 'not_allowed'), 'X')).toBe('Rename refused: not_allowed.');
    expect(renameOutcome(null, 'X')).toBe('No answer from the proxy yet: cams-admin follows once the camera has taken the name.');
  });
  it('waitCommand polls until the row is final, or gives up', async () => {
    const states = ['queued', 'sent', 'received', 'done'];
    let i = 0;
    expect(await waitCommand(async () => ({ state: states[i++] }), 1000, 1)).toEqual({ state: 'done' });
    expect(i).toBe(4);
    expect(await waitCommand(async () => ({ state: 'sent' }), 5, 1)).toBeNull();
  });
  it('every disruptive action and proxy.restart has an effect sentence', () => {
    for (const a of ['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ntp-set', 'camera-cert-push', 'camera-time-set', 'proxy.restart']) expect(EFFECT[a], a).toMatch(/\.$/);
    expect(EFFECT['camera-ftp-off']).toBeUndefined(); // never remote (cam-proxy #196)
  });
});
