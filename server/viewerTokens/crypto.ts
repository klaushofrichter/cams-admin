import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { log } from '../log';

// Viewer tokens (design 2026-11-05-viewer-tokens-design.md): the token, the
// fingerprint the viewers get, the sign-in link, and the encryption at rest.

export const VIEWER_TOKEN_PREFIX = 'cav_';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BODY = 22; // 22 × log2(62) ≈ 131 bits (Klaus: 120–130 bits, a small QR code)
export const VIEWER_TOKEN_RE = /^cav_[0-9A-Za-z]{22}$/;

// cav_ + 22 base62 characters; rejection sampling (bytes ≥ 248 are dropped) keeps every character equally likely.
export function newViewerToken(): string {
  let s = '';
  while (s.length < BODY) {
    for (const b of randomBytes(32)) {
      if (b < 248 && s.length < BODY) s += BASE62[b % 62];
    }
  }
  return VIEWER_TOKEN_PREFIX + s;
}

// What a viewer is sent instead of the token: a fast hash is enough for 131 random bits.
export const viewerFingerprint = (token: string): string =>
  'sha256:' + createHash('sha256').update(`cams-viewer-token v1\n${token}`, 'utf8').digest('hex');

// Klaus, 2026-11-05: the QR code and "Copy link" always use the cluster viewer.
export const DEFAULT_VIEWER_LINK_URL = 'https://cams.skylar.technology';
// At most 30 characters, so base + "/token#t=" + 26 stays ≤ 65 (a version 5 QR code at level M).
const MAX_BASE = 30;

export function viewerLinkBase(value: string | undefined): string {
  if (!value) return DEFAULT_VIEWER_LINK_URL;
  let u: URL;
  try { u = new URL(value); } catch { throw new Error('config: VIEWER_LINK_URL is not a URL'); }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password || u.origin.length > MAX_BASE) {
    throw new Error(`config: VIEWER_LINK_URL must be an https origin of at most ${MAX_BASE} characters (the QR code's size)`);
  }
  return u.origin;
}

// The token only in the fragment: never sent to the server, its logs or link previews.
export const viewerLink = (base: string, token: string): string => `${base}/token#t=${token}`;

// --- encryption at rest ----------------------------------------------------------------

export interface ViewerKey { key: Buffer; keyId: string }

// VIEWER_TOKEN_KEY_FILE: 32 random bytes as base64, mode 600 (like the signing key). Not set, or set to a
// file that doesn't exist (the cluster fills it from an optional Secret): null, the feature is off, one
// warning. An empty or malformed file, or one readable by group or others, stops the start.
let warnedMissing = false;
export function loadViewerKey(file: string | null, warn: (msg: string) => void = (m) => log.warn(m)): ViewerKey | null {
  if (!file) return null;
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (!warnedMissing) {
      warnedMissing = true;
      warn('viewer_token_key_missing');
    }
    return null;
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`viewer token key ${file} is readable by group or others (chmod 600)`);
  const text = readFileSync(file, 'utf8').trim();
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('viewer token key: must be 32 bytes as base64 (openssl rand -base64 32)');
  return { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 8) };
}

// "v1:<keyId>:<iv>:<ciphertext+tag>", AES-256-GCM, the row id as additional data (a ciphertext can't move rows).
export function sealToken(k: ViewerKey, rowId: string, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from(rowId, 'utf8'));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final(), c.getAuthTag()]);
  return `v1:${k.keyId}:${iv.toString('base64url')}:${ct.toString('base64url')}`;
}

// The token, or null (another key, another row, a changed byte, an unknown format).
export function openToken(k: ViewerKey, rowId: string, sealed: string): string | null {
  const p = sealed.split(':');
  if (p.length !== 4 || p[0] !== 'v1' || p[1] !== k.keyId) return null;
  try {
    const iv = Buffer.from(p[2], 'base64url');
    const all = Buffer.from(p[3], 'base64url');
    if (iv.length !== 12 || all.length < 17) return null;
    const d = createDecipheriv('aes-256-gcm', k.key, iv);
    d.setAAD(Buffer.from(rowId, 'utf8'));
    d.setAuthTag(all.subarray(all.length - 16));
    const out = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
    return VIEWER_TOKEN_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}
