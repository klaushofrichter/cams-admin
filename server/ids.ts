import { createHash, randomBytes } from 'crypto';

// Crockford base32 (no I, L, O, U).
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(n: number): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i] & 31];
  return s;
}

// n as `len` Crockford characters, most significant first.
function fixedChars(n: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s = CROCKFORD[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return s;
}
const timeChars = (ms: number): string => fixedChars(Math.max(0, Math.floor(ms)), 10);

export type IdPrefix = 'acc' | 'usr' | 'prx' | 'cam' | 'key' | 'enr' | 'con' | 'cmd' | 'tok';
// About 100 random bits: 20 characters of 5 bits.
export const newId = (prefix: IdPrefix): string => `${prefix}_${randomChars(20)}`;
// Sortable: 10 time characters (ms) + 5 sequence characters (monotonic
// within one ms in this process) + 5 random.
let lastMs = -1;
let seq = 0;
export function auditId(now: number): string {
  if (now === lastMs) seq++;
  else {
    lastMs = now;
    seq = 0;
  }
  return `aud_${timeChars(now)}${fixedChars(seq, 5)}${randomChars(5)}`;
}
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

export const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');
// 100 bits of entropy: a fast hash is enough.
export const codeHash = sha256Hex;
