import { describe, expect, it } from 'vitest';
import { accountDeleteLines, cameraDeleteLines, instanceDeleteLines, proxyDeleteLines } from './deletes';

const PROXY = { cameras: 2, moves: 3, activeMoves: 0, tokens: 4, liveTokens: 1, routes: 1, keys: 1, commands: 12, switches: [] as string[] };

describe('proxyDeleteLines', () => {
  it('names what goes and what stays, with counts', () => {
    const l = proxyDeleteLines(PROXY);
    expect(l.goes).toEqual([
      'its key (the proxy is disconnected) and any enrollment code',
      '3 camera move records (the history of moves to and from it)',
      '4 proxy tokens (cams viewers using them lose this proxy)',
      '1 viewer route (cams instances stop showing it)',
      'its live status, history, settings and token revision',
    ]);
    expect(l.stays).toEqual([
      '2 cameras, left in the account without a proxy',
      '12 command records, no longer listed under any proxy',
      'the audit log',
    ]);
    expect(l.blocked).toBeNull();
  });
  it('leaves out what is not there; singular forms', () => {
    const l = proxyDeleteLines({ ...PROXY, cameras: 1, moves: 1, tokens: 0, liveTokens: 0, routes: 0, keys: 0, commands: 0 });
    expect(l.goes).toEqual(['any enrollment code', '1 camera move record (the history of moves to and from it)', 'its live status, history, settings and token revision']);
    expect(l.stays).toEqual(['1 camera, left in the account without a proxy', 'the audit log']);
  });
  it('a running move or an operated switch blocks it, said up front', () => {
    expect(proxyDeleteLines({ ...PROXY, activeMoves: 1 }).blocked).toContain('camera move is running');
    expect(proxyDeleteLines({ ...PROXY, switches: ['GPS-208', 'Shed'] }).blocked).toBe('It operates PoE switches "GPS-208", "Shed": move or remove them first (Switches tab).');
    expect(proxyDeleteLines({ ...PROXY, switches: ['GPS-208'] }).blocked).toBe('It operates PoE switch "GPS-208": move or remove it first (Switches tab).');
  });
});

describe('accountDeleteLines', () => {
  const A = { users: 2, proxies: 1, cameras: 3, moves: 0, activeMoves: 0, commands: 5, tokens: 2, routes: 1, switches: 1, camsInstances: 1, viewerTokens: 2 };
  it('everything in the account goes; instances and viewer tokens lose it; the audit log stays', () => {
    const l = accountDeleteLines(A);
    expect(l.goes).toEqual([
      '2 users', '1 proxy (disconnected, keys revoked)', '3 cameras', '5 command records', '2 proxy tokens', '1 viewer route', '1 PoE switch record',
      'live status, history and settings',
    ]);
    expect(l.stays).toEqual(['1 cams instance, which stops serving this account', '2 viewer tokens, which lose this account', 'the audit log']);
    expect(l.blocked).toBeNull();
    expect(accountDeleteLines({ ...A, activeMoves: 2 }).blocked).toContain('camera move is running');
  });
});

describe('instanceDeleteLines', () => {
  it('routes, overrides, keys and account links go; held tokens are revoked; the audit log stays', () => {
    const l = instanceDeleteLines({ routes: 2, overrides: 1, accounts: 1 });
    expect(l.goes).toEqual(['its keys and enrollment codes', '2 routes', '1 camera override', 'its link to 1 account']);
    expect(l.stays).toEqual(['every proxy token it holds, revoked at once (listed as revoked)', 'the audit log']);
  });
});

describe('cameraDeleteLines', () => {
  it('the record and what hangs on it go; the camera and its recordings are not touched', () => {
    const l = cameraDeleteLines(true);
    expect(l.goes).toEqual(['its move records', 'its sim settings and cams camera overrides', 'its power-cycle record']);
    expect(l.stays).toEqual(['the camera and its recordings on the proxy (never added back automatically)', 'the audit log']);
    expect(cameraDeleteLines(false).stays).toEqual(['the audit log']);
  });
});
