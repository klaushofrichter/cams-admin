// A reference implementation of the proxy-side command check, written from
// the contract text only ("The P2 contract", check order 1–12, in
// docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md). It must not
// import cam-proxy code or server/ code other than crypto: it is the second
// implementation the fixtures are checked against. Step 9 (rate limits) is
// cam-proxy's and is left out here.
import { createHash } from 'crypto';
import { publicFromB64, verifyEnvelope } from '../server/crypto/ed25519';

export interface CheckContext {
  now: number; // cams-admin time: Date.now() + the offset learned from the challenge
  proxyId: string;
  connId: string;
  serverKeys: string[];
  allow: string[];
  paused: boolean;
  seen: Set<string>;
  journal?: Map<string, object>;
  running?: boolean;
}
export type CheckVerdict = { kind: 'run' } | { kind: 'duplicate' } | { kind: 'bad_message' } | { kind: 'nack'; code: string };

const ULID20 = '[0-9A-HJKMNP-TV-Z]{20}';
const CMD_RE = new RegExp(`^cmd_${ULID20}$`);
const TOK_RE = new RegExp(`^tok_${ULID20}$`);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
// What this version implements (P2): tokens.apply.
const IMPLEMENTED = ['tokens.apply'];

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
  if (ctx.journal?.has(b.cmdId)) return { kind: 'duplicate' };
  // 7. the env switch or a pause
  if (ctx.paused) return nack('paused');
  // 8. implemented and allowed
  if (typeof b.command !== 'string' || !IMPLEMENTED.includes(b.command) || !ctx.allow.includes(b.command)) return nack('not_allowed');
  // 9. rate limits: cam-proxy's (not in the reference)
  // 10. args version, then the command's strict args
  if (!isObj(b.args) || b.args.v !== 1) return nack('unsupported_version');
  if (!tokensApplyArgsOk(b.args)) return nack('invalid_args');
  // 11. allow entries the args need
  if (b.args.tokens.some((t: { kind: string }) => t.kind === 'admin') && !ctx.allow.includes('tokens.apply.admin')) return nack('not_allowed');
  // 12. one at a time
  if (ctx.running) return nack('busy');
  return { kind: 'run' };
}

export const tokenHash = (token: string): string => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
