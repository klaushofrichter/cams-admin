import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
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

  // --only viewer-key: a missing key file is made (mode 600, 32 bytes as base64), never printed, and applied as key=.
  async function viewerKey(fileContent: string | null, mode = 0o600, o: { exists?: boolean; rotate?: boolean } = {}) {
    const base = join(dir, `vk-${++n}`);
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    const args = join(base, 'kubectl-args');
    // `get secret`: found or not, as the test says; anything else just records its arguments.
    writeFileSync(join(bin, 'kubectl'), `#!/bin/sh\necho "$@" >> '${args}'\ncase "$*" in *" get secret "*) exit ${o.exists ? 0 : 1};; esac\ncat >/dev/null\n`);
    chmodSync(join(bin, 'kubectl'), 0o755);
    const key = join(base, 'viewer.key');
    if (fileContent !== null) { writeFileSync(key, fileContent); chmodSync(key, mode); }
    const env = join(base, 'env');
    writeFileSync(env, `KUBE_CONTEXT=fake\nVIEWER_TOKEN_KEY_FILE_LOCAL=${key}\n`);
    chmodSync(env, 0o600);
    const r = spawnSync('bash', ['scripts/create-secrets.sh', '--env-file', env, '--only', 'viewer-key', ...(o.rotate ? ['--rotate-viewer-key'] : [])], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    return { out: r.stdout + r.stderr, status: r.status, key, kubectl: existsSync(args) ? readFileSync(args, 'utf8') : '' };
  }

  it('--only viewer-key: makes a missing key file (mode 600, 32 bytes as base64), names it, never prints it, applies key=', async () => {
    const r = await viewerKey(null);
    expect(r.status).toBe(0);
    const value = readFileSync(r.key, 'utf8').trim();
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
    expect(statSync(r.key).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(r.key);
    expect(r.out).not.toContain(value);
    expect(r.kubectl).toContain('create secret generic cams-admin-viewer-token-key');
    expect(r.kubectl).toContain(`--from-file=key=${r.key}`);
  });

  it('--only viewer-key: an existing key is used as it is; a malformed or group-readable one is refused before kubectl', async () => {
    const good = (await viewerKey(Buffer.alloc(32, 7).toString('base64') + '\n'));
    expect(good.status).toBe(0);
    expect(readFileSync(good.key, 'utf8').trim()).toBe(Buffer.alloc(32, 7).toString('base64'));
    const short = await viewerKey(Buffer.alloc(16, 7).toString('base64'));
    expect(short.status).not.toBe(0);
    expect(short.out).toContain('32 bytes');
    expect(short.kubectl).not.toContain('create secret');
    const empty = await viewerKey('');
    expect(empty.status).not.toBe(0);
    const open = await viewerKey(Buffer.alloc(32, 7).toString('base64'), 0o644);
    expect(open.status).not.toBe(0);
    expect(open.out).toContain('chmod 600');
    expect(open.kubectl).not.toContain('create secret');
  });

  // Replacing the key makes every viewer token uncopyable (kube-setup, 2026-11-05):
  // an existing Secret is kept unless the rotation is asked for by name.
  it('--only viewer-key: an existing Secret is kept, and no key file is made; --rotate-viewer-key replaces it', async () => {
    const kept = await viewerKey(null, 0o600, { exists: true });
    expect(kept.status).toBe(0);
    expect(kept.out).toContain('already exists');
    expect(kept.out).toContain('--rotate-viewer-key');
    expect(kept.kubectl).not.toContain('create secret');
    expect(existsSync(kept.key)).toBe(false);
    const rotated = await viewerKey(null, 0o600, { exists: true, rotate: true });
    expect(rotated.status).toBe(0);
    expect(rotated.kubectl).toContain('create secret generic cams-admin-viewer-token-key');
    expect(existsSync(rotated.key)).toBe(true);
  });
});

