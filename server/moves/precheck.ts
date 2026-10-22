import type { Db } from '../db/open';
import type { Proxy, Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { MoveStore } from './store';

// cams-admin's own checks before a move is offered (S §4, §6; plan R7, X21).
// The proxies re-check everything they can see themselves.

export type PrecheckReason = 'other_account' | 'target_offline' | 'moves_not_allowed' | 'busy' | 'no_site_ca' | 'not_routed' | 'host_overridden' | 'id_taken';
export interface PrecheckDeps { db: Db; registry: Registry; status: StatusStore; store: MoveStore }
export interface Candidate { accountId: string; sourceProxyId: string; targetProxyId: string; cameraId?: string | null }
export interface EligibleTarget { proxyId: string; name: string; site: string }

// The contract's site pattern (cams-v1 proxies[].site, move.targets).
const SITE_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

// X21: a site CA the move can rely on: the registry's tls_site is set and is
// the tls.site the proxy itself reports (cams verifies the camera against it).
export function siteOf(d: PrecheckDeps, p: Proxy): string | null {
  const reported = d.status.row(p.id)?.reported?.site ?? null;
  return p.tlsSite && SITE_RE.test(p.tlsSite) && p.tlsSite === reported ? p.tlsSite : null;
}

// Online, enrolled, and taking move.receive commands now (commands on, not paused, entry allowed).
function receives(d: PrecheckDeps, p: Proxy): boolean {
  const v = d.status.viewOf(p);
  return v.commands === 'allowed' && v.allow.includes('move.receive');
}
const online = (d: PrecheckDeps, p: Proxy) => p.state === 'enrolled' && d.status.viewOf(p).state === 'online';

// The cams instances that see this proxy: a visible route, the account served, the instance not revoked.
function seenBy(d: PrecheckDeps, proxyId: string): Set<string> {
  const rows = d.db.prepare(`SELECT r.instance_id FROM cams_instance_routes r JOIN cams_instances i ON i.id = r.instance_id
    JOIN proxies p ON p.id = r.proxy_id JOIN cams_instance_accounts a ON a.instance_id = r.instance_id AND a.account_id = p.account_id
    WHERE r.proxy_id = ? AND r.hidden = 0 AND i.state <> 'revoked'`).all(proxyId) as { instance_id: string }[];
  return new Set(rows.map((r) => r.instance_id));
}

// R7: every cams instance that sees the source must see the target too, or
// the camera would vanish from it at the switch-over.
export function routed(d: PrecheckDeps, sourceProxyId: string, targetProxyId: string): boolean {
  const t = seenBy(d, targetProxyId);
  for (const i of seenBy(d, sourceProxyId)) if (!t.has(i)) return false;
  return true;
}

// R7: a per-instance host for the camera would point at the old place after the switch-over.
export function hostOverridden(d: PrecheckDeps, cameraId: string): boolean {
  return !!d.db.prepare('SELECT 1 FROM cams_camera_overrides WHERE camera_id = ? AND host IS NOT NULL').get(cameraId);
}

export function precheck(d: PrecheckDeps, m: Candidate): { ok: true } | { ok: false; reason: PrecheckReason } {
  const no = (reason: PrecheckReason) => ({ ok: false as const, reason });
  if (m.targetProxyId === m.sourceProxyId) return no('id_taken'); // the camera is already there
  const t = d.registry.proxyById(m.targetProxyId);
  const src = d.registry.proxyById(m.sourceProxyId);
  if (!t || !src || t.accountId !== m.accountId || src.accountId !== m.accountId) return no('other_account');
  if (!online(d, t)) return no('target_offline');
  if (!receives(d, t)) return no('moves_not_allowed');
  if (d.store.byProxy(src.id) || d.store.byProxy(t.id)) return no('busy');
  if (!siteOf(d, src) || !siteOf(d, t)) return no('no_site_ca');
  if (!routed(d, src.id, t.id)) return no('not_routed');
  if (m.cameraId && hostOverridden(d, m.cameraId)) return no('host_overridden');
  return { ok: true };
}

// What the source's "Move to…" list offers (S §4): every proxy precheck would let through.
export function eligibleTargets(d: PrecheckDeps, accountId: string, sourceProxyId: string): EligibleTarget[] {
  const out: EligibleTarget[] = [];
  for (const p of d.registry.listProxies(accountId)) {
    if (p.id === sourceProxyId || !online(d, p) || !receives(d, p) || d.store.byProxy(p.id)) continue;
    const site = siteOf(d, p);
    if (!site || !routed(d, sourceProxyId, p.id)) continue;
    out.push({ proxyId: p.id, name: p.name, site });
    if (out.length === 64) break; // the contract's cap
  }
  return out;
}
