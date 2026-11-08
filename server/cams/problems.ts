// A cams instance's problems for one account, in user words (finding 12b): cams refused the account's part of the
// snapshot (snapshot_invalid) and nobody saw it. Shown on the account's Overview and on the Dashboard.
import type { Db } from '../db/open';
import type { CamsReport } from './instances';

export interface CamsAccountProblem { instanceId: string; instance: string; code: string; detail: string; camsId: string | null; text: string }
type Instance = { id: string; name: string; displayName: string; live: { report: CamsReport | null } };

// cams names a camera by its index in the account part it got: the account's cameras in snapshot order (by cams id;
// with no proxy, or a proxy routed to this instance and not hidden), as buildSnapshot lists them.
function camsIdAt(db: Db, instanceId: string, accountId: string, index: number): string | null {
  const rows = db.prepare(`SELECT c.cams_id FROM cameras c WHERE c.account_id = ? AND (c.proxy_id IS NULL OR c.proxy_id IN
    (SELECT r.proxy_id FROM cams_instance_routes r JOIN proxies p ON p.id = r.proxy_id WHERE r.instance_id = ? AND r.hidden = 0 AND p.account_id = ?)) ORDER BY c.cams_id`)
    .all(accountId, instanceId, accountId) as { cams_id: string }[];
  return rows[index]?.cams_id ?? null;
}

const CAMERA_INDEX = /\bcamera(?: registry entry)? (\d{1,4})\b/;

export function problemText(instance: string, code: string, detail: string, camsId: string | null): string {
  const what = detail ? (camsId ? detail.replace(CAMERA_INDEX, `camera ${camsId}`) : detail) : '';
  switch (code) {
    case 'snapshot_invalid':
      return `${instance} can't use this account's configuration${what ? ` (${what})` : ''}: it keeps the last one it accepted. Check the camera's host, protocol and TLS name (Cameras → Edit).`;
    case 'proxy_token_missing':
      return `${instance} has no token for a proxy of this account${what ? ` (${what})` : ''}: its cameras there stay dark until the token is registered.`;
    case 'admin_token_not_allowed':
      return `${instance} may not use an admin token on a proxy of this account${what ? ` (${what})` : ''}: the proxy's command policy lacks tokens.apply.admin.`;
    default:
      return `${instance} reports ${code}${what ? `: ${what}` : ''}.`;
  }
}

export function accountCamsProblems(db: Db, instances: Instance[], accountId: string): CamsAccountProblem[] {
  const out: CamsAccountProblem[] = [];
  for (const i of instances) {
    for (const p of i.live.report?.problems ?? []) {
      if (!p || p.accountId !== accountId || typeof p.code !== 'string') continue;
      const detail = typeof p.detail === 'string' ? p.detail.slice(0, 200) : '';
      const m = CAMERA_INDEX.exec(detail);
      const camsId = m ? camsIdAt(db, i.id, accountId, Number(m[1])) : null;
      out.push({ instanceId: i.id, instance: i.displayName, code: p.code.slice(0, 64), detail, camsId, text: problemText(i.displayName, p.code.slice(0, 64), detail, camsId) });
    }
  }
  return out;
}
