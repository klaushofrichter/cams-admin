import { describe, expect, it } from 'vitest';
import { codeText } from './api';
import { flowDone, flowText, forceCycleText, lastText, passwordHint, poll, powerLine, powerManaged, removeText, chainedText, trunkText, operatingProxies, surveyMissText } from './switches';

const NOW = 1_000_000_000;

describe('powerLine', () => {
  it('names the switch, the port and how long ago it was verified', () => {
    expect(powerLine({ kind: 'poe', switchId: 's', port: 3, watts: 4, verifiedAt: NOW - 5 * 60_000 }, 'GPS-208', NOW)).toBe('PoE: GPS-208 port 3 · verified 5 min ago');
  });
  it('a PoE record never verified, and one the last survey did not see', () => {
    expect(powerLine({ kind: 'poe', switchId: 's', port: 3, watts: 4 }, 'GPS-208', NOW)).toBe('PoE: GPS-208 port 3');
    expect(powerLine({ kind: 'poe', switchId: 's', port: 3, watts: 4, verifiedAt: NOW, notSeen: true }, 'GPS-208', NOW)).toBe('PoE: GPS-208 port 3 · verified 0 s ago · not seen in the last survey');
  });
  it('the other kinds', () => {
    expect(powerLine({ kind: 'data-only', switchId: 's', port: 2 }, 'GPS-208', NOW)).toBe('Data only (adapter)');
    expect(powerLine({ kind: 'adapter' }, null, NOW)).toBe('Power adapter');
    expect(powerLine({ kind: 'unknown' }, null, NOW)).toBe('Unknown');
    expect(powerLine(undefined, null, NOW)).toBe('Unknown');
  });
  it('a switch that is gone from the list is still named by its port', () => {
    expect(powerLine({ kind: 'poe', switchId: 's', port: 1, watts: 1 }, null, NOW)).toBe('PoE: switch port 1');
  });
});

describe('texts', () => {
  it('the forced cycle confirm is the agreed sentence', () => {
    expect(forceCycleText('GPS-208', 3)).toBe('Cut power on GPS-208 port 3 without verification?');
  });
  it('the password hint names the proxy', () => {
    expect(passwordHint('pi')).toBe("The switch password is tied to its address: set it again on pi's Proxy settings → PoE switches before testing.");
  });
  it('remove names the cameras that become unknown', () => {
    expect(removeText('GPS-208', ['Garage', 'Porch'])).toContain('Garage, Porch');
    expect(removeText('GPS-208', ['Garage', 'Porch'])).toContain('unknown');
    expect(removeText('GPS-208', [])).toContain('No camera');
  });
  it('a last outcome is told in user words', () => {
    expect(lastText({ op: 'test', outcome: 'ok', code: null, at: 1 })).toBe('Test: done');
    expect(lastText({ op: 'move', outcome: 'refused', code: 'switch_taken', at: 1 })).toBe(`Move: ${codeText('switch_taken')}`);
    expect(lastText({ op: 'test', outcome: 'failed', code: 'save_failed', at: 1 })).toBe(`Test: ${codeText('save_failed')}`);
    expect(lastText({ op: 'update', outcome: 'failed', code: 'weird', at: 1 })).toBe('Update: weird');
    expect(lastText(null)).toBe('');
  });
  it('a camera flow', () => {
    expect(flowText({ op: 'verify', state: 'ok', code: null, reason: null, requestedAt: 1, commandIds: [], finishedAt: 2 })).toBe('Verified.');
    expect(flowText({ op: 'cycle', state: 'ok', code: null, reason: null, requestedAt: 1, commandIds: [], finishedAt: 2 })).toBe('Power-cycled.');
    expect(flowText({ op: 'cycle', state: 'failed', code: 'not_verified', reason: 'x', requestedAt: 1, commandIds: [], finishedAt: 2 })).toBe(codeText('not_verified'));
    expect(flowText({ op: 'verify', state: 'failed', code: 'other', reason: 'because', requestedAt: 1, commandIds: [], finishedAt: 2 })).toBe('because');
    expect(flowText({ op: 'verify', state: 'running', code: null, reason: null, requestedAt: 1, commandIds: [], finishedAt: null })).toBe('Running…');
  });
});

describe('flowDone', () => {
  const f = (o = {}) => ({ op: 'verify', state: 'running', code: null, reason: null, requestedAt: 5, commandIds: ['c1'], finishedAt: null, ...o }) as never;
  it('an old finished flow is not the new one', () => {
    const old = f({ state: 'ok' });
    expect(flowDone(old, old)).toBe(false);
    expect(flowDone(old, null)).toBe(false);
  });
  it('a new flow is done when it is no longer running', () => {
    const old = f({ state: 'ok' });
    expect(flowDone(old, f({ requestedAt: 9, commandIds: ['c2'] }))).toBe(false);
    expect(flowDone(old, f({ requestedAt: 9, commandIds: ['c2'], state: 'failed' }))).toBe(true);
    expect(flowDone(null, f({ state: 'ok' }))).toBe(true);
  });
});

