import { describe, expect, it } from 'vitest';
import { accountInput, cameraInput, FieldError, normaliseEmail, normaliseFingerprint, proxyInput, simInput, userInput } from '../server/validate';

const field = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { if (e instanceof FieldError) return e.field; throw e; }
};
const H = 'ab'.repeat(32);

describe('emails', () => {
  it('trim and lower-case', () => expect(normaliseEmail('  Klaus@Example.COM ')).toBe('klaus@example.com'));
  it.each(['a b@example.com', 'a,b@example.com', 'a;b@example.com', 'a"b@example.com', 'a\\b@example.com', 'ab.example.com', 'a@b@example.com', `${'a'.repeat(250)}@x.io`, '', 7])('refuse %s', (e) => {
    expect(field(() => normaliseEmail(e))).toBe('email');
  });
});

describe('fingerprints', () => {
  it('normalise colon hex and plain hex', () => {
    const colon = 'sha256:' + H.match(/../g)!.join(':');
    expect(normaliseFingerprint(colon)).toBe('SHA256:' + H.toUpperCase());
    expect(normaliseFingerprint(H)).toBe('SHA256:' + H.toUpperCase());
  });
  it('refuse 63 hex characters', () => expect(field(() => normaliseFingerprint(H.slice(1)))).toBe('fingerprint'));
});

describe('accounts', () => {
  it('accept a valid account', () => expect(accountInput({ name: 'home', displayName: 'Home' }, false)).toEqual({ name: 'home', displayName: 'Home', notes: null, autoAdopt: false }));
  it('autoAdopt is a boolean, off unless given', () => {
    expect(accountInput({ autoAdopt: true }, true)).toEqual({ autoAdopt: true });
    expect(field(() => accountInput({ autoAdopt: 1 }, true))).toBe('autoAdopt');
  });
  it.each([['h', 'name'], ['-ab', 'name'], ['Home', 'name'], ['a'.repeat(33), 'name']])('refuse name %s', (name, f) => {
    expect(field(() => accountInput({ name, displayName: 'x' }, false))).toBe(f);
  });
  it('refuse an empty or long display name and long notes', () => {
    expect(field(() => accountInput({ name: 'ab', displayName: '' }, false))).toBe('displayName');
    expect(field(() => accountInput({ name: 'ab', displayName: 'x'.repeat(81) }, false))).toBe('displayName');
    expect(field(() => accountInput({ name: 'ab', displayName: 'x', notes: 'n'.repeat(2001) }, false))).toBe('notes');
  });
  it('partial input keeps only given fields', () => expect(accountInput({ displayName: 'New' }, true)).toEqual({ displayName: 'New' }));
});

describe('users', () => {
  it('accept and normalise', () => expect(userInput({ email: 'A@Example.com', role: 'viewer' }, false)).toEqual({ email: 'a@example.com', role: 'viewer', displayName: null, disabled: false }));
  it('refuse a bad role', () => expect(field(() => userInput({ email: 'a@example.com', role: 'owner' }, false))).toBe('role'));
  it('refuse a non-boolean disabled', () => expect(field(() => userInput({ email: 'a@example.com', role: 'admin', disabled: 'yes' }, false))).toBe('disabled'));
});

describe('proxies', () => {
  const ok = { name: 'pi', displayName: 'Pi', runsOn: 'local-host' };
  it('accept a minimal proxy', () => expect(proxyInput(ok, false)).toMatchObject({ name: 'pi', runsOn: 'local-host', caFingerprints: [] }));
  it('a one-character name is allowed', () => expect(proxyInput({ ...ok, name: 'p' }, false).name).toBe('p'));
  it.each([
    [{ runsOn: 'moon' }, 'runsOn'],
    [{ hostKind: 'toaster' }, 'hostKind'],
    [{ url: 'ftp://x.example' }, 'url'],
    [{ url: 'https://user:pw@x.example' }, 'url'],
    [{ url: 'https://x.example/?a=1' }, 'url'],
    [{ url: 'https://x.example/#a' }, 'url'],
    [{ adminUiUrl: 'nope' }, 'adminUiUrl'],
    [{ caFingerprints: [H, H, H] }, 'caFingerprints'],
    [{ caFingerprints: ['zz'] }, 'caFingerprints'],
    [{ dnsName: 'a b' }, 'dnsName'],
  ])('refuse %j', (patch, f) => expect(field(() => proxyInput({ ...ok, ...patch }, false))).toBe(f));
  it('normalise two fingerprints', () => expect(proxyInput({ ...ok, caFingerprints: [H, H.toUpperCase()] }, false).caFingerprints).toEqual(['SHA256:' + H.toUpperCase(), 'SHA256:' + H.toUpperCase()]));
});

