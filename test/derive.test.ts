import { describe, expect, it } from 'vitest';
import { cameraStates, deriveProxyState, pinState, reconcile, type StatusRow } from '../server/status/derive';

const NOW = 1_791_273_600_000;
const W = 90_000;
const st = (o: Partial<StatusRow> = {}): StatusRow => ({ proxyId: 'prx_a', connected: true, connectedSince: NOW - 1000, lastHelloAt: NOW - 1000, lastHeartbeatAt: NOW - 1000, closedReason: null, stopped: false, proxyVersion: 'v1', clockSkewMs: 0, summary: null, summaryAt: null, ok: true, problemCount: 0, reported: { cameras: [{ ref: 'cam1', online: true }, { ref: 'cam2', online: false }], caFingerprint: [] }, online: true, ...o });

describe('deriveProxyState', () => {
  it.each([
    ['revoked', { state: 'revoked' }, st(), true, 'revoked'],
    ['pending', { state: 'pending' }, null, false, 'pending'],
    ['rejected: enrolled without an active key', { state: 'enrolled' }, st(), false, 'rejected'],
    ['never connected', { state: 'enrolled' }, null, true, 'never-connected'],
    ['stopped after bye', { state: 'enrolled' }, st({ stopped: true }), true, 'stopped'],
    ['online', { state: 'enrolled' }, st(), true, 'online'],
  ] as const)('%s', (_n, p, s, key, want) => {
    expect(deriveProxyState(p, s, key, NOW, W)).toBe(want);
  });
  it('online at 89 999 ms, offline at exactly 90 000 ms', () => {
    expect(deriveProxyState({ state: 'enrolled' }, st({ lastHeartbeatAt: NOW - 89_999 }), true, NOW, W)).toBe('online');
    expect(deriveProxyState({ state: 'enrolled' }, st({ lastHeartbeatAt: NOW - 90_000 }), true, NOW, W)).toBe('offline');
  });
  it('a socket closed without bye stays online until the heartbeat ages out', () => {
    expect(deriveProxyState({ state: 'enrolled' }, st({ connected: false, lastHeartbeatAt: NOW - 30_000 }), true, NOW, W)).toBe('online');
  });
  it('hello but no heartbeat yet is offline, not online', () => {
    expect(deriveProxyState({ state: 'enrolled' }, st({ lastHeartbeatAt: null }), true, NOW, W)).toBe('offline');
  });
  it('a server clock that went back: age clamps at 0 (online)', () => {
    expect(deriveProxyState({ state: 'enrolled' }, st({ lastHeartbeatAt: NOW + 60_000 }), true, NOW, W)).toBe('online');
  });
});

describe('cameraStates', () => {
  it('online proxy: from the last summary; otherwise unknown', () => {
    expect(cameraStates(st(), 'online')).toEqual([{ ref: 'cam1', online: true }, { ref: 'cam2', online: false }]);
    expect(cameraStates(st(), 'offline')).toEqual([{ ref: 'cam1', online: null }, { ref: 'cam2', online: null }]);
    expect(cameraStates(null, 'never-connected')).toEqual([]);
  });
});

describe('reconcile and pins', () => {
  const H = (c: string) => 'SHA256:' + c.repeat(64);
  it('reported not registered, registered not reported, proposed cams ids', () => {
    const r = reconcile({ name: 'pi' }, [{ proxyCameraId: 'cam2' }, { proxyCameraId: 'cam9' }], new Set(['cam1', 'cam2']), st());
    expect(r.reportedNotRegistered).toEqual([{ ref: 'cam1', proposedCamsId: 'pi-cam1' }]);
    expect(r.registeredNotReported).toEqual(['cam9']);
    expect(reconcile({ name: 'pi' }, [], new Set(), st()).reportedNotRegistered[0].proposedCamsId).toBe('cam1');
    expect(reconcile({ name: 'pi' }, [{ proxyCameraId: 'cam9' }], new Set(), null).registeredNotReported).toEqual([]);
  });
  it('pin: match, mismatch, hint, none', () => {
    expect(pinState([H('A')], [H('A')])).toBe('match');
    expect(pinState([H('A'), H('B')], [H('B'), H('C')])).toBe('match');
    expect(pinState([H('A')], [H('B'), H('A')])).toBe('mismatch');
    expect(pinState([], [H('A')])).toBe('hint');
    expect(pinState([H('A')], [])).toBe('none');
    expect(pinState([], [])).toBe('none');
  });
});
