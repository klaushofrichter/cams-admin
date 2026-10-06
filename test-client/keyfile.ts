import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';
import type { KeyFile } from './client';

// The proxy's key file (spec §9.2): folder 700, file 600, written atomically
// (random temp name + rename). Refused when group or others can read it.
export function writeKeyFile(path: string, k: KeyFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function readKeyFile(path: string): KeyFile {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`key file ${path} is readable by group or others (chmod 600)`);
  const k = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  if (k.v !== 1 || !k.proxyId || !k.keyId || !k.privateKey || !Array.isArray(k.serverKeys)) throw new Error(`key file ${path} is not a v1 key file`);
  return k;
}
