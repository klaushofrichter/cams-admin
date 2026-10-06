import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, statSync } from 'fs';
import { join } from 'path';
import { loadSigningKey } from '../server/crypto/signingKey';
import { tmpDir } from './helpers/tmp';

describe('the signing key', () => {
  const dir = tmpDir();
  it('gen-signing-key writes a mode-600 PKCS#8 PEM and prints only the fingerprint; the server loads it', () => {
    const f = join(dir, 'k.pem');
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-signing-key.ts', f], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/^SHA256:[0-9A-F]{64}$/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadSigningKey(f).fingerprint).toBe(out.trim());
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-signing-key.ts', f], { stdio: 'pipe' })).toThrow();
  });
  it('the server refuses a key file readable by group or others, and a missing setting', () => {
    const f = join(dir, 'g.pem');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-signing-key.ts', f]);
    chmodSync(f, 0o640);
    expect(() => loadSigningKey(f)).toThrow(/readable by group or others/);
    expect(() => loadSigningKey(null)).toThrow(/SERVER_SIGNING_KEY_FILE is required/);
  });
});
