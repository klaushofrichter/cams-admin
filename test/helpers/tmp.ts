import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll } from 'vitest';

// A temporary folder removed after the file.
export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cams-admin-test-'));
  afterAll(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
