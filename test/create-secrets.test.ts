import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpDir } from './helpers/tmp';

// scripts/create-secrets.sh: an interrupted run (Ctrl-C, SIGTERM) must leave
// no temp file with secret values behind, and no value is ever printed.
// Stubs on PATH hold the script at the moment under test; the signal is sent
// once the secret temp directory exists, and the check runs after the
// script has exited.
describe('create-secrets.sh', () => {
  const dir = tmpDir();
  const real = (cmd: string) => execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim();
  let n = 0;

  async function interrupted(only: string, stubs: Record<string, string>) {
    const base = join(dir, `run-${++n}`);
    const bin = join(base, 'bin');
    const tmp = join(base, 'tmp');
    mkdirSync(bin, { recursive: true });
    mkdirSync(tmp);
    const applied = join(base, 'kubectl-ran');
    for (const [name, body] of Object.entries({ kubectl: `touch '${applied}'\nsleep 3`, ...stubs })) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const env = join(base, 'env');
    writeFileSync(env, 'ALLOWED_EMAILS=a@example.com\nGOOGLE_CLIENT_ID=id-VALUE-1\nGOOGLE_CLIENT_SECRET=secret-VALUE-2\nKUBE_CONTEXT=fake\nCAMSADMIN_GITHUB_PAT=pat-VALUE-3\n');
    chmodSync(env, 0o600);
    const p = spawn('bash', ['scripts/create-secrets.sh', '--env-file', env, '--only', only], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const exited = new Promise((r) => p.on('exit', r));
    const t0 = Date.now();
    while (readdirSync(tmp).length === 0 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(tmp)).toHaveLength(1); // the secret temp directory exists
    p.kill('SIGTERM');
    await exited;
    return { out, left: readdirSync(tmp), applied: existsSync(applied) };
  }

  it.each(['oauth', 'runner'])('--only %s: SIGTERM while kubectl runs leaves no secret temp file', async (only) => {
    const r = await interrupted(only, {});
    expect(r.out).not.toMatch(/VALUE/);
    expect(r.left).toEqual([]);
  });

  // Issue #114: the file existed before the script knew its name.
  it('SIGTERM while mktemp makes the temp directory leaves nothing and applies nothing', async () => {
    const r = await interrupted('runner', { mktemp: `out=$('${real('mktemp')}' "$@") || exit 1\nsleep 2\necho "$out"` });
    expect(r.left).toEqual([]);
    expect(r.applied).toBe(false);
  });

  // Issue #114: exit inside the trap while bash read a $(…) dropped the cleanup.
  it('SIGTERM while a value is read after the temp file exists leaves nothing and applies nothing', async () => {
    const r = await interrupted('runner', { awk: `[ -z "$(ls "$TMPDIR")" ] || sleep 2\nexec '${real('awk')}' "$@"` });
    expect(r.out).not.toMatch(/VALUE/);
    expect(r.left).toEqual([]);
    expect(r.applied).toBe(false);
  });
});
