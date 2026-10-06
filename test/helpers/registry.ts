import { join } from 'path';
import { openDb } from '../../server/db/open';
import { Audit } from '../../server/audit';
import { Registry } from '../../server/registry';
import { fakeClock } from './clock';

let n = 0;
// A registry on a fresh database file (in `dir`, or at `o.file`) with a fake clock.
export function makeRegistry(dir: string, o: { file?: string; start?: number } = {}) {
  const dbFile = o.file ?? join(dir, `reg${n++}.db`);
  const db = openDb(dbFile);
  const clock = fakeClock(o.start);
  const audit = new Audit(db, clock);
  const reg = new Registry(db, clock, audit);
  const auditCount = () => (db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n;
  return { db, dbFile, clock, audit, reg, auditCount };
}
export const ACTOR = 'admin@example.com';
