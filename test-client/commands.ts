// A reference implementation of the proxy-side command check, written from
// the contract text only ("The P2 contract", check order 1–12, in
// docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md, and "The P3
// contract" in docs/superpowers/plans/2026-10-07-migration-p3-cams-admin.md). It must not
// import cam-proxy code or server/ code other than crypto: it is the second
// implementation the fixtures are checked against. Step 9 (rate limits) is
// cam-proxy's and is left out here.
import { createHash } from 'crypto';
import { publicFromB64, verifyEnvelope } from '../server/crypto/ed25519';
import { CAMERA_NAME_PATTERN, DISRUPTIVE_ACTIONS, NEVER_REMOTE_ACTIONS, P3_COMMANDS, PATH_PATTERN, REMOTE_ACTIONS } from '../contract/build';

export interface CheckContext {
  now: number; // cams-admin time: Date.now() + the offset learned from the challenge
  proxyId: string;
  connId: string;
  serverKeys: string[];
  allow: string[];
  paused: boolean;
  seen: Set<string>;
  answered?: Map<string, object>; // step 6: cmdIds already journaled (the stored answer)
  journal?: JournalEntry[]; // step 11: the journal entries the budget counts (P3 $context.journal)
  running?: boolean;
  enabled?: boolean; // the env kill switch (default on)
  tokens?: { id: string; kind: string; hash: string; label: string; retireAt: number | null }[]; // the current managed set
}
export interface JournalEntry { cmdId: string; command: string; at: number; action?: string }
export type CheckVerdict = { kind: 'run' } | { kind: 'duplicate' } | { kind: 'bad_message' } | { kind: 'nack'; code: string; retryAfterS?: number };

const ULID20 = '[0-9A-HJKMNP-TV-Z]{20}';
const CMD_RE = new RegExp(`^cmd_${ULID20}$`);
const TOK_RE = new RegExp(`^tok_${ULID20}$`);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
// What this version implements: tokens.apply (P2) and the P3 commands.
export const IMPLEMENTED: readonly string[] = ['tokens.apply', ...P3_COMMANDS];
const PATH_RE = new RegExp(PATH_PATTERN);
const REV_RE = /^sha256:[0-9a-f]{64}$/;
const CAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_RE = new RegExp(CAMERA_NAME_PATTERN, 'u');
const HOUR = 3_600_000;

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);

// tokens.apply args v1, strictly (closed objects).
export function tokensApplyArgsOk(a: unknown): boolean {
  if (!isObj(a)) return false;
  if (Object.keys(a).some((k) => !['v', 'revision', 'tokens'].includes(k))) return false;
  if (a.v !== 1 || !isInt(a.revision) || a.revision < 1 || !Array.isArray(a.tokens) || a.tokens.length > 64) return false;
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const t of a.tokens) {
    if (!isObj(t) || Object.keys(t).length !== 5) return false;
    if (typeof t.id !== 'string' || !TOK_RE.test(t.id)) return false;
    if (t.kind !== 'client' && t.kind !== 'admin') return false;
    if (typeof t.hash !== 'string' || !HASH_RE.test(t.hash)) return false;
    if (typeof t.label !== 'string' || !LABEL_RE.test(t.label)) return false;
    if (!(t.retireAt === null || (isInt(t.retireAt) && t.retireAt >= 0))) return false;
    ids.add(t.id);
    hashes.add(t.hash);
  }
  return ids.size === a.tokens.length && hashes.size === a.tokens.length;
}

const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const leaf = (x: unknown) => typeof x === 'boolean' || isInt(x) || (typeof x === 'string' && x.length <= 512);
const isPath = (x: unknown): x is string => typeof x === 'string' && PATH_RE.test(x);

// The P3 args v1, strictly (closed objects); a.v === 1 is checked before.
export function p3ArgsOk(command: string, a: Record<string, any>): boolean {
  switch (command) {
    case 'config.get':
    case 'proxy.restart':
      return only(a, ['v']);
    case 'config.set': {
      if (!only(a, ['v', 'dryRun', 'baseRevision', 'set']) || typeof a.dryRun !== 'boolean' || typeof a.baseRevision !== 'string' || !REV_RE.test(a.baseRevision) || !isObj(a.set)) return false;
      const e = Object.entries(a.set);
      return e.length >= 1 && e.length <= 64 && e.every(([p, x]) => isPath(p) && leaf(x));
    }
    case 'config.unset':
      return only(a, ['v', 'dryRun', 'baseRevision', 'paths']) && typeof a.dryRun === 'boolean' && typeof a.baseRevision === 'string' && REV_RE.test(a.baseRevision)
        && Array.isArray(a.paths) && a.paths.length >= 1 && a.paths.length <= 64 && a.paths.every(isPath) && new Set(a.paths).size === a.paths.length;
    case 'config.rollback':
      return only(a, ['v', 'dryRun', 'cmdId']) && typeof a.dryRun === 'boolean' && typeof a.cmdId === 'string' && CMD_RE.test(a.cmdId);
    case 'camera.action': {
      if (!only(a, ['v', 'camera', 'action', 'input'])) return false;
      if (typeof a.action !== 'string' || ![...REMOTE_ACTIONS, ...NEVER_REMOTE_ACTIONS].includes(a.action as never)) return false;
      if (a.action === 'retention-run' ? a.camera !== null : typeof a.camera !== 'string' || !CAM_RE.test(a.camera)) return false;
      if (a.input === undefined) return true;
      return a.action === 'inventory' && isObj(a.input) && only(a.input, ['kind', 'camera']) && typeof a.input.kind === 'string' && a.input.kind.length >= 1 && a.input.kind.length <= 32
        && (a.input.camera === undefined || typeof a.input.camera === 'boolean');
    }
    case 'camera.name.set':
      return only(a, ['v', 'camera', 'name']) && typeof a.camera === 'string' && CAM_RE.test(a.camera) && typeof a.name === 'string' && NAME_RE.test(a.name);
  }
  return false;
}