describe('powerManaged: the old proxy power-cycle action steps aside', () => {
  it('only for a camera with a power record of cams-admin', () => {
    expect(powerManaged({ kind: 'poe', switchId: 's', port: 1, watts: 1 })).toBe(true);
    expect(powerManaged({ kind: 'data-only', switchId: 's', port: 1 })).toBe(true);
    expect(powerManaged({ kind: 'adapter' })).toBe(true);
    expect(powerManaged({ kind: 'unknown' })).toBe(false);
    expect(powerManaged(undefined)).toBe(false);
  });
});

describe('poll', () => {
  it('asks until done, then returns the value', async () => {
    let n = 0;
    const waits: number[] = [];
    const v = await poll(async () => ++n, (x) => x >= 3, { sleep: async (ms) => { waits.push(ms); } });
    expect(v).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });
  it('gives up after 60 s with null', async () => {
    let slept = 0;
    const v = await poll(async () => 1, () => false, { sleep: async (ms) => { slept += ms; } });
    expect(v).toBeNull();
    expect(slept).toBe(60_000);
  });
});

import { adapterConfirmNeeded, cycleConfirmText, CYCLE_TYPED, flowLine } from './switches';
describe('confirm flow and last flows', () => {
  it('the plain power-cycle names camera, switch and port, and wants the typed word', () => {
    expect(cycleConfirmText('Garage', 'GPS-208', 3)).toBe('Cut power on GPS-208 port 3 to restart Garage, then turn it back on: no video for a few minutes.');
    expect(CYCLE_TYPED).toBe('power-cycle');
  });
  it('declaring an adapter asks first only over a verified PoE record', () => {
    expect(adapterConfirmNeeded({ kind: 'poe', switchId: 's', port: 1, watts: 1, verifiedAt: 5 })).toBe(true);
    expect(adapterConfirmNeeded({ kind: 'poe', switchId: 's', port: 1, watts: 1 })).toBe(false);
    expect(adapterConfirmNeeded({ kind: 'unknown' })).toBe(false);
  });
  const fl = (o = {}) => ({ op: 'cycle', state: 'failed', code: 'not_verified', reason: null, requestedAt: NOW - 120_000, commandIds: [], finishedAt: NOW - 100_000, ...o }) as never;
  it('lastCycle: time, forced or not, outcome in user words', () => {
    expect(flowLine(fl(), NOW)).toBe(`Last power-cycle 2 min ago: ${codeText('not_verified')}`);
    expect(flowLine(fl({ force: true, state: 'ok', code: null }), NOW)).toBe('Last forced power-cycle 2 min ago: Power-cycled.');
    expect(flowLine(fl({ op: 'verify', state: 'running' }), NOW)).toBe('Last check 2 min ago: Running…');
    expect(flowLine(null, NOW)).toBe('');
  });
});

describe('chained switches (a configuration issue)', () => {
  it('the warning names the port and the cameras behind it; the port cell says trunk', () => {
    expect(chainedText({ code: 'chained_switch', port: 8, cameras: 3 })).toBe('Configuration issue: another switch is chained on port 8 (3 cameras behind it). Connect each PoE switch directly to its proxy\'s network instead of through another PoE switch.');
    expect(trunkText(3)).toBe('trunk (3 cameras)');
  });
});

describe('trunk_port refusal', () => {
  it('has its own text', () => {
    expect(codeText('trunk_port')).toBe('That port leads to another switch (a configuration issue): cams-admin does not power-cycle it.');
  });
});

describe('the add-switch Operating proxy (no silent default)', () => {
  const px = (id: string, runsOn: string) => ({ id, name: id, runsOn });
  it('cluster proxies last; the only non-cluster proxy is the default, else none', () => {
    expect(operatingProxies([px('cam2', 'cluster'), px('een', 'local-host')])).toEqual({ list: [px('een', 'local-host'), px('cam2', 'cluster')], preset: 'een' });
    expect(operatingProxies([px('cam2', 'cluster'), px('een', 'local-host'), px('pi', 'local-host')])).toEqual({ list: [px('een', 'local-host'), px('pi', 'local-host'), px('cam2', 'cluster')], preset: '' });
    expect(operatingProxies([px('cam2', 'cluster')])).toEqual({ list: [px('cam2', 'cluster')], preset: '' });
    expect(operatingProxies([])).toEqual({ list: [], preset: '' });
  });
});

describe('surveyMissText', () => {
  it('a camera the survey did not find: its reason in words; switch_error with the detail (cam-proxy #364 m3)', () => {
    expect(surveyMissText({ camsId: 'porch', reason: 'no_traffic' })).toBe('porch (no traffic on any port)');
    expect(surveyMissText({ camsId: 'porch', reason: 'switch_error', detail: 'the switch answered HTTP 500' })).toBe('porch (the switch answered with an error: the switch answered HTTP 500)');
    expect(surveyMissText({ camsId: 'porch', reason: 'switch_error' })).toBe('porch (the switch answered with an error)');
    expect(surveyMissText({ camsId: 'porch', reason: 'camera host unknown in cams-admin' })).toBe('porch (camera host unknown in cams-admin)');
    expect(surveyMissText({ camsId: 'porch' })).toBe('porch');
  });
});
