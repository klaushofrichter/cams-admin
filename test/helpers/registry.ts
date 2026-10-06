import { join } from 'path';
import { openDb } from '../../server/db/open';
import { Audit } from '../../server/audit';
import { Registry } from '../../server/registry';
import { fakeClock } from './clock';

let n = 0;
export function makeRegistry(dir: string) {
  const db = openDb(join(dir, `reg${n++}.db`));
  const clock = fakeClock();
  const audit = new Audit(db, clock);
  const reg = new Registry(db, clock, audit);
  const auditCount = () => (db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
  return { db, clock, audit, reg, auditCount };
}
export const ACTOR = 'admin@example.com';
