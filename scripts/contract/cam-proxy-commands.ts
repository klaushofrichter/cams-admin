// The P2 contract cross-check: cam-proxy's real command check
// (src/fleet/command-check.ts) and canonical JSON (src/fleet/jcs.ts), from a
// cam-proxy checkout, against every proxy-side command fixture and every
// vectors.json jcs/envelope case. Any difference fails. Before cam-proxy has
// a command check on main, it prints a notice and passes. A fixture whose
// command cam-proxy does not implement yet, and whose verdict differs, is
// `pending` (not a failure) while the repos are out of step (P3 contract).
//   tsx scripts/contract/cam-proxy-commands.ts <cam-proxy checkout>
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import vectors from '../../contract/v1/vectors.json';

const root = resolve(process.argv[2] ?? '');
const file = (p: string) => join(root, p);
if (!existsSync(file('src/fleet/command-check.ts'))) {
  console.log('notice: cam-proxy has no src/fleet/command-check.ts yet: commands cross-check skipped');
  process.exit(0);
}
/* eslint-disable @typescript-eslint/no-require-imports */
const { checkCommand, CommandLimits, SeenIds, journalBudgetOf } = require(file('src/fleet/command-check.ts'));
const { IMPLEMENTED } = require(file('src/fleet/policy.ts'));
const { jcs } = require(file('src/fleet/jcs.ts'));
/* eslint-enable @typescript-eslint/no-require-imports */

let failed = 0;
let pending = 0;
const report = (ok: boolean, name: string, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok   ' : 'DRIFT'} ${name}${ok ? '' : `: ${detail}`}`);
};

for (const c of vectors.jcs) {
  const got = jcs(c.input);
  report(got === c.text, `jcs ${c.name}`, JSON.stringify(got));
}
for (const e of vectors.envelopes) {
  const got = jcs(e.envelope);
  report(got === e.text, `jcs envelope ${e.kind}`, JSON.stringify(got));
}

interface JournalEntry { cmdId: string; command: string; at: number; action?: string }
interface Ctx { now: number; proxyId: string; connId: string; serverKeys: string[]; allow: string[]; paused: boolean; seen: string[]; enabled?: boolean; tokens?: object[]; journal?: JournalEntry[] }
const implemented = (c: string) => (IMPLEMENTED instanceof Set ? IMPLEMENTED.has(c) : (IMPLEMENTED as string[]).includes(c));
// $context.journal as cam-proxy's Journal.countSince(pred, sinceMs) → {n, oldest}.
const countSince = (entries: JournalEntry[]) => (pred: (e: JournalEntry) => boolean, sinceMs: number) => {
  const hits = entries.filter((e) => e.at >= sinceMs && pred(e));
  return { n: hits.length, oldest: hits.length ? Math.min(...hits.map((e) => e.at)) : null };
};
const P3 = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'];
const P3_STARTED = P3.some(implemented);
const DIR = join(__dirname, '../../contract/v1/fixtures');
const ctxOf = (c: Ctx, journal: (id: string) => unknown = () => undefined) => {
  const seen = new SeenIds();
  for (const id of c.seen ?? []) seen.add(id, c.now);
  return { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: c.enabled !== false, paused: !!c.paused, allow: c.allow ?? [] }, journal, limits: new CommandLimits(() => c.now), implemented: IMPLEMENTED, currentTokens: c.tokens ?? [],
    ...(typeof journalBudgetOf === 'function' ? { journalBudget: journalBudgetOf(countSince(c.journal ?? []), c.now) } : {}) };
};
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
const cmds = fixtures.filter((f) => f.schema === 'command' && f.$context);
report(cmds.length >= 17, 'command fixtures present', String(cmds.length));
for (const f of cmds) {
  const want = f.name.startsWith('valid-') ? 'run' : f.$expect.runtime;
  let got: string;
  try {
    const d = checkCommand(f.message, ctxOf(f.$context));
    got = d.kind === 'nack' ? d.code : d.kind;
  } catch (e) {
    got = `threw ${(e as Error).message}`;
  }
  // pending only while cam-proxy implements no P3 command at all: once it has
  // one, every P3 fixture must match (a forgotten IMPLEMENTED entry is drift).
  if (got !== want && !implemented(f.message.body.command) && !P3_STARTED) {
    pending++;
    console.log(`pending ${f.name} (cam-proxy does not implement ${f.message.body.command} yet)`);
    continue;
  }
  report(got === want, f.name, `cam-proxy says ${got}, the contract ${want}`);
}
if (pending) console.log(`${pending} fixture(s) pending until cam-proxy implements them`);
// Step 6 before step 7: a journaled cmdId is a duplicate even when paused.
const v = fixtures.find((f) => f.name === 'valid-command-tokens-apply');
if (v) {
  const d = checkCommand(v.message, ctxOf({ ...v.$context, paused: true }, (id) => (id === v.message.body.cmdId ? { cmdId: id, command: 'tokens.apply', actor: 'a', at: 1, status: 'ok' } : undefined)));
  report(d.kind === 'duplicate', 'journal before pause', d.kind);
}
process.exit(failed ? 1 : 0);
