import request from 'supertest';
import { join } from 'path';
import { buildServer, type Built } from '../../server/server';
import { generateKeyPair } from '../../server/crypto/ed25519';
import { writeFileSync, chmodSync } from 'fs';

let n = 0;
// The whole app (no listening socket) with a signed-in sysadmin.
export function testApp(dir: string, env: Record<string, string> = {}) {
  process.env.ALLOWED_EMAILS = 'admin@example.com';
  const keyFile = join(dir, `sk${n}.pem`);
  const { privateKeyPkcs8B64 } = generateKeyPair();
  writeFileSync(keyFile, `-----BEGIN PRIVATE KEY-----\n${privateKeyPkcs8B64}\n-----END PRIVATE KEY-----\n`);
  chmodSync(keyFile, 0o600);
  const built: Built = buildServer({ PUBLIC_URL: 'https://cams-admin.example.net', DB_FILE: join(dir, `app${n++}.db`), SERVER_SIGNING_KEY_FILE: keyFile, NODE_ENV: 'test', ...env });
  const cookie = `__Host-cams_admin=${built.sessions.create('admin@example.com').value}`;
  const api = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: unknown) => {
    const r = request(built.app)[method](`/api/v1${path}`).set('Cookie', cookie);
    if (method !== 'get') r.set('X-Cams-Admin', '1').set('Content-Type', 'application/json');
    return method === 'get' ? r : r.send(JSON.stringify(body ?? {}));
  };
  return { ...built, cookie, api, close: () => built.close() };
}
