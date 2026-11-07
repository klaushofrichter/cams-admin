import { describe, expect, it } from 'vitest';
import { codeText } from './api';
import { flowDone, flowText, forceCycleText, lastText, passwordHint, poll, powerLine, powerManaged, removeText } from './switches';

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
