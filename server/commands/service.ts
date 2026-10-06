import type { Clock } from '../clock';
import type { Db } from '../db/open';
import { tx } from '../db/open';
import type { Audit } from '../audit';
import { ApiError, type Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { LiveHub } from '../live';
import type { Logger } from '../log';
import type { Envelope } from '../contract';
import { sanitize, validateCommandArgs, validateResultPayload } from '../contract';
import { verifyEnvelope } from '../crypto/ed25519';
import { newId } from '../ids';
import { Buckets } from '../channel/limits';
import { CLOSE, type Connection } from '../channel/connection';
import type { Hub } from '../channel/hub';
import { sendCommand } from './envelope';

// Signed commands to the connected proxies (migration spec §7; plan Task 5):
// a queue in the database, one command in flight per proxy, re-sent with the
// same cmdId (the proxy's idempotency key) after 10 s without `received`
// and on the next connection when `received` came without `done`; given up
// after 15 min (expired: never sent; unknown: sent, no final answer). The
// proxy's final signed result is stored verbatim as the evidence (R2-12).
// Writes only on state changes (the S3 cost rule).

export const RESEND_AFTER_MS = 10_000;
export const GIVE_UP_AFTER_MS = 15 * 60_000;
const DROPS_BEFORE_CLOSE = 20;
const OPEN = `('queued','sent','received')`;
const FINAL = ['done', 'refused', 'failed', 'expired'];

export type CommandState = 'queued' | 'sent' | 'received' | 'done' | 'refused' | 'failed' | 'expired' | 'unknown';
export type WireCommand = 'tokens.apply';
export interface CommandRow {
  id: string; accountId: string; proxyId: string | null; actor: string; command: string; args: Record<string, unknown>; state: CommandState;
  outcomeCode: string | null; result: Record<string, unknown> | null; createdAt: number; sentAt: number | null; finishedAt: number | null; attempts: number;
}
interface Raw extends CommandRow { rawArgs: Record<string, unknown>; envelope: Record<string, unknown> | null }

export interface CommandsDeps {
  db: Db; clock: Clock; audit: Audit; registry: Registry; status: StatusStore; live: LiveHub; log: Logger; hub: () => Hub; perProxyPerMin?: number;
}

type DbRow = Record<string, unknown>;

// What a person may see of a command's args: never a full hash (8 hex digits).
export function summariseArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  if (command !== 'tokens.apply') return { v: args.v };
  const tokens = Array.isArray(args.tokens) ? (args.tokens as Record<string, unknown>[]) : [];
  return {
    v: args.v, revision: args.revision, count: tokens.length,
    tokens: tokens.slice(0, 20).map((t) => ({ id: t.id, kind: t.kind, label: t.label, retireAt: t.retireAt ?? null, hashPrefix: String(t.hash).slice(0, 15) })),
  };
}

// The allow entries a command's args need on the proxy.
export function requiredEntries(command: string, args: Record<string, unknown>): string[] {
  if (command === 'tokens.apply') {
    const tokens = Array.isArray(args.tokens) ? (args.tokens as { kind?: unknown }[]) : [];
    return ['tokens.apply', ...(tokens.some((t) => t?.kind === 'admin') ? ['tokens.apply.admin'] : [])];
  }
  return [command];
}

function toRaw(r: DbRow): Raw {
  const envelope = r.result ? (JSON.parse(r.result as string) as Record<string, unknown>) : null;
  const body = (envelope?.body ?? null) as Record<string, unknown> | null;
  const rawArgs = JSON.parse(r.args as string) as Record<string, unknown>;
  const result = body && typeof body.result === 'object' && body.result !== null && !Array.isArray(body.result) ? (sanitize(body.result) as Record<string, unknown>) : null;
  return {
    id: r.id as string, accountId: r.account_id as string, proxyId: r.proxy_id as string | null, actor: r.actor as string, command: r.command as string,
    args: summariseArgs(r.command as string, rawArgs), state: r.state as CommandState, outcomeCode: r.outcome_code as string | null, result,
    createdAt: r.created_at as number, sentAt: r.sent_at as number | null, finishedAt: r.finished_at as number | null, attempts: r.attempts as number,
    rawArgs, envelope,
  };
}
const view = (r: Raw): CommandRow => {
  const { rawArgs: _a, envelope: _e, ...v } = r;
  return v;
};

export class Commands {
  // cmdId → the connection it was last sent on (memory: a restart re-sends a `received` command once).
  private inflightConn = new Map<string, string>();
  private dropped = new WeakMap<Connection, number>();
  private budget: Buckets;
  private finals: ((r: CommandRow) => void)[] = [];

  constructor(private d: CommandsDeps) {
    this.budget = new Buckets({ capacity: d.perProxyPerMin ?? 60, windowMs: 60_000 });
  }

  onFinal(fn: (r: CommandRow) => void): void {
    this.finals.push(fn);
  }

