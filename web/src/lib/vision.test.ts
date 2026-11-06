import { describe, expect, it } from 'vitest';
import { limitProblem, providerRows, saveText, visionState } from './vision';

const prov = (o: Record<string, unknown> = {}) => ({
  id: 'google-vision', name: 'Google Vision', enabled: true, key: 'env', monthlyLimit: 1000, remoteMaxMonthly: 1000, dailyCap: 0,
  month: { calls: 10 }, today: { calls: 1 }, paused: null, lastError: null, cameras: [], ...o,
});
const item = (o: Record<string, unknown> = {}) => ({ proxyId: 'prx_1', name: 'pi', displayName: 'Pi', state: 'online', access: 'ok', refreshing: false, fetchedAt: 1, result: { v: 1, at: 1, providers: [prov()] }, saves: {}, lastRefusal: null, ...o });

describe('visionState: the first word that applies', () => {
  it.each([
    ['offline first, whatever else', item({ state: 'offline', access: 'too-old' }), prov({ enabled: false }), 'Offline', 'bad'],
    ['too old', item({ access: 'too-old' }), prov(), 'Proxy too old', 'warn'],
    ['not allowed', item({ access: 'not-allowed' }), prov(), 'Not allowed at the proxy', 'warn'],
    ['paused: invalid key', item(), prov({ paused: { reason: 'invalid_key', until: null } }), 'Paused: invalid key', 'warn'],
    ['off (enabled false)', item(), prov({ enabled: false }), 'Off', ''],
    ['off (limit 0)', item(), prov({ monthlyLimit: 0 }), 'Off', ''],
    ['on, no key', item(), prov({ key: 'none' }), 'On, no key', 'warn'],
    ['limit reached', item(), prov({ month: { calls: 1000 } }), 'Limit reached this month', 'warn'],
    ['on', item(), prov(), 'On', 'ok'],
    ['no figures yet', item({ result: null }), null, 'No figures yet', ''],
  ])('%s', (_n, it_, p, word, cls) => {
    expect(visionState(it_ as never, p as never)).toEqual({ word, cls });
  });
  it('paused for quota names its end', () => {
    expect(visionState(item() as never, prov({ paused: { reason: 'quota', until: Date.UTC(2026, 10, 6, 12) } }) as never).word).toMatch(/^Paused: quota until /);
  });
});

describe('limitProblem: 0 = off; the ceiling from the last refresh (the proxy decides)', () => {
  it.each([
    ['', 1000, 500, 'Enter a whole number from 0 to 100,000.'],
    ['1.5', 1000, 500, 'Enter a whole number from 0 to 100,000.'],
    ['-1', 1000, 500, 'Enter a whole number from 0 to 100,000.'],
    ['100001', 200000, 500, 'Enter a whole number from 0 to 100,000.'],
    ['0', 0, 500, null],
    ['400', 0, 500, null], // lowering is always allowed
    ['800', 1000, 500, null],
    ['1200', 1000, 500, 'Above the ceiling at the proxy: up to 1,000.'],
    ['1', 0, 0, "cams-admin can't switch it on: no ceiling at the proxy."],
    ['5', null, 0, null], // no figures: the proxy decides
  ])('%s (ceiling %s, now %s)', (v, ceiling, current, out) => expect(limitProblem(v, ceiling, current, true)).toBe(out));
  it('switching on from off needs a ceiling above 0, even below the current limit', () => {
    expect(limitProblem('500', 0, 1000, false)).toBe("cams-admin can't switch it on: no ceiling at the proxy.");
    expect(limitProblem('500', 1000, 1000, false)).toBeNull();
    expect(limitProblem('0', 0, 1000, false)).toBeNull();
  });
});

describe('rows and save text', () => {
  it('one row per provider; a proxy without figures still has one row', () => {
    expect(providerRows(item() as never).map((r) => r.id)).toEqual(['google-vision']);
    expect(providerRows(item({ result: null }) as never)).toEqual([{ id: 'google-vision', p: null }]);
  });
  it('save states in words, the proxy\'s detail with a refusal', () => {
    expect(saveText({ state: 'previewing' } as never)).toBe('Checking at the proxy…');
    expect(saveText({ state: 'applying' } as never)).toBe('Saving…');
    expect(saveText({ state: 'saved' } as never)).toBe('Saved.');
    expect(saveText({ state: 'failed', code: 'above_local_ceiling', detail: 'cams-admin may allow up to 1000 calls a month' } as never)).toBe('Refused: above the ceiling at the proxy (cams-admin may allow up to 1000 calls a month).');
    expect(saveText({ state: 'failed', code: 'conflict', detail: null } as never)).toBe('The proxy\'s settings changed meanwhile: Refresh and save again.');
  });
});
