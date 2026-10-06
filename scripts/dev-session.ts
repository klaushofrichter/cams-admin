// npm run dev:session -- <email>: inserts a sysadmin session straight into
// the local database file and prints the cookie value (for the local stack,
// the load test and the e2e). The server has no such route. Refuses unless
// NODE_ENV=development, PUBLIC_URL is loopback, and the email is allowlisted.
import { openDb } from '../server/db/open';
import { Sessions, sysadminAllowed } from '../server/auth/session';
import { normaliseEmail } from '../server/validate';
import { systemClock } from '../server/clock';

function fail(msg: string): never {
  process.stderr.write(`dev-session: ${msg}\n`);
  process.exit(1);
}

if (process.env.NODE_ENV !== 'development') fail('NODE_ENV must be development');
let host: string;
try {
  host = new URL(process.env.PUBLIC_URL ?? '').hostname;
} catch {
  fail('PUBLIC_URL is not a URL');
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) fail('PUBLIC_URL must be loopback');
const email = normaliseEmail(process.argv[2] ?? '');
if (!sysadminAllowed(email)) fail('the email is not in SYSADMIN_EMAILS');
const db = openDb(process.env.DB_FILE ?? fail('DB_FILE is required'));
process.stdout.write(new Sessions(db, systemClock).create(email).value + '\n');
db.close();