  // Pre-checks are UX (R2-15): the proxy re-checks everything.
  create(actor: string, accountId: string, proxyId: string, command: WireCommand, args: Record<string, unknown>, meta?: { reason?: string }): CommandRow {
    const px = this.d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
    if (px.state !== 'enrolled') throw new ApiError(409, 'not_enrolled');
    const rep = this.d.status.row(proxyId)?.reported;
    if (!rep?.capabilities?.includes('commands') || !rep.commands) throw new ApiError(409, 'unsupported_by_proxy');
    if (!rep.commands.enabled || rep.commands.paused) throw new ApiError(409, 'paused_on_proxy');
    const v = validateCommandArgs(command, args);
    if (!v.ok) throw new ApiError(400, 'invalid_args');
    for (const need of requiredEntries(command, args)) if (!rep.commands.allow.includes(need)) throw new ApiError(409, 'not_allowed_on_proxy');
    const now = this.d.clock.now();
    if (!this.budget.take(proxyId, now).ok) throw new ApiError(429, 'rate_limited');
    const id = newId('cmd');
    tx(this.d.db, () => {
      this.d.db.prepare(`INSERT INTO commands (id, account_id, proxy_id, actor, command, args, state, created_at) VALUES (?,?,?,?,?,?,'queued',?)`)
        .run(id, accountId, proxyId, actor, command, JSON.stringify(args), now);
      this.d.audit.write({
        actorType: actor === 'system' ? 'system' : 'sysadmin', actor, action: 'command-create', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: px.name, outcome: 'ok',
        detail: { cmdId: id, command, ...(meta?.reason ? { reason: meta.reason } : {}), args: summariseArgs(command, args) },
      });
    });
    queueMicrotask(() => this.safeDispatch(proxyId));
    return this.get(accountId, proxyId, id);
  }

