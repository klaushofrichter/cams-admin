// Viewer tokens (design 2026-11-05): the token format, the fingerprint the
// viewers get, the sign-in link and its QR size, and the encryption at rest.
import { describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import qrcode from 'qrcode-generator';
import { tmpDir } from './helpers/tmp';
import {
  DEFAULT_VIEWER_LINK_URL, VIEWER_TOKEN_RE, loadViewerKey, newViewerToken, openToken, sealToken, viewerFingerprint, viewerLink, viewerLinkBase,
} from '../server/viewerTokens/crypto';

const dir = tmpDir();
const keyFile = (name: string, content: string, mode = 0o600) => {
  const f = join(dir, name);
  writeFileSync(f, content);
  chmodSync(f, mode);
  return f;
};

describe('viewer token format', () => {
  it('is cav_ + 22 base62 characters (about 131 random bits)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = newViewerToken();
      expect(t).toMatch(/^cav_[0-9A-Za-z]{22}$/);
      expect(VIEWER_TOKEN_RE.test(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
    expect(22 * Math.log2(62)).toBeGreaterThan(130);
  });

  it('uses every base62 character, without a bias towards the first ones', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const c of newViewerToken().slice(4)) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(62);
    // 44 000 characters: about 710 each; a modulo bias would put the first 8 near 850.
    for (const [c, n] of counts) expect(n, c).toBeLessThan(820);
  });
});

describe('fingerprint and link', () => {
  it('fingerprint = sha256: + hex over "cams-viewer-token v1\\n" + token', () => {
    expect(viewerFingerprint('cav_0123456789abcdefABCDEF')).toBe('sha256:' + createHash('sha256').update('cams-viewer-token v1\ncav_0123456789abcdefABCDEF').digest('hex'));
    expect(viewerFingerprint('cav_0123456789abcdefABCDEF')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the production link is at most 65 characters and a version 5 QR code at level M (byte mode)', () => {
    const link = viewerLink(DEFAULT_VIEWER_LINK_URL, newViewerToken());
    expect(DEFAULT_VIEWER_LINK_URL).toBe('https://cams.skylar.technology');
    expect(link).toMatch(/^https:\/\/cams\.skylar\.technology\/token#t=cav_[0-9A-Za-z]{22}$/);
    expect(link.length).toBeLessThanOrEqual(65);
    const q = qrcode(0, 'M');
    q.addData(link, 'Byte');
    q.make();
    expect(q.getModuleCount()).toBe(37); // version 5: 17 + 4 × 5
  });

  it('VIEWER_LINK_URL: https origin only, short enough for version 5', () => {
    expect(viewerLinkBase(undefined)).toBe(DEFAULT_VIEWER_LINK_URL);
    expect(viewerLinkBase('https://cams.example.org/')).toBe('https://cams.example.org');
    for (const bad of ['http://cams.example.org', 'https://cams.example.org/x', 'https://cams.example.org?x', 'ftp://x', 'https://' + 'a'.repeat(40) + '.org']) {
      expect(() => viewerLinkBase(bad), bad).toThrow(/VIEWER_LINK_URL/);
    }
    for (const base of ['https://cams.example.org', 'https://' + 'a'.repeat(18) + '.org']) {
      const q = qrcode(0, 'M');
      q.addData(viewerLink(viewerLinkBase(base), newViewerToken()), 'Byte');
      q.make();
      expect(q.getModuleCount()).toBeLessThanOrEqual(37);
    }
  });
});

describe('encryption at rest', () => {
  const key = loadViewerKey(keyFile('k1', randomBytes(32).toString('base64') + '\n'))!;
  const other = loadViewerKey(keyFile('k2', randomBytes(32).toString('base64')))!;

  it('no file: no key (the feature is off, the server still starts)', () => {
    expect(loadViewerKey(null)).toBeNull();
  });

  it('a set path whose file does not exist (yet): no key and one warning; the cluster fills it from an optional Secret', () => {
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    expect(loadViewerKey(join(dir, 'missing.key'), warn)).toBeNull();
    expect(loadViewerKey(join(dir, 'missing.key'), warn)).toBeNull();
    expect(warnings).toEqual(['viewer_token_key_missing']);
  });

  it('an empty file is an error at start, not "off"', () => {
    expect(() => loadViewerKey(keyFile('empty', ''))).toThrow(/32 bytes/);
  });

  it('a 0600 file passes whoever owns it (the pod runs as uid 1000)', () => {
    const f = keyFile('k600', randomBytes(32).toString('base64'), 0o600);
    expect(loadViewerKey(f)?.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(loadViewerKey(keyFile('k400', randomBytes(32).toString('base64'), 0o400))?.keyId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('refuses a file readable by others, and a key that is not 32 bytes', () => {
    expect(() => loadViewerKey(keyFile('k3', randomBytes(32).toString('base64'), 0o644))).toThrow(/chmod 600/);
    expect(() => loadViewerKey(keyFile('k4', randomBytes(16).toString('base64')))).toThrow(/32 bytes/);
    expect(() => loadViewerKey(keyFile('k5', 'not base64 at all!'))).toThrow(/32 bytes/);
  });

  it('round trip; another key, another row or a changed byte reads as null', () => {
    const t = newViewerToken();
    const sealed = sealToken(key, 'vtk_A', t);
    expect(sealed).toMatch(new RegExp(`^v1:${key.keyId}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$`));
    expect(sealed).not.toContain(t.slice(4));
    expect(openToken(key, 'vtk_A', sealed)).toBe(t);
    expect(openToken(other, 'vtk_A', sealed)).toBeNull();
    expect(openToken(key, 'vtk_B', sealed)).toBeNull();
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 1;
    expect(openToken(key, 'vtk_A', [...parts.slice(0, 3), ct.toString('base64url')].join(':'))).toBeNull();
    expect(openToken(key, 'vtk_A', 'garbage')).toBeNull();
    expect(sealToken(key, 'vtk_A', t)).not.toBe(sealed); // a fresh IV each time
  });
});
