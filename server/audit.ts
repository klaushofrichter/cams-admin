import type { Clock } from './clock';
import { auditId } from './ids';
import { tx, type Db } from './db/open';

// The closed list of spec §11.4, like cam-proxy's AUDIT_ACTIONS.
export const AUDIT_ACTIONS = [
  'signin', 'signin-refused', 'signout', 'sessions-ended',
  'account-create', 'account-update', 'account-delete', 'user-create', 'user-update', 'user-delete',
  'proxy-create', 'proxy-update', 'proxy-delete', 'proxy-block', 'camera-create', 'camera-update', 'camera-delete', 'camera-adopt', 'sim-update', 'sim-delete',
  'enrollment-code-create', 'enrollment-code-cancel', 'proxy-enrolled', 'key-confirmed', 'enroll-refused', 'key-revoke', 'proxy-auth-refused',
  'backup-snapshot', 'backup-now', 'restore-detected',
  'command-create', 'command-result', 'command-expired', 'token-issue', 'token-retire', 'token-revoke',
  'audit-throttled',
  // P4: cams instances, the service API, import and export.
  'cams-instance-create', 'cams-instance-update', 'cams-instance-delete', 'cams-instance-block', 'cams-enrollment-code-create', 'cams-enrollment-code-cancel',
  'cams-enrolled', 'cams-enroll-refused', 'cams-key-confirmed', 'cams-key-revoke', 'cams-auth-refused', 'route-update', 'cams-rotate',
  'import-run', 'import-apply', 'export-run',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
const KNOWN = new Set<string>(AUDIT_ACTIONS);

export interface AuditEntry {
  actorType: 'sysadmin' | 'proxy' | 'system' | 'cams';
  actor: string;
  action: AuditAction;
  accountId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  outcome: 'ok' | 'refused' | 'failed';
  detail?: Record<string, unknown>;
}
export interface AuditRecord extends Required<Omit<AuditEntry, 'detail'>> { id: string; at: number; detail: Record<string, unknown> }
export interface AuditFilter { account?: string; actorType?: string; action?: string; from?: number; to?: number; limit?: number; cursor?: string }

const MAX_DETAIL = 4096;
const THROTTLE_MS = 10 * 60_000;
const KEEP_MS = 400 * 86400_000;

interface Window { start: number; suppressed: number; e: AuditEntry }

export class Audit {
  private windows = new Map<string, Window>();
  constructor(private db: Db, private clock: Clock) {}

  // Inside the caller's transaction when there is one (tx joins it).
  write(e: AuditEntry): string {
    if (!KNOWN.has(e.action)) throw new Error(`unknown audit action ${e.action}`);
    let detail = JSON.stringify(e.detail ?? {});
    if (detail.length > MAX_DETAIL) detail = JSON.stringify({ truncated: true });
    const at = this.clock.now();
    const id = auditId(at);
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO audit_log (id, at, actor_type, actor, action, account_id, target_type, target_id, target_label, outcome, detail)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, at, e.actorType, e.actor, e.action, e.accountId ?? null, e.targetType ?? null, e.targetId ?? null, e.targetLabel ?? null, e.outcome, detail);
    });
    return id;
  }

  // One record per key per 10 min; the rest are counted into an
  // audit-throttled record when the window closes (flushThrottled).
  throttled(key: string, e: AuditEntry): void {
    this.flushThrottled();
    const w = this.windows.get(key);
    if (w) {
      w.suppressed++;
      return;
    }
    this.windows.set(key, { start: this.clock.now(), suppressed: 0, e });
    this.write(e);
  }

  flushThrottled(): void {
    const now = this.clock.now();
    for (const [key, w] of this.windows) {
      if (now - w.start < THROTTLE_MS) continue;
      this.windows.delete(key);
      if (w.suppressed > 0) {
        this.write({ actorType: 'system', actor: 'system', action: 'audit-throttled', accountId: w.e.accountId ?? null, outcome: 'ok', detail: { key, throttledAction: w.e.action, count: w.suppressed } });
      }
    }
  }

  list(f: AuditFilter): { items: AuditRecord[]; nextCursor: string | null } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.account) { where.push('account_id = ?'); args.push(f.account); }
    if (f.actorType) { where.push('actor_type = ?'); args.push(f.actorType); }
    if (f.action) { where.push('action = ?'); args.push(f.action); }
    if (f.from !== undefined) { where.push('at >= ?'); args.push(f.from); }
    if (f.to !== undefined) { where.push('at <= ?'); args.push(f.to); }
    if (f.cursor) { where.push('id < ?'); args.push(f.cursor); }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1) as Record<string, unknown>[];
    const items = rows.slice(0, limit).map(toRecord);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  prune(): void {
    const before = this.clock.now() - KEEP_MS;
    tx(this.db, () => {
      this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(before);
      // The command history follows the audit log's 400 days (open commands stay).
      this.db.prepare(`DELETE FROM commands WHERE created_at < ? AND state NOT IN ('queued','sent','received')`).run(before);
    });
  }
}

function toRecord(r: Record<string, unknown>): AuditRecord {
  return {
    id: r.id as string, at: r.at as number, actorType: r.actor_type as AuditRecord['actorType'], actor: r.actor as string,
    action: r.action as AuditAction, accountId: r.account_id as string | null, targetType: r.target_type as string | null,
    targetId: r.target_id as string | null, targetLabel: r.target_label as string | null, outcome: r.outcome as AuditRecord['outcome'],
    detail: JSON.parse((r.detail as string) || '{}'),
  };
}
