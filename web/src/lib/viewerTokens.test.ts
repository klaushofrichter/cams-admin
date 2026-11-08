import { describe, expect, it } from 'vitest';
import { ADMIN_WARNING, DEFAULT_VALIDITY_DAYS, QUIET_ZONE, VALIDITY, linkHost, qrPath, roleClass, stateClass } from './viewerTokens';

describe('viewer tokens (web)', () => {
  it('offers Klaus\'s validities, one week preselected', () => {
    expect(VALIDITY.map((v) => v.days)).toEqual([1, 7, 30, 90, 365]);
    expect(DEFAULT_VALIDITY_DAYS).toBe(7);
  });

  it('draws the 65-character link as a version 5 code (37 modules) with a 4-module quiet zone', () => {
    const q = qrPath('https://cams.skylar.technology/token#t=cav_TestOnlyNotARealToken0');
    expect(q.modules).toBe(37);
    expect(QUIET_ZONE).toBe(4);
    expect(q.size).toBe(45);
    expect(q.path).toMatch(/^M4 4h1v1h-1z/); // the finder pattern's corner, inside the quiet zone
  });

  it('state colours and the link host', () => {
    expect([stateClass('valid'), stateClass('expired'), stateClass('revoked')]).toEqual(['ok', 'warn', 'bad']);
    expect(linkHost('https://cams.skylar.technology/token#t=x')).toBe('cams.skylar.technology');
    expect(linkHost('nope')).toBe('');
  });
});

describe('role (spec 2026-11-08 B6)', () => {
  it('admin is shown orange with a one-line warning; viewer plain', () => {
    expect(roleClass('admin')).toBe('warn');
    expect(roleClass('viewer')).toBe('');
    expect(ADMIN_WARNING).toMatch(/^An admin token can confirm held cameras/);
  });
});
