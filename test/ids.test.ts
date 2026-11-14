import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { auditId, codeHash, newCamsEnrollmentCode, newEnrollmentCode, newId, normaliseCamsCode, normaliseCode, sha256Hex, ulid, ulidTime } from '../server/ids';
import { fingerprint, sha256hex } from '../server/crypto/ed25519';
import { hashOf } from '../server/auth/bearer-tokens';
import { generateToken } from '../server/tokens/service';

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
  it('ulidTime reads the time back; null for anything that is no ULID', () => {
    expect(ulidTime(ulid(1_794_265_638_123))).toBe(1_794_265_638_123);
    expect(ulidTime('01K6000000000000000000000A')).toBe(ulidTime('01K60000000000000000000000'));
    expect(ulidTime('rq-1')).toBeNull();
    expect(ulidTime('01K6000000000000000000000I')).toBeNull();
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

describe('cams enrollment codes (P4)', () => {
  it('are CAC1 codes, normalised like proxy codes, and never accepted for the other kind', () => {
    expect(newCamsEnrollmentCode()).toMatch(/^CAC1(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(normaliseCamsCode(' cac1-abcd-efgh-jkmn-pqrs-tvwx ')).toBe('CAC1-ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(normaliseCamsCode('cac1 abcd efgh jkmn pqrs tvwo')).toBe('CAC1-ABCD-EFGH-JKMN-PQRS-TVW0');
    expect(normaliseCamsCode(newEnrollmentCode())).toBeNull();
    expect(normaliseCode(newCamsEnrollmentCode())).toBeNull();
    expect(normaliseCode('CAE1-ABCD-EFGH-JKMN-PQRS-TVWX')).toBe('CAE1-ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(newId('cms')).toMatch(/^cms_[0-9A-HJKMNP-TV-Z]{20}$/);
  });
});
});

describe('the shared hash helpers', () => {
  it('sha256Hex hashes a string as UTF-8 and a Buffer as its bytes, and ed25519.sha256hex is the same function', () => {
    const want = createHash('sha256').update('ä-x', 'utf8').digest('hex');
    expect(sha256Hex('ä-x')).toBe(want);
    expect(sha256Hex(Buffer.from('ä-x', 'utf8'))).toBe(want);
    expect(sha256hex).toBe(sha256Hex);
  });
  it('a proxy token is stored in the bearer-token hash format', () => {
    const { token, hash } = generateToken();
    expect(hash).toBe(hashOf(token));
    expect(hash).toBe(`sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`);
  });
  it('fingerprint is SHA256: and upper-case hex over the SPKI bytes', () => {
    const spki = Buffer.from('spki-bytes').toString('base64');
    expect(fingerprint(spki)).toBe(`SHA256:${createHash('sha256').update(Buffer.from('spki-bytes')).digest('hex').toUpperCase()}`);
  });
});