const isDisruptive = (a: string | undefined) => (DISRUPTIVE_ACTIONS as readonly string[]).includes(a ?? '');
// Step 11's journal budget: proxy.restart ≤ 2 an hour, disruptive camera actions ≤ 6 an hour (any status).
export function journalBudget(journal: JournalEntry[], now: number, command: string, action?: string): { ok: true } | { ok: false; retryAfterS: number } {
  const counted = journal.filter((e) => e.at > now - HOUR && (command === 'proxy.restart' ? e.command === 'proxy.restart' : e.command === 'camera.action' && isDisruptive(e.action)));
  const cap = command === 'proxy.restart' ? 2 : 6;
  if (counted.length < cap) return { ok: true };
  const oldest = Math.min(...counted.map((e) => e.at));
  return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + HOUR - now) / 1000)) };
}

// Every entry of the new set is in the current set, unchanged.
export function isRevocation(next: Record<string, unknown>[], current: { id: string; kind: string; hash: string; label: string; retireAt: number | null }[]): boolean {
  return next.every((t) => current.some((c) => c.id === t.id && c.kind === t.kind && c.hash === t.hash && c.label === t.label && c.retireAt === t.retireAt));
}

export function refCheck(m: Record<string, any>, ctx: CheckContext): CheckVerdict {
  const nack = (code: string): CheckVerdict => ({ kind: 'nack', code });
  // 1. a readable cmdId
  const b = isObj(m) ? m.body : undefined;
  if (!isObj(b) || typeof b.cmdId !== 'string' || !CMD_RE.test(b.cmdId)) return { kind: 'bad_message' };
  // 2. signed by one of the pinned server keys
  const signedOk = ctx.serverKeys.some((k) => {
    try {
      return verifyEnvelope(publicFromB64(k), m);
    } catch {
      return false;
    }
  });
  if (!signedOk) return nack('bad_signature');
  // 3. for this proxy and this connection
  if (b.proxyId !== ctx.proxyId || b.connId !== ctx.connId) return nack('wrong_target');
  // 4. the envelope id is new on this connection (then recorded)
  if (ctx.seen.has(m.id)) return nack('replayed');
  ctx.seen.add(m.id);
  // 5. exp: an integer, 1 ≤ exp − ts ≤ 60 s, and not more than 120 s in the past
  if (!isInt(b.exp) || !isInt(m.ts) || b.exp - m.ts < 1 || b.exp - m.ts > 60_000 || b.exp + 120_000 < ctx.now) return nack('expired');
  // 6. already journaled: the stored answer, nothing runs
  if (ctx.answered?.has(b.cmdId)) return { kind: 'duplicate' };
  // A claimed revocation (tokens.apply only) skips the pause, the allow-list
  // and the admin entry; the claim is verified at step 10.
  const revocation = b.revocationOnly === true && b.command === 'tokens.apply';
  // 7. the env switch, or a pause
  if (ctx.enabled === false) return nack('paused');
  if (ctx.paused && !revocation) return nack('paused');
  // 8. implemented and allowed (camera.action: any camera.action:* entry)
  if (typeof b.command !== 'string' || !IMPLEMENTED.includes(b.command)) return nack('not_allowed');
  const entryOk = b.command === 'camera.action' ? ctx.allow.some((e) => e.startsWith('camera.action:')) : ctx.allow.includes(b.command);
  if (!revocation && !entryOk) return nack('not_allowed');
  // 9. rate limits: cam-proxy's (not in the reference)
  // 10. args version, then the command's strict args (and a revocation claim)
  if (!isObj(b.args) || b.args.v !== 1) return nack('unsupported_version');
  if (b.command === 'tokens.apply') {
    if (!tokensApplyArgsOk(b.args)) return nack('invalid_args');
    if (revocation && !isRevocation(b.args.tokens, ctx.tokens ?? [])) return nack('invalid_args');
    // 11. allow entries the args need
    if (!revocation && b.args.tokens.some((t: { kind: string }) => t.kind === 'admin') && !ctx.allow.includes('tokens.apply.admin')) return nack('not_allowed');
  } else {
    if (!p3ArgsOk(b.command, b.args)) return nack('invalid_args');
    // 11. the action's own entry (never a never-remote one), then the journal budget
    const action: string | undefined = b.command === 'camera.action' ? b.args.action : undefined;
    if (action !== undefined && ((NEVER_REMOTE_ACTIONS as readonly string[]).includes(action) || !ctx.allow.includes(`camera.action:${action}`))) return nack('not_allowed');
    if (b.command === 'proxy.restart' || isDisruptive(action)) {
      const budget = journalBudget(ctx.journal ?? [], ctx.now, b.command, action);
      if (!budget.ok) return { kind: 'nack', code: 'rate_limited', retryAfterS: budget.retryAfterS };
    }
  }
  // 12. one at a time
  if (ctx.running) return nack('busy');
  return { kind: 'run' };
}

export const tokenHash = (token: string): string => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
