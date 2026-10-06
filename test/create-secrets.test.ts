import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';

// scripts/create-secrets.sh: an interrupted run (Ctrl-C, SIGTERM) while
// kubectl works must leave no temp file with secret values behind, and no
// value is ever printed.
describe('create-secrets.sh', () => {
  const dir = tmpDir();
  it.each(['oauth', 'runner'])('--only %s: SIGTERM mid-run leaves no secret temp file', async (only) => {
    const bin = join(dir, `bin-${only}`);
    const tmp = join(dir, `tmp-${only}`);
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nsleep 3\nexit 1\n');
    chmodSync(join(bin, 'kubectl'), 0o755);
    const env = join(dir, `env-${only}`);
    writeFileSync(env, 'ALLOWED_EMAILS=a@example.com\nGOOGLE_CLIENT_ID=id-VALUE-1\nGOOGLE_CLIENT_SECRET=secret-VALUE-2\nKUBE_CONTEXT=fake\nCAMSADMIN_GITHUB_PAT=pat-VALUE-3\n');
    chmodSync(env, 0o600);
    const p = spawn('bash', ['scripts/create-secrets.sh', '--env-file', env, '--only', only], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t0 = Date.now();
    while (readdirSync(tmp).length === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(tmp).length).toBe(1); // the secret temp file exists while kubectl runs
    p.kill('SIGTERM');
    await new Promise((r) => p.on('exit', r));
    expect(out).not.toMatch(/VALUE/);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
