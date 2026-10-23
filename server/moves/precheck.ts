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
export const online = (d: PrecheckDeps, p: Proxy) => p.state === 'enrolled' && d.status.viewOf(p).state === 'online';

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
  return unseen(d, sourceProxyId, targetProxyId).length === 0;
}
// The cams instances that see the source but not the target (R7's failures).
export function unseen(d: PrecheckDeps, sourceProxyId: string, targetProxyId: string): string[] {
  const t = seenBy(d, targetProxyId);
  return [...seenBy(d, sourceProxyId)].filter((i) => !t.has(i));
}

// R7: a per-instance host for the camera would point at the old place after the switch-over.
export function hostOverridden(d: PrecheckDeps, cameraId: string): boolean {
  return !!d.db.prepare('SELECT 1 FROM cams_camera_overrides WHERE camera_id = ? AND host IS NOT NULL').get(cameraId);
}

// Every rule in the order precheck applies them, with a detail where one helps
// (diagnostics, issue #45). After a failed proxy lookup the proxy rules are not run.
export interface PrecheckRule { rule: string; ok: boolean; reason: PrecheckReason; detail?: string }
export interface PrecheckReport { ok: boolean; reason: PrecheckReason | null; rules: PrecheckRule[] }
export function precheckReport(d: PrecheckDeps, m: Candidate): PrecheckReport {
  const rules: PrecheckRule[] = [];
  const add = (rule: string, ok: boolean, reason: PrecheckReason, detail?: string) => rules.push({ rule, ok, reason, ...(detail ? { detail } : {}) });
  const done = () => {
    const f = rules.find((r) => !r.ok);
    return { ok: !f, reason: f?.reason ?? null, rules };
  };
  add('different_proxies', m.targetProxyId !== m.sourceProxyId, 'id_taken'); // the camera is already there
  const t = d.registry.proxyById(m.targetProxyId);
  const src = d.registry.proxyById(m.sourceProxyId);
  const missing = [!src && 'source', !t && 'target'].filter(Boolean).join(', ');
  const foreign = [src && src.accountId !== m.accountId && 'source', t && t.accountId !== m.accountId && 'target'].filter(Boolean).join(', ');
  add('same_account', !!t && !!src && !foreign, 'other_account', missing ? `not registered: ${missing}` : foreign ? `other account: ${foreign}` : undefined);
  if (!t || !src || foreign) return done();
  const tv = d.status.viewOf(t);
  add('target_online', online(d, t), 'target_offline', `target ${t.state === 'enrolled' ? tv.state : t.state}`);
  add('target_receives', receives(d, t), 'moves_not_allowed', `commands ${tv.commands}; move.receive ${tv.allow.includes('move.receive') ? 'allowed' : 'not allowed'}`);
  const busy = [d.store.byProxy(src.id) && 'source', d.store.byProxy(t.id) && 'target'].filter(Boolean).join(', ');
  add('not_busy', !busy, 'busy', busy ? `a move is open on the ${busy}` : undefined);
  const siteDetail = (p: Proxy) => `${p.id}: registry ${p.tlsSite ?? 'none'}, reported ${d.status.row(p.id)?.reported?.site ?? 'none'}`;
  add('site_ca', !!siteOf(d, src) && !!siteOf(d, t), 'no_site_ca', [siteOf(d, src) ? null : siteDetail(src), siteOf(d, t) ? null : siteDetail(t)].filter(Boolean).join('; ') || undefined);
  const missed = unseen(d, src.id, t.id);
  add('routed', missed.length === 0, 'not_routed', missed.length ? `cams instances that see the source but not the target: ${missed.map((i) => instanceName(d, i)).join(', ')}` : undefined);
  if (m.cameraId) add('no_host_override', !hostOverridden(d, m.cameraId), 'host_overridden');
  return done();
}

const instanceName = (d: PrecheckDeps, id: string) => (d.db.prepare('SELECT name FROM cams_instances WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;

export function precheck(d: PrecheckDeps, m: Candidate): { ok: true } | { ok: false; reason: PrecheckReason } {
  const r = precheckReport(d, m);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason! };
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
