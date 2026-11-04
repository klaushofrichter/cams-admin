import { describe, expect, it } from 'vitest';
import { describeChange, importSummary, instanceForm, instancePatch, instanceState, stateText, validInstanceName } from './cams';

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

describe('an import change as a line', () => {
  it('an override for the instance: its values before and after; null = the camera\'s own value', () => {
    expect(describeChange({ kind: 'camera-override', camsId: 'cam1', instance: 'pi', fields: { host: { from: '192.0.2.164', to: 'from-proxy', override: 'from-proxy' }, cameraUser: { from: 'proxy', to: 'cams', override: null } } }))
      .toBe('camera cam1: override for pi: host "192.0.2.164" → "from-proxy", camera user "proxy" → "cams" (the camera\'s value)');
    expect(describeChange({ kind: 'camera-change', camsId: 'cam2', fields: { host: { from: 'a', to: 'b' } } })).toBe('camera cam2: host "a" → "b"');
    expect(describeChange({ kind: 'route-add', name: 'pi', url: null })).toBe('route pi → (registered URL)');
    expect(describeChange({ kind: 'camera-kept', camsId: 'cam1', servedTo: ['cluster'], fields: { tlsServername: 'cam1.example.net' } })).toBe('camera cam1: kept, cluster uses them: TLS name "cam1.example.net"');
    expect(importSummary({ changes: [{ kind: 'camera-override' }], mismatches: [] })).toEqual([{ label: 'camera overrides for this instance', count: 1 }]);
  });
});

describe('the instance Details form', () => {
  const saved = { displayName: 'Mini PC', name: 'mini', baseUrl: 'http://127.0.0.1:8080', notes: '' };
  it('fills empty values as empty strings', () => {
    expect(instanceForm({ displayName: 'D', name: 'n', baseUrl: null, notes: null })).toEqual({ displayName: 'D', name: 'n', baseUrl: '', notes: '' });
  });
  it('a patch holds only what changed, trimmed', () => {
    expect(instancePatch(saved, saved)).toEqual({});
    expect(instancePatch({ ...saved, displayName: ' Mini PC ', notes: '  ' }, saved)).toEqual({});
    expect(instancePatch({ ...saved, baseUrl: ' https://cams.example.net ' }, saved)).toEqual({ baseUrl: 'https://cams.example.net' });
    expect(instancePatch({ ...saved, name: 'mini2', notes: 'n' }, saved)).toEqual({ name: 'mini2', notes: 'n' });
  });
  it('an emptied address or note is cleared; an emptied name is sent, for the server to refuse', () => {
    expect(instancePatch({ ...saved, baseUrl: '' }, saved)).toEqual({ baseUrl: null });
    expect(instancePatch({ ...saved, notes: '' }, { ...saved, notes: 'old' })).toEqual({ notes: null });
    expect(instancePatch({ ...saved, displayName: '' }, saved)).toEqual({ displayName: '' });
  });
  it('the name rule', () => {
    for (const ok of ['a', 'pi', 'mini-pc', '1a', 'a'.repeat(32)]) expect(validInstanceName(ok)).toBe(true);
    for (const bad of ['', 'Pi', '-a', 'a b', 'a_b', 'a'.repeat(33)]) expect(validInstanceName(bad)).toBe(false);
  });
});
