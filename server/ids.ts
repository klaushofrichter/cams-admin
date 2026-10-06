import { createHash, randomBytes } from 'crypto';

// Crockford base32 (no I, L, O, U).
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(n: number): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i] & 31];
  return s;
}

function timeChars(ms: number): string {
  let s = '';
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    s = CROCKFORD[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}

export type IdPrefix = 'acc' | 'usr' | 'prx' | 'cam' | 'key' | 'enr' | 'con';
// About 100 random bits: 20 characters of 5 bits.
export const newId = (prefix: IdPrefix): string => `${prefix}_${randomChars(20)}`;
// Sortable: 10 time characters (ms) + 10 random.
export const auditId = (now: number): string => `aud_${timeChars(now)}${randomChars(10)}`;
// A ULID-shaped id (26 characters) for envelope ids.
export const ulid = (now: number): string => timeChars(now) + randomChars(16);

const CODE_TAG = 'CAE1';
const group = (body: string) => body.match(/.{4}/g)!.join('-');
export const newEnrollmentCode = (): string => `${CODE_TAG}-${group(randomChars(20))}`;

// Case-insensitive, ignores dashes and spaces; Crockford's O→0, I/L→1.
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s.startsWith(CODE_TAG)) return null;
  const body = s.slice(CODE_TAG.length);
  if (!new RegExp(`^[${CROCKFORD}]{20}$`).test(body)) return null;
  return `${CODE_TAG}-${group(body)}`;
}

// 100 bits of entropy: a fast hash is enough.
export const codeHash = (canonical: string): string => createHash('sha256').update(canonical).digest('hex');
