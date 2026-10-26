import type { Db } from '../db/open';
import type { Proxy, Registry } from '../registry';
import type { StatusStore } from '../status/store';
import type { MoveStore } from './store';
import { SITE_PATTERN } from '../../contract/build';
import { passivePorts, v4InCidr, type Profile } from '../status/profile';
import { ipLiteral } from '../../contract/firewall';

// cams-admin's own checks before a move is offered (S §4, §6; plan R7, X21).
// The proxies re-check everything they can see themselves.

export type PrecheckReason = 'other_account' | 'target_offline' | 'moves_not_allowed' | 'camera_limit' | 'busy' | 'no_site_ca' | 'ca_does_not_cover_camera' | 'not_routed' | 'host_overridden' | 'id_taken';
export interface PrecheckDeps { db: Db; registry: Registry; status: StatusStore; store: MoveStore }
export interface Candidate { accountId: string; sourceProxyId: string; targetProxyId: string; cameraId?: string | null }
export interface EligibleTarget { proxyId: string; name: string; site: string }

// The contract's site pattern (cams-v1 proxies[].site, move.targets).
const SITE_RE = new RegExp(SITE_PATTERN);

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

// FTP passive ports a proxy needs per camera (cam-proxy: 10 per camera from 30000).
export const FTP_PORTS_PER_CAMERA = 10;

// The proxy profile's rules (proxy profile design §3), on the target's reported profile. Each passes (skipped) when
// the target reports none (a cam-proxy before the profile). The target's own offer check stays the final word.
export function profileRules(targetName: string, p: Profile | null | undefined): PrecheckRule[] {
  if (!p) {
    const skipped = `${targetName} reports no profile`;
    return [{ rule: 'capacity', ok: true, reason: 'camera_limit', detail: skipped }, { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: skipped }];
  }
  const unset = p.set ? '' : " (its profile is not set: set it on the proxy's home page)";
  const capacity: PrecheckRule = { rule: 'capacity', ok: p.held < p.cameras, reason: 'camera_limit', detail: `${targetName} holds ${p.held} of ${p.cameras} camera${p.cameras === 1 ? '' : 's'}${unset}` };
  const need = FTP_PORTS_PER_CAMERA * (p.held + 1);
  const have = passivePorts(p);
  const ftp: PrecheckRule = !p.ftp.enabled ? { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: `FTP is off on ${targetName}` }
    : !p.ftp.passive ? { rule: 'ftp_ports', ok: true, reason: 'camera_limit', detail: `${targetName} reports no FTP passive range` }
      : { rule: 'ftp_ports', ok: have >= need, reason: 'camera_limit', detail: `${targetName}'s FTP passive range ${p.ftp.passive.from}-${p.ftp.passive.to} has ${have} ports; ${p.held + 1} camera${p.held === 0 ? '' : 's'} need${p.held === 0 ? 's' : ''} ${need}` };
  return [capacity, ftp];
}
// The camera's registry host as an IPv4 literal (a ":port" dropped), else null (a name, IPv6, from-proxy, none).
function ipv4Of(host: string | null | undefined): string | null {
  const h = (host ?? '').trim();
  const i = h.indexOf(':');
  const bare = i >= 0 && h.indexOf(':', i + 1) < 0 ? h.slice(0, i) : h;
  return ipLiteral(bare) === 4 ? bare : null;
}

// ca_covers_camera: the target's site CA issues camera certificates for its camera subnet only, so a camera
// outside it could not be verified after the move. Passes (skipped) when the target reports no subnet (a
// cam-proxy before profile.tls) or the camera's registry address is no IPv4 literal.
export function caCoversRule(targetName: string, p: Profile | null | undefined, cameraHost: string | null | undefined): PrecheckRule {
  const rule = (ok: boolean, detail: string): PrecheckRule => ({ rule: 'ca_covers_camera', ok, reason: 'ca_does_not_cover_camera', detail });
  const subnet = p?.tls?.cameraSubnet ?? null;
  if (!subnet) return rule(true, `${targetName} reports no camera subnet for its site CA`);
  const ip = ipv4Of(cameraHost);
  if (!ip) return rule(true, "the camera's registry address is not an IPv4 address");
  return v4InCidr(ip, subnet) ? rule(true, `${targetName}'s site CA covers ${subnet}, ${ip} included`) : rule(false, `${targetName}'s site CA covers ${subnet}, not ${ip}`);
}

const profileFits = (d: PrecheckDeps, p: Proxy) => profileRules(p.name, d.status.row(p.id)?.reported?.profile).every((r) => r.ok);

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
  for (const pr of profileRules(t.name, d.status.row(t.id)?.reported?.profile)) rules.push(pr);
  const busy = [d.store.byProxy(src.id) && 'source', d.store.byProxy(t.id) && 'target'].filter(Boolean).join(', ');
  add('not_busy', !busy, 'busy', busy ? `a move is open on the ${busy}` : undefined);
  const siteDetail = (p: Proxy) => `${p.id}: registry ${p.tlsSite ?? 'none'}, reported ${d.status.row(p.id)?.reported?.site ?? 'none'}`;
  // Only the target needs a site CA (2026-10-26): the source may have none (the Pi proxy has no tls.site).
  add('site_ca', !!siteOf(d, t), 'no_site_ca', siteOf(d, t) ? undefined : siteDetail(t));
  if (m.cameraId) {
    const host = (d.db.prepare('SELECT host FROM cameras WHERE id = ?').get(m.cameraId) as { host: string | null } | undefined)?.host;
    rules.push(caCoversRule(t.name, d.status.row(t.id)?.reported?.profile, host));
  }
  const missed = unseen(d, src.id, t.id);
  add('routed', missed.length === 0, 'not_routed', missed.length ? `cams instances that see the source but not the target: ${missed.map((i) => instanceName(d, i)).join(', ')}` : undefined);
  if (m.cameraId) add('no_host_override', !hostOverridden(d, m.cameraId), 'host_overridden');
  return done();
}

const instanceName = (d: PrecheckDeps, id: string) => (d.db.prepare('SELECT name FROM cams_instances WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;

// The first failing rule: its reason, its name and its detail (when it has one).
export function precheck(d: PrecheckDeps, m: Candidate): { ok: true } | { ok: false; reason: PrecheckReason; rule: string; detail?: string } {
  const f = precheckReport(d, m).rules.find((x) => !x.ok);
  return !f ? { ok: true } : { ok: false, reason: f.reason, rule: f.rule, ...(f.detail ? { detail: f.detail } : {}) };
}

// What the source's "Move to…" list offers (S §4): every proxy precheck would let through.
export function eligibleTargets(d: PrecheckDeps, accountId: string, sourceProxyId: string): EligibleTarget[] {
  const out: EligibleTarget[] = [];
  for (const p of d.registry.listProxies(accountId)) {
    if (p.id === sourceProxyId || !online(d, p) || !receives(d, p) || !profileFits(d, p) || d.store.byProxy(p.id)) continue;
    const site = siteOf(d, p);
    if (!site || !routed(d, sourceProxyId, p.id)) continue;
    out.push({ proxyId: p.id, name: p.name, site });
    if (out.length === 64) break; // the contract's cap
  }
  return out;
}