describe('cameras and sims', () => {
  const ok = { camsId: 'cam1', name: 'Garage', kind: 'camera' };
  it('accept a camera', () => expect(cameraInput(ok, false)).toMatchObject({ camsId: 'cam1', kind: 'camera', proxyId: null }));
  it.each([
    [{ camsId: 'Cam1' }, 'camsId'],
    [{ kind: 'drone' }, 'kind'],
    [{ protocol: 'ftp' }, 'protocol'],
    [{ webUiNote: 'x'.repeat(121) }, 'webUiNote'],
    [{ name: '' }, 'name'],
    [{ proxyId: 'prx_' + 'A'.repeat(20), proxyCameraId: undefined }, 'proxyCameraId'],
    [{ proxyId: 'prx_X' }, 'proxyId'],
  ])('refuse %j', (patch, f) => expect(field(() => cameraInput({ ...ok, ...patch }, false))).toBe(f));
  // The camera's name rules (camera name sync, Task 5): the reason travels as the hint.
  const hint = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { if (e instanceof FieldError) return e.hint; throw e; } return undefined; };
  it.each([
    ['x'.repeat(32), 'too long: 32 characters, at most 31'],
    ['Back_yard', 'not allowed: _'],
    [' Garage', 'no leading or trailing space'],
  ])('refuse the name %j on create and update, with the reason', (name, reason) => {
    expect(field(() => cameraInput({ ...ok, name }, false))).toBe('name');
    expect(hint(() => cameraInput({ ...ok, name }, false))).toBe(reason);
    expect(field(() => cameraInput({ name }, true))).toBe('name');
    expect(hint(() => cameraInput({ name }, true))).toBe(reason);
  });
  it('a name of 31 allowed characters passes as typed', () => {
    const name = 'Back yard (left) [1]+{2}=3-' + 'abcd';
    expect(name).toHaveLength(31);
    expect(cameraInput({ ...ok, name }, false).name).toBe(name);
    expect(cameraInput({ name }, true).name).toBe(name);
  });
  it('a partial update without a name keeps it out', () => expect(cameraInput({ host: 'h.example.net' }, true)).not.toHaveProperty('name'));
  it('a null name is refused on update', () => expect(field(() => cameraInput({ name: null }, true))).toBe('name'));
  // #120: no camera user is null, never an empty string (cams turned "" into a credentials entry with user "").
  it('an empty camera user is unset (null); a blank one is refused', () => {
    expect(cameraInput({ ...ok, cameraUser: '' }, false).cameraUser).toBeNull();
    expect(cameraInput({ cameraUser: '' }, true).cameraUser).toBeNull();
    expect(field(() => cameraInput({ ...ok, cameraUser: '   ' }, false))).toBe('cameraUser');
    expect(field(() => cameraInput({ cameraUser: ' ' }, true))).toBe('cameraUser');
    expect(cameraInput({ cameraUser: ' admin ' }, true).cameraUser).toBe('admin');
  });
  it('sims need a known runsOn', () => {
    expect(simInput({ runsOn: 'mac' })).toMatchObject({ runsOn: 'mac' });
    expect(field(() => simInput({ runsOn: 'phone' }))).toBe('runsOn');
    expect(field(() => simInput({ runsOn: 'mac', controlUrl: 'x' }))).toBe('controlUrl');
  });
});
