import { describe, expect, it } from 'vitest';
import { auditId, codeHash, newEnrollmentCode, newId, normaliseCode, ulid } from '../server/ids';

const B32 = '[0-9A-HJKMNP-TV-Z]';

describe('ids', () => {
  it('has a type prefix and 20 Crockford characters', () => {
    expect(newId('acc')).toMatch(new RegExp(`^acc_${B32}{20}$`));
    expect(newId('prx')).toMatch(new RegExp(`^prx_${B32}{20}$`));
    // P2: the contract's cmd_ and tok_ patterns
    expect(newId('cmd')).toMatch(/^cmd_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(newId('tok')).toMatch(/^tok_[0-9A-HJKMNP-TV-Z]{20}$/);
  });
  it('is unique', () => {
    const s = new Set(Array.from({ length: 1000 }, () => newId('cam')));
    expect(s.size).toBe(1000);
  });
  it('audit ids sort by time', () => {
    const a = auditId(1_000_000), b = auditId(2_000_000), c = auditId(1_791_273_600_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
    expect(a).toMatch(new RegExp(`^aud_${B32}{20}$`));
  });
  it('ulids are 26 characters and sort by time', () => {
    expect(ulid(5)).toMatch(new RegExp(`^${B32}{26}$`));
    expect(ulid(5) < ulid(6)).toBe(true);
  });
});

describe('enrollment codes', () => {
  it('look like CAE1-XXXX-XXXX-XXXX-XXXX-XXXX', () => {
    expect(newEnrollmentCode()).toMatch(new RegExp(`^CAE1(-${B32}{4}){5}$`));
  });
  it('normalise case, spaces and dashes', () => {
    expect(normaliseCode(' cae1 7q2m-k9xd 4hpa w3zt rn6b ')).toBe('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B');
  });
  it('map O to 0 and I, L to 1', () => {
    expect(normaliseCode('CAE1-OOOO-IIII-LLLL-0000-1111')).toBe('CAE1-0000-1111-1111-0000-1111');
  });
  it('refuse a wrong tag, a wrong length or U', () => {
    expect(normaliseCode('CAE2-7Q2M-K9XD-4HPA-W3ZT-RN6B')).toBeNull();
    expect(normaliseCode('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6')).toBeNull();
    expect(normaliseCode('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6BB')).toBeNull();
    expect(normaliseCode('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6U')).toBeNull();
    expect(normaliseCode(42 as unknown as string)).toBeNull();
  });
  it('hash the canonical form', () => {
    expect(codeHash('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B')).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B')).toBe(codeHash(normaliseCode('cae17q2mk9xd4hpaw3ztrn6b')!));
  });
});
