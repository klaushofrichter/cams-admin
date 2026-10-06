// Prepares a fresh data folder and a signing key, then runs the built server
// (playwright.config.ts webServer).
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { generateKeyPairSync } from 'crypto';
import { spawn } from 'child_process';
import { join } from 'path';
import { DATA, ENV } from './env';

const fresh = process.argv.includes('--fresh');
if (fresh) rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const dir = process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : DATA;
mkdirSync(dir, { recursive: true });
const key = join(dir, 'signing.pem');
writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : ENV.PORT;
const env = { ...process.env, ...ENV, PORT: port, PUBLIC_URL: `http://localhost:${port}`, DB_FILE: join(dir, 'cams-admin.db'), SERVER_SIGNING_KEY_FILE: key };
const child = spawn(process.execPath, [join(__dirname, '../dist/server/server.js')], { env, stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (c) => process.exit(c ?? 0));
