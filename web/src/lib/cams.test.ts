import { describe, expect, it } from 'vitest';
import { importSummary, instanceState, stateText } from './cams';

const NOW = 1_791_273_600_000;
const row = (o: object = {}) => ({ lastPullAt: NOW - 60_000, mode: 'cams-admin', held: 0, keptOld: 0, shadowDifferences: null, current: true, diverged: false, problems: 0, ...o });

describe('cams instance state (dashboard, instance page)', () => {
  it.each([
    ['never pulled', { lastPullAt: null }, 'never'],
    ['last pull over 5 min ago', { lastPullAt: NOW - 301_000 }, 'stale'],
    ['kept an old value', { keptOld: 1, held: 2 }, 'diverged'],
    ['holds a change', { held: 2 }, 'held'],
    ['shadow differences', { mode: 'shadow', shadowDifferences: 3 }, 'shadow-diff'],
    ['shadow, zero differences', { mode: 'shadow', shadowDifferences: 0 }, 'ok'],
    ['fine', {}, 'ok'],
  ])('%s', (_n, o, want) => expect(instanceState(row(o), NOW)).toBe(want));
  it('has a text per state', () => {
    for (const s of ['never', 'stale', 'diverged', 'held', 'shadow-diff', 'ok'] as const) expect(stateText(s)).toMatch(/\w/);
  });
});

describe('import summary', () => {
  it('groups changes by kind with labels, in a fixed order, without empty kinds', () => {
    const r = { changes: [{ kind: 'camera-new' }, { kind: 'proxy-matched' }, { kind: 'camera-new' }, { kind: 'route-add' }, { kind: 'registry-only' }, { kind: 'token-external' }], mismatches: [{ id: 'a' }] };
    expect(importSummary(r)).toEqual([
      { label: 'proxies matched', count: 1 },
      { label: 'routes added', count: 1 },
      { label: 'new cameras', count: 2 },
      { label: 'external tokens', count: 1 },
      { label: 'in the registry, not in the file', count: 1 },
      { label: 'mismatches', count: 1 },
    ]);
    expect(importSummary({ changes: [], mismatches: [] })).toEqual([]);
  });
});