  list(accountId: string, proxyId: string, o: { limit?: number; cursor?: string }): { items: CommandRow[]; nextCursor: string | null } {
    this.d.registry.getProxy(accountId, proxyId);
    const lim = Number.isFinite(o.limit) ? Math.min(Math.max(Math.floor(o.limit!), 1), 200) : 20;
    const cursor = typeof o.cursor === 'string' && /^cmd_[0-9A-Z]{20}$/.test(o.cursor) ? o.cursor : null;
    const rows = this.d.db.prepare(`SELECT * FROM commands WHERE account_id = ? AND proxy_id = ? ${cursor ? 'AND rowid < (SELECT rowid FROM commands WHERE id = ?)' : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(...(cursor ? [accountId, proxyId, cursor, lim + 1] : [accountId, proxyId, lim + 1])) as DbRow[];
    const items = rows.slice(0, lim).map((r) => view(toRaw(r)));
    return { items, nextCursor: rows.length > lim ? items[items.length - 1].id : null };
  }

  get(accountId: string, proxyId: string, cmdId: string): CommandRow & { resultEnvelope: unknown } {
    this.d.registry.getProxy(accountId, proxyId);
    const r = this.d.db.prepare('SELECT * FROM commands WHERE id = ? AND account_id = ? AND proxy_id = ?').get(cmdId, accountId, proxyId) as DbRow | undefined;
    if (!r) throw new ApiError(404, 'not_found');
    const raw = toRaw(r);
    return { ...view(raw), resultEnvelope: raw.envelope };
  }

  private byId(id: string): Raw {
    return toRaw(this.d.db.prepare('SELECT * FROM commands WHERE id = ?').get(id) as DbRow);
  }

  // Every proxy with open commands: give up the old ones, send what is due.
  tick(): void {
    const now = this.d.clock.now();
    const old = this.d.db.prepare(`SELECT * FROM commands WHERE state IN ${OPEN} AND created_at <= ?`).all(now - GIVE_UP_AFTER_MS) as DbRow[];
    for (const r of old) this.giveUp(toRaw(r), now);
    const proxies = this.d.db.prepare(`SELECT DISTINCT proxy_id FROM commands WHERE state IN ${OPEN} AND proxy_id IS NOT NULL`).all() as { proxy_id: string }[];
    for (const p of proxies) this.safeDispatch(p.proxy_id);
  }

  onLive(c: Connection): void {
    if (c.proxyId) queueMicrotask(() => this.safeDispatch(c.proxyId!));
  }

  private safeDispatch(proxyId: string): void {
    try {
      this.dispatch(proxyId);
    } catch (e) {
      this.d.log.error({ err: e, proxyId }, 'command_dispatch_failed');
    }
  }

  private dispatch(proxyId: string): void {
    const now = this.d.clock.now();
    const open = (this.d.db.prepare(`SELECT * FROM commands WHERE proxy_id = ? AND state IN ${OPEN} ORDER BY created_at, rowid`).all(proxyId) as DbRow[]).map(toRaw);
    for (const r of open) if (now - r.createdAt >= GIVE_UP_AFTER_MS) this.giveUp(r, now);
    const head = open.find((r) => now - r.createdAt < GIVE_UP_AFTER_MS);
    if (!head) return;
    const c = this.d.hub().live(proxyId);
    if (!c || !c.capabilities.includes('commands')) return;
    const due = head.state === 'queued'
      || (head.state === 'sent' && now - (head.sentAt ?? 0) >= RESEND_AFTER_MS)
      || (head.state === 'received' && this.inflightConn.get(head.id) !== c.connId);
    if (!due) return;
    if (!sendCommand(c, { id: head.id, actor: head.actor, command: head.command, args: head.rawArgs, proxyId })) return;
    this.inflightConn.set(head.id, c.connId);
    // One write per send; a re-send while `received` keeps the state.
    tx(this.d.db, () => this.d.db.prepare(`UPDATE commands SET state = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?`).run(head.state === 'received' ? 'received' : 'sent', now, head.id));
  }

  private giveUp(r: Raw, now: number): void {
    const state: CommandState = r.state === 'queued' && r.attempts === 0 ? 'expired' : 'unknown';
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE commands SET state = ?, finished_at = ? WHERE id = ? AND state IN ${OPEN}`).run(state, now, r.id);
      this.d.audit.write({ actorType: 'system', actor: 'system', action: 'command-expired', accountId: r.accountId, targetType: 'proxy', targetId: r.proxyId, outcome: 'failed', detail: { cmdId: r.id, command: r.command, state } });
    });
    this.inflightConn.delete(r.id);
    this.finished(r.id, r.proxyId);
  }

  private finished(id: string, proxyId: string | null): void {
    const fin = view(this.byId(id));
    for (const f of this.finals) {
      try {
        f(fin);
      } catch (e) {
        this.d.log.error({ err: e, cmdId: id }, 'command_final_listener_failed');
      }
    }
    if (proxyId) this.d.live.publishRegistry('proxy', proxyId);
  }

  // A result or event from a proxy. Accepted only when signed by this
  // connection's key and bound to this proxy and connection; anything else is
  // dropped and audited (throttled), and a flood closes the connection.
  onMessage(c: Connection, m: Envelope): void {
    const b = m.body as Record<string, unknown>;
    const drop = (reason: string) => {
      this.d.audit.throttled(`cmdres:${c.proxyId}:${reason}`, {
        actorType: 'proxy', actor: c.proxyId!, action: 'command-result', outcome: 'refused', targetType: 'proxy', targetId: c.proxyId,
        detail: { reason, cmdId: typeof b.cmdId === 'string' ? b.cmdId.slice(0, 40) : null },
      });
      const n = (this.dropped.get(c) ?? 0) + 1;
      this.dropped.set(c, n);
      if (n > DROPS_BEFORE_CLOSE) c.close(CLOSE.bad_message, 'bad_message');
    };
    if (!c.proxyKey || !verifyEnvelope(c.proxyKey, m as unknown as Record<string, unknown>)) return drop('bad_signature');
    if (b.proxyId !== c.proxyId || b.connId !== c.connId) return drop('wrong_target');
    const row = this.d.db.prepare('SELECT * FROM commands WHERE id = ? AND proxy_id = ?').get(String(b.cmdId), c.proxyId!) as DbRow | undefined;
    if (!row) return drop('unknown_command');
    const r = toRaw(row);
    if (b.phase === 'received') {
      if (r.state === 'sent') tx(this.d.db, () => this.d.db.prepare(`UPDATE commands SET state = 'received' WHERE id = ? AND state = 'sent'`).run(r.id));
      return;
    }
    if (b.phase !== 'done') return drop('bad_phase');
    if (FINAL.includes(r.state)) return; // already final (a duplicate answer)
    const state: CommandState = b.status === 'ok' ? 'done' : b.status === 'refused' ? 'refused' : 'failed';
    if (state === 'done' && !validateResultPayload(r.command, b.result)) this.d.log.warn({ cmdId: r.id, proxyId: c.proxyId }, 'command_result_unreadable');
    const text = JSON.stringify(m);
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE commands SET state = ?, outcome_code = ?, result = ?, result_sig = ?, finished_at = ? WHERE id = ?`)
        .run(state, typeof b.code === 'string' ? b.code.slice(0, 64) : b.status === 'conflict' ? 'conflict' : null, text.length <= 98304 ? text : null, typeof m.sig === 'string' ? m.sig : null, this.d.clock.now(), r.id);
      this.d.audit.write({
        actorType: 'proxy', actor: c.proxyId!, action: 'command-result', accountId: r.accountId, targetType: 'proxy', targetId: c.proxyId,
        outcome: state === 'done' ? 'ok' : state === 'refused' ? 'refused' : 'failed',
        detail: { cmdId: r.id, command: r.command, status: typeof b.status === 'string' ? b.status.slice(0, 16) : null, code: typeof b.code === 'string' ? b.code.slice(0, 64) : null, duplicate: b.duplicate === true, late: r.state === 'unknown' },
      });
    });
    this.inflightConn.delete(r.id);
    this.finished(r.id, c.proxyId);
    queueMicrotask(() => this.safeDispatch(c.proxyId!));
  }
}
