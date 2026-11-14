// token-check's evaluation (docs/token-check.md): from cams-admin's
// diagnostics answers and the hashers' fingerprints, one line per credential
// or copy. Pure: no I/O, no clock (now is passed in), no secret ever (the
// inputs hold fingerprints only).

export type Status = 'ok' | 'mismatch' | 'expired' | 'expiring' | 'unused' | 'missing' | 'unknown';
export type Severity = 'ok' | 'info' | 'warn' | 'problem';
export interface Line { section: string; credential: string; copy: string; status: Status; reason: string; fp?: string; severity: Severity }

const SEVERITY: Record<Status, Severity> = { ok: 'ok', unknown: 'info', expiring: 'warn', unused: 'warn', mismatch: 'problem', expired: 'problem', missing: 'problem' };

// ---- inputs ----------------------------------------------------------------

export interface Fp { fp: string; sha?: string }
type Meta = { exists?: boolean; mode?: string; error?: string };
export interface EnvVar extends Partial<Fp>, Meta { via?: 'env' | 'file'; file?: string; list?: Fp[]; empty?: boolean }
export interface EnvResult extends Meta { vars?: Record<string, EnvVar>; plain?: Record<string, string> }
export interface FileResult extends Meta, Partial<Fp> { list?: Fp[]; empty?: boolean; name?: string }
export interface JsonEntry { path: string; ctx: Record<string, unknown>; secrets: Record<string, Fp>; hashOk?: boolean }
export interface JsonResult extends Meta { entries?: JsonEntry[] }
export interface KeyResult extends Meta { serverKeyFingerprints?: string[]; publicKeyFingerprint?: string; proxyId?: string; instanceId?: string; account?: string; accounts?: string[] }
export interface CacheResult extends Meta { instance?: { id?: string; name?: string }; revision?: string; accounts?: { id: string; name: string; proxies: { id: string; name: string; caFingerprints: string[] }[] }[] }
export interface ApiCamera { id: string; online?: boolean | null; credentials?: { source?: string; envName?: string; authOk?: boolean | null; checkedAt?: number | null }; ftp?: { enabled?: boolean; passwordSet?: boolean; lastUpload?: number | null; failures?: number; stalled?: boolean; camera?: { state?: string; mismatch?: string[]; error?: string | null } | null } }
export interface ApiResult {
  error?: string;
  admin?: { state?: string; account?: string; proxyId?: string; error?: string };
  tokens?: { revision?: number; problem?: string | null; items?: { id: string; kind: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }[]; error?: string };
  tls?: { site?: string; caFingerprint?: string | null; caNotAfter?: number | null; proxy?: { notAfter?: number | null }; cameras?: { id: string; notAfter?: number | null; problem?: string | null }[]; error?: string };
  cameras?: ApiCamera[] | { error: string };
  switches?: { id: string; passwordSet: boolean; passwordElsewhere: boolean }[] | { error: string };
}
export interface HostResult {
  error?: string;
  items: {
    env?: EnvResult; envBackups?: { files: (EnvResult & { name: string })[] }; envBackupsTop?: { files: (EnvResult & { name: string })[] };
    pwFiles?: { files: FileResult[] }; cameraPasswords?: JsonResult; switchPasswords?: JsonResult; cameraUsers?: Meta & { users?: Record<string, string | null> };
    proxyKey?: KeyResult; api?: ApiResult;
    camsEnv?: EnvResult; camsTokens?: JsonResult; camsCredentials?: JsonResult; camsCameras?: JsonResult; camsKey?: KeyResult; camsCache?: CacheResult;
  };
}
export interface MacResult { items: Record<string, (FileResult & EnvResult & { fingerprint?: string }) | undefined> }

export interface DiagProxy { id: string; accountId: string; name: string; registryState: string; state: string; lastHeartbeatAt: number | null; version: string | null; caFingerprints: string[]; pin: string; pinsNotSentTo?: { name: string }[]; reported: { caFingerprints?: string[]; tokens?: { client: number; admin: number; blocked: number } | null; onboarding?: Record<string, { ready: boolean; missing: string[] }> | null } | null }
export interface DiagInstance { id: string; name: string; state: string; accounts: string[]; lastSeenAt: number | null; routes: { proxyId: string; accountId: string; hidden: boolean }[]; report: { version?: string | null; current?: boolean; tokens?: { managed: number; pending: number; legacy: number } | null; problems?: { code: string; accountId: string | null; detail: string | null }[] } | null }
export interface DiagToken { id: string; kind: string; holder: string; holderName: string | null; label: string; state: string; onProxy: boolean; retireAt: number | null; revokedAt: number | null }
export interface DiagOps { id: string; name: string; scopes?: string[]; hashPrefix: string; state: string; createdAt: number; expiresAt: number | null; lastUsedAt: number | null }
export interface DiagViewer { id: string; name: string; accountIds: string[]; state: string; createdAt: number; expiresAt: number; lastUsedAt: number | null; fingerprintPrefix: string }
export interface DiagCamera { id: string; accountId: string; camsId: string; proxyId: string | null; proxyCameraId: string | null }
export interface DiagSwitch { id: string; name: string; proxyId: string | null; state: string; problems: unknown[] }
export interface Diag {
  ok: boolean; error?: string;
  proxies: DiagProxy[]; instances: DiagInstance[]; tokens: { proxyId: string; proxyName: string; tokens: DiagToken[] }[];
  ops: DiagOps[]; viewers: DiagViewer[]; cameras: DiagCamera[]; switches: Record<string, DiagSwitch[]>;
  diagIssues: { at: number; detail: { hashPrefix?: string; days?: number } }[];
}

export interface Scope {
  label: string; // "account home", "host een"
  accountIds: string[];
  proxies: DiagProxy[];
  instances: DiagInstance[];
  hosts: { name: string; proxy?: string; cams?: string; ssh: boolean }[];
  all: boolean; // every host and account: unmatched Mac copies are reported
}

export interface MacCopyMeta { id: string; label: string; host?: string; camera?: string; user?: string; vars?: string[] }

export interface Input {
  now: number;
  expiringDays: number;
  scope: Scope;
  diag: Diag;
  hosts: Record<string, HostResult>;
  mac: MacResult;
  macCopies: MacCopyMeta[]; // the config's mac.copies with their hasher ids
  accountNames: Record<string, string>; // acc_ id → name
}

// ---- helpers ---------------------------------------------------------------

const DAY = 86_400_000;
export function ago(now: number, t: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function inTime(now: number, t: number): string {
  const s = Math.round((t - now) / 1000);
  if (s < 7200) return `in ${Math.max(0, Math.round(s / 60))} min`;
  if (s < 2 * 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// ok / expiring / expired from an expiry (null: never).
export function expiryStatus(now: number, expiresAt: number | null, days: number): { status: Status; reason: string } {
  if (expiresAt === null) return { status: 'ok', reason: 'never expires' };
  if (expiresAt <= now) return { status: 'expired', reason: `expired ${day(expiresAt)}` };
  if (expiresAt - now <= days * DAY) return { status: 'expiring', reason: `expires ${day(expiresAt)} (${inTime(now, expiresAt)})` };
  return { status: 'ok', reason: `expires ${day(expiresAt)}` };
}

export const showFp = (f: Partial<Fp> | undefined): string | undefined => (f?.sha ? `sha256:${f.sha}` : f?.fp ? `hmac:${f.fp}` : undefined);
const badMode = (mode: string | undefined) => !!mode && (parseInt(mode, 8) & 0o077) !== 0;
const kindOfName = (name: string) => /TOKEN/.test(name);

// A copy of a secret somewhere, by its run fingerprint.
export interface Copy { fp: string; sha?: string; label: string; file?: string; where: string; role: string; camera?: string; user?: string; host?: string; store?: 'env' | 'store' | 'file' | 'cams' | 'mac' }

export function roleOfVar(name: string): { role: string; camera?: string } {
  if (name === 'CAMPROXY_ADMIN_TOKEN') return { role: 'admin-token' };
  if (name === 'CAMPROXY_TOKENS') return { role: 'client-token' };
  if (name === 'CAMPROXY_AUDIT_TOKEN') return { role: 'audit-token' };
  if (name === 'CAMPROXY_FTP_PASSWORD') return { role: 'ftp' };
  if (name === 'CAMPROXY_CAMERA_PASSWORD') return { role: 'camera-password', camera: '*' };
  const m = /^CAMPROXY_CAMERA_PASSWORD_([A-Z0-9_]+)$/.exec(name);
  if (m) return { role: 'camera-password', camera: m[1].toLowerCase().replace(/_/g, '-') };
  if (name === 'CAMPROXY_POE_SWITCH_PASSWORD' || name === 'SWITCH_PASSWORD') return { role: 'switch-password' };
  if (name === 'CAMPROXY_GOOGLE_VISION_KEY') return { role: 'vision-key' };
  if (name === 'CAMS_LOGIN_TOKEN') return { role: 'cams-login' };
  if (name === 'COOKIE_SECRET') return { role: 'cookie-secret' };
  if (/^REOLINK_PASSWORD/.test(name) || /CAMERA_PASSWORD/.test(name)) return { role: 'camera-password' };
  return { role: 'other' };
}

// cam4-admin.pw → {camera: cam4, user: admin}
export function parsePwName(name: string): { camera?: string; user?: string } {
  const m = /^([a-z0-9][a-z0-9-]*?)-(admin|proxy|cams|[a-z]+)\.pw$/.exec(name);
  return m ? { camera: m[1], user: m[2] } : {};
}

export function buildPool(inp: Input): Copy[] {
  const out: Copy[] = [];
  const add = (c: Copy) => out.push(c);
  for (const [host, r] of Object.entries(inp.hosts)) {
    const it = r.items ?? {};
    for (const [name, v] of Object.entries(it.env?.vars ?? {})) {
      const { role, camera } = roleOfVar(name);
      const label = `${host} config/.env ${name}`;
      const file = v.via === 'file' && v.file ? { file: v.file } : {};
      if (v.list) v.list.forEach((f, i) => add({ ...f, label: `${label} #${i + 1}`, ...file, where: host, role, host, store: 'env' }));
      else if (v.fp) add({ fp: v.fp, ...(v.sha ? { sha: v.sha } : {}), label, ...file, where: host, role, host, store: 'env', ...(camera ? { camera } : {}) });
    }
    for (const f of it.pwFiles?.files ?? []) if (f.fp) add({ fp: f.fp, label: `${host} config/${f.name}`, where: host, role: 'camera-password', host, store: 'file', ...parsePwName(f.name ?? '') });
    for (const e of it.cameraPasswords?.entries ?? []) {
      const cam = e.path.replace(/^cameras\./, '');
      if (e.secrets.password) add({ fp: e.secrets.password.fp, label: `${host} data/admin/camera-passwords.json ${cam}`, where: host, role: 'camera-password', camera: cam, host, store: 'store' });
    }
    for (const e of it.switchPasswords?.entries ?? []) {
      if (e.secrets.password) add({ fp: e.secrets.password.fp, label: `${host} data/admin/switch-passwords.json ${e.path.replace(/^switches\./, '')}`, where: host, role: 'switch-password', host, store: 'store' });
    }
    for (const [name, v] of Object.entries(it.camsEnv?.vars ?? {})) {
      if (v.fp && !(it.env?.vars?.[name]?.fp === v.fp)) add({ fp: v.fp, ...(v.sha ? { sha: v.sha } : {}), label: `${host} cams env ${name}`, where: host, role: roleOfVar(name).role, host, store: 'cams' });
    }
    for (const e of it.camsCredentials?.entries ?? []) {
      const [acc, camsId] = e.path.split('/');
      const cam = inp.diag.cameras.find((c) => c.accountId === acc && c.camsId === camsId);
      if (e.secrets.password) add({ fp: e.secrets.password.fp, label: `${host} cams camera-credentials.json ${e.path}`, where: host, role: 'camera-password', camera: cam?.proxyCameraId ?? camsId, user: typeof e.ctx.user === 'string' ? e.ctx.user : undefined, host, store: 'cams' });
    }
    for (const e of it.camsCameras?.entries ?? []) {
      const id = typeof e.ctx.id === 'string' ? e.ctx.id : e.path;
      for (const [k, f] of Object.entries(e.secrets)) {
        const role = k === 'password' ? 'camera-password' : k === 'adminToken' ? 'proxy-admin-copy' : 'proxy-client-copy';
        add({ fp: f.fp, ...(f.sha ? { sha: f.sha } : {}), label: `${host} cams/cameras.json ${id} ${e.path.endsWith('proxy') ? 'proxy.' : ''}${k}`, where: host, role, host, store: 'cams', ...(k === 'password' ? { camera: id, ...(typeof e.ctx.user === 'string' ? { user: e.ctx.user } : {}) } : {}) });
      }
    }
    for (const e of it.camsTokens?.entries ?? []) {
      const f = e.secrets.token;
      if (f) add({ fp: f.fp, ...(f.sha ? { sha: f.sha } : {}), label: `${host} cams data/admin/tokens.json ${String(e.ctx.id ?? e.path)}`, where: host, role: 'managed-token', host, store: 'cams' });
    }
  }
  for (const [id, r] of Object.entries(inp.mac.items)) {
    if (!r) continue;
    const ht = /^adminToken:(.+)$/.exec(id);
    if (ht && r.fp) add({ fp: r.fp, ...(r.sha ? { sha: r.sha } : {}), label: `mac ${macLabel(inp, id)}`, where: 'mac', role: 'admin-token', host: ht[1], store: 'mac' });
    const meta = inp.macCopies.find((m) => m.id === id);
    if (!meta) continue;
    if (r.vars) {
      for (const [name, v] of Object.entries(r.vars)) {
        const { role, camera } = roleOfVar(name);
        const base = { label: `mac ${meta.label} ${name}`, where: 'mac', role, store: 'mac' as const, ...(meta.host ? { host: meta.host } : {}), ...(meta.camera ?? camera ? { camera: meta.camera ?? camera } : {}), ...(meta.user ? { user: meta.user } : {}) };
        if (v.list) v.list.forEach((f, i) => add({ ...f, ...base, label: `${base.label} #${i + 1}` }));
        else if (v.fp) add({ fp: v.fp, ...(v.sha ? { sha: v.sha } : {}), ...base });
      }
    } else if (r.fp) {
      add({ fp: r.fp, ...(r.sha ? { sha: r.sha } : {}), label: `mac ${meta.label}`, where: 'mac', role: meta.camera ? 'camera-password' : 'other', store: 'mac', ...(meta.host ? { host: meta.host } : {}), ...(meta.camera ? { camera: meta.camera } : {}), ...(meta.user ? { user: meta.user } : {}) });
    }
  }
  return out;
}

// A copy as shown: its place, and the file a *_FILE variable names.
export const where = (c: Copy): string => `${c.label}${c.file ? ` (file ${c.file})` : ''}`;
const names = (cs: Copy[]) => cs.map(where).join(', ');

function macLabel(inp: Input, id: string): string {
  const ht = /^adminToken:(.+)$/.exec(id);
  if (ht) return `~/.config/cam-proxy/${ht[1]}-admin-token`;
  return inp.macCopies.find((m) => m.id === id)?.label ?? id;
}

// ---- evaluation ------------------------------------------------------------

export function evaluate(inp: Input): Line[] {
  const lines: Line[] = [];
  const L = (section: string, credential: string, copy: string, status: Status, reason: string, fp?: string, severity?: Severity) =>
    lines.push({ section, credential, copy, status, reason, ...(fp ? { fp } : {}), severity: severity ?? SEVERITY[status] });
  const { now, diag, scope } = inp;
  const exp = (t: number | null) => expiryStatus(now, t, inp.expiringDays);
  const pool = buildPool(inp);
  const others = (c: { fp: string; label: string }) => pool.filter((p) => p.fp === c.fp && p.label !== c.label);
  const accName = (id: string) => inp.accountNames[id] ?? id;

  // cams-admin's own credentials on the Mac.
  const S0 = 'cams-admin';
  if (!diag.ok) L(S0, 'diagnostics API', 'mac', 'mismatch', `cams-admin did not answer: ${diag.error ?? 'error'}; nothing from cams-admin is checked`);
  const dt = inp.mac.items.diagToken;
  if (!dt?.exists) L(S0, 'diagnostics token', 'mac', 'missing', 'no diag-token file on the Mac');
  else if (dt.fp) {
    if (!diag.ok) L(S0, 'diagnostics token', 'mac', diag.error === 'HTTP 401' ? 'expired' : 'unknown', diag.error === 'HTTP 401' ? 'cams-admin refused it (expired or revoked)' : 'cams-admin not reachable', showFp(dt));
    else {
      const issue = diag.diagIssues.find((i) => i.detail.hashPrefix === dt.sha?.slice(0, 8));
      if (!issue) L(S0, 'diagnostics token', 'mac', 'unknown', 'accepted by cams-admin; its issue record is not in the audit, so its expiry is unknown', showFp(dt));
      else if (typeof issue.detail.days !== 'number') L(S0, 'diagnostics token', 'mac', 'unknown', `accepted; issued ${day(issue.at)}, validity not recorded`, showFp(dt));
      else {
        const e = exp(issue.detail.days === 0 ? null : issue.at + issue.detail.days * DAY);
        L(S0, 'diagnostics token', 'mac', e.status, `accepted by cams-admin; ${e.reason}`, showFp(dt));
      }
    }
  }
  const ot = inp.mac.items.opsToken;
  let macOps: string | undefined;
  if (ot && !ot.exists) L(S0, 'operations token', 'mac', 'missing', 'no ops-token file on the Mac');
  else if (ot?.fp && diag.ok) {
    const t = diag.ops.find((o) => o.hashPrefix === ot.sha?.slice(0, 8));
    macOps = t?.id;
    if (!t) L(S0, 'operations token', 'mac', 'missing', "not in cams-admin's list (another cams-admin, or deleted)", showFp(ot));
    else if (t.state === 'revoked') L(S0, `operations token "${t.name}"`, 'mac', 'mismatch', 'the Mac copy is a revoked token', showFp(ot));
    else {
      const e = exp(t.expiresAt);
      L(S0, `operations token "${t.name}"`, 'mac', t.state === 'expired' ? 'expired' : e.status, `${t.state}; scopes ${(t.scopes ?? []).join(',') || '?'}; ${e.reason}; ${t.lastUsedAt ? `last used ${ago(now, t.lastUsedAt)}` : 'never used'}`, showFp(ot));
    }
  }
  if (diag.ok) {
    for (const t of diag.ops) {
      if (t.state !== 'active' || t.id === macOps) continue;
      const e = exp(t.expiresAt);
      const status: Status = e.status !== 'ok' ? e.status : !t.lastUsedAt && now - t.createdAt > inp.expiringDays * DAY ? 'unused' : 'ok';
      L(S0, `operations token "${t.name}"`, 'cams-admin', status, `active, not the Mac's copy; scopes ${(t.scopes ?? []).join(',') || '?'}; ${e.reason}; ${t.lastUsedAt ? `last used ${ago(now, t.lastUsedAt)}` : `never used (issued ${day(t.createdAt)})`}`, `sha256:${t.hashPrefix}`);
    }
  }
  const sk = inp.mac.items.signingKey;
  const signingFp = sk?.fingerprint;
  if (sk && !sk.exists) L(S0, 'signing key', 'mac', 'unknown', 'no copy on the Mac: the proxies\' pins are not compared');
  else if (sk?.error) L(S0, 'signing key', 'mac', 'unknown', `could not read its public key (${sk.error})`);
  else if (signingFp) L(S0, 'signing key', 'mac', 'ok', `public key ${short(signingFp)}; a private key copy on the Mac (runbook gap 2)`);

  // Viewer tokens of the accounts in scope.
  if (diag.ok) {
    for (const v of diag.viewers.filter((x) => x.accountIds.some((a) => scope.accountIds.includes(a)))) {
      const S = `account ${v.accountIds.map(accName).join(',')}`;
      const cred = `viewer token "${v.name}"`;
      if (v.state === 'revoked') continue;
      if (v.state === 'expired') { L(S, cred, 'cams-admin', 'expired', `expired ${day(v.expiresAt)}; still listed (delete it or change its validity)`, `fp ${v.fingerprintPrefix}`, 'warn'); continue; }
      const e = exp(v.expiresAt);
      const status: Status = e.status !== 'ok' ? e.status : v.lastUsedAt === null ? 'unused' : 'ok';
      L(S, cred, 'cams-admin', status, `${e.reason}; ${v.lastUsedAt ? `last used ${ago(now, v.lastUsedAt)}` : 'never used'}`, `fp ${v.fingerprintPrefix}`);
    }
  }

  // Each proxy in scope.
  const hostOfProxy = (name: string) => scope.hosts.find((h) => h.proxy === name);
  const checkedAdminTokens: { host: string; fp: string }[] = [];
  for (const h of scope.hosts) {
    const v = inp.hosts[h.name]?.items?.env?.vars?.CAMPROXY_ADMIN_TOKEN;
    if (v?.fp) checkedAdminTokens.push({ host: h.name, fp: v.fp });
  }
  for (const px of scope.proxies) {
    const S = `proxy ${px.name}`;
    const hc = hostOfProxy(px.name);
    const hr = hc ? inp.hosts[hc.name] : undefined;
    const it = hr?.items;
    const api = it?.api;
    const hostNote = !hc ? 'no host in the config' : !hc.ssh ? 'no ssh (cams-admin\'s view only)' : hr?.error ? `host not reached (${hr.error})` : null;

    // Enrollment and the proxy key.
    if (px.registryState !== 'enrolled') L(S, 'proxy key (enrollment)', 'cams-admin', 'missing', `registry state ${px.registryState}`);
    else if (px.state !== 'online') L(S, 'proxy key (enrollment)', 'cams-admin', 'mismatch', `enrolled but ${px.state}${px.lastHeartbeatAt ? `, last heartbeat ${ago(now, px.lastHeartbeatAt)}` : ''}`);
    else L(S, 'proxy key (enrollment)', 'cams-admin', 'ok', `enrolled, online, heartbeat ${px.lastHeartbeatAt ? ago(now, px.lastHeartbeatAt) : 'unknown'}${px.version ? `, ${px.version}` : ''}`);
    if (api?.admin && !api.admin.error) {
      const a = api.admin;
      if (a.proxyId !== px.id) L(S, 'proxy key (enrollment)', `host ${hc!.name}`, 'mismatch', `the host's key is for ${a.proxyId ?? 'no proxy'}, cams-admin has ${px.id}`);
      else if (a.state !== 'connected') L(S, 'proxy key (enrollment)', `host ${hc!.name}`, 'mismatch', `the proxy says ${a.state}`);
      else L(S, 'proxy key (enrollment)', `host ${hc!.name}`, 'ok', `connected as ${px.id} (account ${a.account ?? '?'})`);
    }

    // The signing key it pins.
    const pk = it?.proxyKey;
    if (pk?.serverKeyFingerprints) {
      if (!signingFp) L(S, 'signing key pin', `host ${hc!.name}`, 'unknown', `pins ${pk.serverKeyFingerprints.map(short).join(', ')}; no Mac copy to compare`);
      else if (pk.serverKeyFingerprints.includes(signingFp)) L(S, 'signing key pin', `host ${hc!.name}`, 'ok', `pins the Mac's signing key ${short(signingFp)}`);
      else L(S, 'signing key pin', `host ${hc!.name}`, 'mismatch', `pins ${pk.serverKeyFingerprints.map(short).join(', ')}, the Mac's key is ${short(signingFp)}`);
    } else L(S, 'signing key pin', hc ? `host ${hc.name}` : 'host', 'unknown', hostNote ?? (pk?.exists === false ? 'no key.json' : 'key.json not read'));

    // Site CA: the proxy's own, what it reports, the registry's pins.
    const reported = px.reported?.caFingerprints ?? [];
    const own = api?.tls && !api.tls.error ? api.tls.caFingerprint ?? null : undefined;
    if (!px.caFingerprints.length && !reported.length && !own) L(S, 'site CA', 'cams-admin', 'unknown', 'no site CA (none reported, no pins)');
    else {
      const parts: string[] = [];
      let bad = false;
      if (own !== undefined) { parts.push(`proxy ${own ? short(own) : 'none'}`); if (own && !px.caFingerprints.includes(own)) bad = true; }
      parts.push(`reported ${reported.map(short).join(',') || 'none'}`);
      parts.push(`registry pins ${px.caFingerprints.map(short).join(',') || 'none'}`);
      if (px.pin === 'mismatch' || reported.some((r) => !px.caFingerprints.includes(r))) bad = true;
      L(S, 'site CA', 'proxy vs cams-admin', bad ? 'mismatch' : 'ok', parts.join('; '));
      if (px.pinsNotSentTo?.length) L(S, 'site CA', 'cams-admin', 'mismatch', `pins not sent to ${px.pinsNotSentTo.map((p) => p.name).join(', ')} (plain-http route)`);
      const t = api?.tls;
      if (t && !t.error) {
        if (t.caNotAfter) { const e = exp(t.caNotAfter); if (e.status !== 'ok') L(S, 'site CA', `host ${hc!.name}`, e.status, `the CA ${e.reason}`); }
        const leaves = [...(t.proxy?.notAfter ? [{ id: 'proxy', notAfter: t.proxy.notAfter, problem: null }] : []), ...(t.cameras ?? [])];
        for (const l of leaves) {
          if (l.problem) L(S, `certificate ${l.id}`, `host ${hc!.name}`, 'mismatch', l.problem);
          else if (l.notAfter) { const e = exp(l.notAfter); if (e.status !== 'ok') L(S, `certificate ${l.id}`, `host ${hc!.name}`, e.status, `${e.reason} (renewal is due 30 days ahead)`); }
        }
      }
    }

    // Managed tokens: cams-admin's registry vs the proxy's own set.
    const reg = diag.tokens.find((t) => t.proxyId === px.id)?.tokens ?? [];
    const onHost = api?.tokens && !api.tokens.error ? api.tokens.items ?? [] : null;
    for (const t of reg) {
      const cred = `managed ${t.kind} token ${t.id} (${t.holder === 'manual' ? `manual "${t.label}"` : t.holderName ?? `removed instance ${t.holder}`})`;
      const local = onHost?.find((x) => x.id === t.id);
      const fp = local ? local.hashPrefix : undefined;
      if (t.state === 'revoked') {
        if (local && local.live && !local.blocked) L(S, cred, `host ${hc!.name}`, 'mismatch', 'revoked in cams-admin but live on the proxy', fp);
        continue;
      }
      if (t.state === 'pending') { L(S, cred, 'cams-admin', 'unknown', 'pending: not on the proxy yet'); continue; }
      const parts = [t.state];
      let status: Status = 'ok';
      if (t.state === 'retiring' && t.retireAt) {
        if (t.retireAt < now - 3600_000) { status = 'expired'; parts.push(`retiring past due (since ${ago(now, t.retireAt)})`); }
        else parts.push(`retires ${inTime(now, t.retireAt)}`);
      }
      if (t.holder === 'manual') { status = status === 'ok' ? 'unused' : status; parts.push('held by no cams instance'); }
      else if (!t.holderName) { status = 'mismatch'; parts.push('its holder is no longer a cams instance'); }
      if (!t.onProxy) { status = 'mismatch'; parts.push('not on the proxy per cams-admin'); }
      if (onHost) {
        if (!local) { status = 'missing'; parts.push('not in the proxy\'s own set'); }
        else if (!local.live || local.blocked) { status = 'mismatch'; parts.push(local.blocked ? 'blocked on the proxy' : 'not live on the proxy'); }
        else parts.push('live on the proxy');
      }
      L(S, cred, onHost ? `cams-admin + host ${hc!.name}` : 'cams-admin', status, parts.join('; '), fp);
    }
    if (onHost) {
      for (const x of onHost) if (!reg.some((t) => t.id === x.id)) L(S, `managed ${x.kind} token ${x.id}`, `host ${hc!.name}`, 'mismatch', `on the proxy${x.live ? ' and live' : ''}, unknown to cams-admin`, x.hashPrefix);
    } else if (px.reported?.tokens) {
      const live = reg.filter((t) => t.state === 'active' || t.state === 'retiring');
      const c = live.filter((t) => t.kind === 'client').length;
      const a = live.filter((t) => t.kind === 'admin').length;
      const r = px.reported.tokens;
      L(S, 'managed tokens (counts)', 'proxy report', r.client === c && r.admin === a ? 'ok' : 'mismatch', `proxy reports ${r.client} client + ${r.admin} admin, cams-admin has ${c} + ${a} live${hostNote ? ` (${hostNote})` : ''}`);
    }
    // Every cams instance with a route to this proxy holds a live client and admin token.
    for (const inst of diag.instances.filter((i) => i.state === 'enrolled' && i.routes.some((r) => r.proxyId === px.id && !r.hidden) && !i.accounts.includes(px.accountId))) {
      L(S, `route of cams ${inst.name}`, 'cams-admin', 'unused', `a route to this proxy for account ${accName(px.accountId)}, which the instance no longer serves (it holds no tokens for it)`);
    }
    for (const inst of diag.instances.filter((i) => i.state === 'enrolled' && i.accounts.includes(px.accountId) && i.routes.some((r) => r.proxyId === px.id && !r.hidden))) {
      const held = reg.filter((t) => t.holder === inst.id && (t.state === 'active' || t.state === 'retiring'));
      const kinds = ['client', 'admin'].filter((k) => !held.some((t) => t.kind === k));
      if (kinds.length) L(S, `tokens of cams ${inst.name}`, 'cams-admin', 'missing', `no active ${kinds.join(' or ')} token for a viewer that routes to this proxy`);
      else L(S, `tokens of cams ${inst.name}`, 'cams-admin', 'ok', `holds ${held.filter((t) => t.state === 'active').length} active (+${held.filter((t) => t.state === 'retiring').length} retiring)`);
    }

    // The local env credentials (hosts with a shell only).
    const env = it?.env;
    if (!env || !env.exists) {
      L(S, 'local admin token and env secrets', hc ? `host ${hc.name}` : 'host', 'unknown', hostNote ?? 'config/.env not found');
    } else {
      fileModeLines(L, S, `host ${hc!.name}`, 'config/.env', env);
      const vars = env.vars ?? {};
      for (const [name, v] of Object.entries(vars)) if (v.via === 'file') fileModeLines(L, S, `host ${hc!.name}`, `config/${v.file}`, v);
      // Admin token: the host's vs its copies.
      const at = vars.CAMPROXY_ADMIN_TOKEN;
      if (!at?.fp) L(S, 'local admin token', `host ${hc!.name}`, 'missing', at?.exists === false ? `CAMPROXY_ADMIN_TOKEN_FILE names a missing file` : 'CAMPROXY_ADMIN_TOKEN not set');
      else {
        const copies = pool.filter((p) => p.role === 'admin-token' && p.host === hc!.name && p.where === 'mac');
        const label = `${hc!.name} config/.env CAMPROXY_ADMIN_TOKEN`;
        for (const c of copies) L(S, 'local admin token', where(c), c.fp === at.fp ? 'ok' : 'mismatch', c.fp === at.fp ? 'same as the host' : 'differs from the host\'s', showFp(c));
        const shared = checkedAdminTokens.filter((x) => x.host !== hc!.name && x.fp === at.fp).map((x) => x.host);
        L(S, 'local admin token', `host ${hc!.name}`, shared.length ? 'mismatch' : 'ok', shared.length ? `the same token as ${shared.join(', ')} (one leak opens both)` : `set; never expires; not shared with another checked host${copies.length ? '' : '; no Mac copy configured or found'}`, showFp(at));
        const hostCopies = pool.filter((p) => p.fp === at.fp && p.where === hc!.name && p.label !== label);
        for (const c of hostCopies) L(S, 'local admin token', where(c), 'ok', 'same as the host\'s value', showFp(c));
      }
      // Client tokens in the env: who holds each?
      for (const [i, f] of (vars.CAMPROXY_TOKENS?.list ?? []).entries()) {
        const holders = pool.filter((p) => p.fp === f.fp && p.store !== 'env' && !(p.where === hc!.name && p.role === 'client-token'));
        const shared = pool.filter((p) => p.fp === f.fp && p.store === 'env' && p.where !== hc!.name);
        const note = shared.length ? `; also in ${shared.map((s) => s.where).join(', ')}` : '';
        const viewers = holders.filter((h) => h.where !== 'mac');
        if (viewers.length) L(S, `CAMPROXY_TOKENS #${i + 1}`, `host ${hc!.name}`, 'ok', `held by ${names(viewers)}${note}`, showFp(f));
        else if (holders.length) L(S, `CAMPROXY_TOKENS #${i + 1}`, `host ${hc!.name}`, 'unused', `only the Mac has a copy (${names(holders)}); no viewer holds it${note}`, showFp(f));
        else L(S, `CAMPROXY_TOKENS #${i + 1}`, `host ${hc!.name}`, 'unused', `no holder found (cams uses managed tokens)${note}`, showFp(f));
      }
      if (vars.CAMPROXY_TOKENS?.empty || (vars.CAMPROXY_TOKENS && !vars.CAMPROXY_TOKENS.list?.length && !vars.CAMPROXY_TOKENS.list)) L(S, 'CAMPROXY_TOKENS', `host ${hc!.name}`, 'ok', 'set but empty');
      const aud = vars.CAMPROXY_AUDIT_TOKEN;
      if (aud?.fp) {
        const holders = others({ fp: aud.fp, label: `${hc!.name} config/.env CAMPROXY_AUDIT_TOKEN` }).filter((p) => p.where !== hc!.name);
        L(S, 'CAMPROXY_AUDIT_TOKEN', `host ${hc!.name}`, holders.length ? 'ok' : 'unused', holders.length ? `held by ${names(holders)}` : 'set, no known reader (runbook gap 5)', showFp(aud));
      }
      // FTP password: copies, then each camera's upload status.
      const ftp = vars.CAMPROXY_FTP_PASSWORD;
      if (ftp?.fp) {
        const copies = pool.filter((p) => p.role === 'ftp' && p.where === 'mac' && p.host === hc!.name);
        for (const c of copies) L(S, 'FTP password', where(c), c.fp === ftp.fp ? 'ok' : 'mismatch', c.fp === ftp.fp ? 'same as the host' : 'differs from the host\'s', showFp(c));
        const shared = pool.filter((p) => p.role === 'ftp' && p.store === 'env' && p.where !== hc!.name && p.fp === ftp.fp).map((p) => p.where);
        L(S, 'FTP password', `host ${hc!.name}`, 'ok', `set${shared.length ? `; the same as ${shared.join(', ')}` : ''}; never expires`, showFp(ftp));
      }
      // Leftover env copies.
      const backups = [...(it?.envBackups?.files ?? []), ...(it?.envBackupsTop?.files ?? [])];
      if (backups.length) {
        const stale = new Set<string>();
        const holding: string[] = [];
        for (const b of backups) {
          let any = false;
          for (const [name, bv] of Object.entries(b.vars ?? {})) {
            const cur = vars[name];
            const same = cur && (bv.list ? JSON.stringify(bv.list.map((x) => x.fp)) === JSON.stringify(cur.list?.map((x) => x.fp)) : bv.fp === cur.fp);
            if (!same && (bv.fp || bv.list?.length)) { stale.add(name); any = true; }
          }
          if (any) holding.push(b.name);
          if (badMode(b.mode)) L(S, 'env backup file', `host ${hc!.name} ${b.name}`, 'mismatch', `mode ${b.mode}: readable by others`);
        }
        L(S, 'env backup files', `host ${hc!.name}`, stale.size ? 'unused' : 'ok', stale.size ? `${holding.length} of ${backups.length} backup env files hold superseded values (${[...stale].sort().join(', ')}): ${holding.join(', ')}` : `${backups.length} backup env files, no value differs from the live one`);
      }
      // Camera password variables no camera of this proxy logs in with.
      const camList = Array.isArray(api?.cameras) ? (api!.cameras as ApiCamera[]) : null;
      if (camList) {
        const used = new Set(camList.filter((c) => c.credentials?.source === 'env').map((c) => (c.credentials?.envName ?? '').replace(/_FILE$/, '')));
        for (const [name, v] of Object.entries(vars)) {
          if (!/^CAMPROXY_CAMERA_PASSWORD/.test(name) || !v.fp || used.has(name)) continue;
          const twins = pool.filter((p) => p.fp === v.fp && p.label !== `${hc!.name} config/.env ${name}`);
          L(S, name, `host ${hc!.name}`, 'unused', `no camera on this proxy logs in with it${camList.length ? '' : ' (the proxy has no camera)'}${twins.length ? `; same as ${names(twins)}` : ''}`, showFp(v));
        }
      }
      // Other secrets in the env (Vision key, legacy switch password, cams' own).
      for (const [name, v] of Object.entries(vars)) {
        if (['CAMPROXY_ADMIN_TOKEN', 'CAMPROXY_TOKENS', 'CAMPROXY_AUDIT_TOKEN', 'CAMPROXY_FTP_PASSWORD'].includes(name) || /^CAMPROXY_CAMERA_PASSWORD/.test(name)) continue;
        if (!v.fp) continue;
        const label = `${hc!.name} config/.env ${name}`;
        const elsewhere = others({ fp: v.fp, label }).filter((p) => !(p.where === hc!.name && p.store === 'cams'));
        if (name === 'CAMPROXY_POE_SWITCH_PASSWORD') L(S, name, `host ${hc!.name}`, 'unused', `retired variable (switch passwords live in data/admin/switch-passwords.json)${elsewhere.length ? `; same as ${names(elsewhere)}` : ''}`, showFp(v));
        else if (name === 'CAMS_LOGIN_TOKEN' || name === 'COOKIE_SECRET') continue; // the cams section reports these
        else L(S, name, `host ${hc!.name}`, 'ok', `set${elsewhere.length ? `; same as ${names(elsewhere)}` : '; no other copy found'}`, showFp(v));
      }
    }

    // FTP and camera logins from the proxy's own status (cams-admin's onboarding report without a host).
    const apiCams = Array.isArray(api?.cameras) ? (api!.cameras as ApiCamera[]) : null;
    const regCams = diag.cameras.filter((c) => c.proxyId === px.id);
    const onb = px.reported?.onboarding ?? null;
    const camIds = apiCams ? apiCams.map((c) => c.id) : Object.keys(onb ?? {}).length ? Object.keys(onb!) : regCams.map((c) => c.proxyCameraId ?? c.camsId);
    for (const cam of camIds) {
      const a = apiCams?.find((c) => c.id === cam);
      const o = onb?.[cam];
      // FTP
      if (a?.ftp) {
        const f = a.ftp;
        if (!f.enabled) L(S, `FTP upload ${cam}`, 'proxy status', 'ok', 'FTP off on this proxy');
        else if (!f.passwordSet) L(S, `FTP upload ${cam}`, 'proxy status', 'missing', 'no FTP password on the proxy');
        else if (f.camera && f.camera.state !== 'on') L(S, `FTP upload ${cam}`, 'proxy status', 'mismatch', `the camera's FTP upload: ${f.camera.state}${f.camera.error ? ` (${f.camera.error})` : ''}`);
        else if (f.camera?.mismatch?.length) L(S, `FTP upload ${cam}`, 'proxy status', 'mismatch', `the camera's FTP ${f.camera.mismatch.join(', ')} differ (run camera-ftp-setup)`);
        else if (f.stalled) L(S, `FTP upload ${cam}`, 'proxy status', 'mismatch', `uploads stalled${f.lastUpload ? `; last upload ${ago(now, f.lastUpload)}` : ''}`);
        else if ((f.failures ?? 0) > 0) L(S, `FTP upload ${cam}`, 'proxy status', 'mismatch', `${f.failures} failed FTP logins or uploads`);
        else L(S, `FTP upload ${cam}`, 'proxy status', f.lastUpload ? 'ok' : 'unknown', `camera uploads here${f.lastUpload ? `; last upload ${ago(now, f.lastUpload)}` : '; no upload yet'}; 0 failures (the password itself is only on the camera)`);
      } else if (o) L(S, `FTP upload ${cam}`, 'cams-admin onboarding', o.missing.includes('ftp') ? 'mismatch' : 'ok', o.missing.includes('ftp') ? 'the proxy reports the FTP step not ok' : `FTP step ok per the proxy's report${hostNote ? ` (${hostNote})` : ''}`);
      // Camera login
      cameraPasswordLines(L, S, cam, a, o, it, pool, hc?.name, hostNote);
    }

    // PoE switch passwords this proxy operates.
    const sws = Array.isArray(api?.switches) ? (api!.switches as { id: string; passwordSet: boolean; passwordElsewhere: boolean }[]) : [];
    const diagSw = (diag.switches[px.accountId] ?? []).filter((s) => s.proxyId === px.id);
    for (const s of sws) {
      const ds = diagSw.find((d) => d.id === s.id);
      const probs = (ds?.problems ?? []).map((p) => (typeof p === 'string' ? p : (p as { code?: string }).code ?? JSON.stringify(p)));
      const auth = probs.filter((p) => /auth|password/.test(p));
      const stored = (it?.switchPasswords?.entries ?? []).find((e) => e.path === `switches.${s.id}`)?.secrets.password;
      const name = `PoE switch password ${ds?.name ? `"${ds.name}" ` : ''}${s.id}`;
      if (!s.passwordSet) L(S, name, `host ${hc!.name}`, 'missing', s.passwordElsewhere ? 'set on another proxy' : 'not set on the operating proxy');
      else L(S, name, `host ${hc!.name}`, auth.length ? 'mismatch' : 'ok', auth.length ? `cams-admin reports ${auth.join(', ')}` : `set; cams-admin reports ${probs.length ? probs.join(', ') : 'no problem'}`, stored ? showFp(stored) : undefined);
      if (stored) {
        for (const c of pool.filter((p) => p.role === 'switch-password' && p.label !== `${hc!.name} data/admin/switch-passwords.json ${s.id}`)) {
          if (c.where === hc!.name && c.store === 'env') continue; // the retired variable has its own line
          L(S, name, where(c), c.fp === stored.fp ? 'ok' : 'mismatch', c.fp === stored.fp ? 'same as the operating proxy\'s' : 'differs from the operating proxy\'s', showFp(c));
        }
      }
    }
    if (!sws.length && diagSw.length) for (const ds of diagSw) L(S, `PoE switch password "${ds.name}"`, 'cams-admin', 'unknown', `${hostNote ?? 'proxy not read'}; cams-admin reports ${ds.problems.length ? JSON.stringify(ds.problems) : 'no problem'}`);
  }

  // Each cams instance in scope.
  for (const inst of scope.instances) {
    const S = `cams ${inst.name}`;
    const hc = scope.hosts.find((h) => h.cams === inst.name);
    const it = hc ? inp.hosts[hc.name]?.items : undefined;
    const r = inst.report;
    const issues: string[] = [];
    if (inst.state !== 'enrolled') issues.push(`state ${inst.state}`);
    if (!r) issues.push('no report');
    else {
      if (r.current === false) issues.push('not on the current snapshot revision');
      if (r.tokens?.pending) issues.push(`${r.tokens.pending} pending tokens`);
      if (r.tokens?.legacy) issues.push(`${r.tokens.legacy} legacy tokens`);
      for (const p of r.problems ?? []) issues.push(`${p.code}${p.detail ? ` (${p.detail})` : ''}`);
    }
    if (inst.lastSeenAt && now - inst.lastSeenAt > 15 * 60_000) issues.push(`last seen ${ago(now, inst.lastSeenAt)}`);
    L(S, 'instance key (enrollment)', 'cams-admin', issues.length ? (inst.state !== 'enrolled' ? 'missing' : 'mismatch') : 'ok', issues.length ? issues.join('; ') : `enrolled, current revision, ${r?.tokens?.managed ?? 0} managed tokens, seen ${inst.lastSeenAt ? ago(now, inst.lastSeenAt) : '?'}`);
    const k = it?.camsKey;
    const hostNote = !hc ? 'no host in the config for this instance' : !hc.ssh ? "no ssh (cams-admin's view only)" : inp.hosts[hc.name]?.error ? `host not reached (${inp.hosts[hc.name].error})` : null;
    if (k?.exists) {
      fileModeLines(L, S, `host ${hc!.name}`, 'cams data/admin/key.json', k);
      if (k.instanceId !== inst.id) L(S, 'instance key', `host ${hc!.name}`, 'mismatch', `key.json is for ${k.instanceId ?? '?'}, cams-admin has ${inst.id}`);
      else if (!signingFp) L(S, 'signing key pin', `host ${hc!.name}`, 'unknown', `pins ${(k.serverKeyFingerprints ?? []).map(short).join(', ')}; no Mac copy to compare`);
      else L(S, 'signing key pin', `host ${hc!.name}`, (k.serverKeyFingerprints ?? []).includes(signingFp) ? 'ok' : 'mismatch', `pins ${(k.serverKeyFingerprints ?? []).map(short).join(', ')}`);
    } else L(S, 'instance key / signing key pin', hc ? `host ${hc.name}` : 'host', 'unknown', hostNote ?? 'key.json not found');
    // CA pins as cams has them (its signed cache) vs the registry.
    const cache = it?.camsCache;
    for (const px of scope.proxies.filter((p) => inst.routes.some((r) => r.proxyId === p.id && !r.hidden))) {
      if (cache?.accounts) {
        const cp = cache.accounts.flatMap((a) => a.proxies).find((p) => p.id === px.id);
        if (!cp) L(S, `CA pins for ${px.name}`, `host ${hc!.name}`, 'missing', 'the proxy is not in cams\' cached snapshot');
        else L(S, `CA pins for ${px.name}`, `host ${hc!.name}`, same(cp.caFingerprints, px.caFingerprints) ? 'ok' : 'mismatch', `cams ${cp.caFingerprints.map(short).join(',') || 'none'}, registry ${px.caFingerprints.map(short).join(',') || 'none'}`);
      } else L(S, `CA pins for ${px.name}`, 'cams-admin', r?.current ? 'ok' : 'unknown', r?.current ? 'the instance applied the current snapshot, which carries the registry pins (inferred)' : `${hostNote ?? 'cache not read'}; snapshot not current`);
    }
    // The proxy tokens it holds in plaintext (hosts with a shell only).
    const ct = it?.camsTokens;
    if (ct?.exists) {
      fileModeLines(L, S, `host ${hc!.name}`, 'cams data/admin/tokens.json', ct);
      for (const e of ct.entries ?? []) {
        const id = String(e.ctx.id ?? '');
        const f = e.secrets.token;
        const pxId = String(e.ctx.proxyId ?? '');
        const pxName = diag.proxies.find((p) => p.id === pxId)?.name ?? pxId;
        const reg = diag.tokens.flatMap((t) => t.tokens.map((x) => ({ ...x, proxyId: t.proxyId }))).find((x) => x.id === id);
        const cred = `held ${String(e.ctx.kind ?? '')} token ${id || '(unregistered)'} for ${pxName}`;
        if (e.hashOk === false) { L(S, cred, `host ${hc!.name}`, 'mismatch', 'the stored hash is not the token\'s', showFp(f)); continue; }
        if (!id) { L(S, cred, `host ${hc!.name}`, 'unknown', 'not registered yet', showFp(f)); continue; }
        if (!reg) { L(S, cred, `host ${hc!.name}`, 'unused', 'unknown to cams-admin (its proxy or account is gone): a stale plaintext copy', showFp(f)); continue; }
        if (reg.holder !== inst.id) { L(S, cred, `host ${hc!.name}`, 'mismatch', `cams-admin says ${reg.holderName ?? reg.holder} holds it`, showFp(f)); continue; }
        if (reg.state === 'revoked') { L(S, cred, `host ${hc!.name}`, 'unused', `revoked in cams-admin ${reg.revokedAt ? day(reg.revokedAt) : ''}: a stale plaintext copy`.trim(), showFp(f)); continue; }
        // Compare with the proxy's own hash, when its host was read.
        const ph = scope.hosts.find((h) => h.proxy === pxName);
        const items = ph ? inp.hosts[ph.name]?.items?.api?.tokens?.items : undefined;
        const local = items?.find((x) => x.id === id);
        if (items && !local) L(S, cred, `host ${hc!.name}`, 'missing', `${reg.state} in cams-admin, not on the proxy`, showFp(f));
        else if (local && f?.sha && local.hashPrefix !== `sha256:${f.sha.slice(0, 8)}`) L(S, cred, `host ${hc!.name}`, 'mismatch', `the proxy holds another hash (${local.hashPrefix})`, showFp(f));
        else L(S, cred, `host ${hc!.name}`, 'ok', `${reg.state}${local ? '; the proxy\'s hash matches' : ''}`, showFp(f));
      }
    } else if (hc) L(S, 'held proxy tokens', `host ${hc.name}`, 'unknown', hostNote ?? 'tokens.json not found');
    else L(S, 'held proxy tokens', 'cams-admin', 'unknown', `${hostNote}; cams-admin counts ${r?.tokens?.managed ?? '?'} managed`);
    // The token sign-in of a local viewer and its legacy files.
    const ce = it?.camsEnv;
    if (ce?.exists) {
      const lt = ce.vars?.CAMS_LOGIN_TOKEN;
      const acct = ce.plain?.CAMS_TOKEN_ACCOUNT;
      if (!lt?.fp) L(S, 'CAMS_LOGIN_TOKEN', `host ${hc!.name}`, 'unknown', 'not set (no env token sign-in)');
      else {
        const accOk = !acct || inst.accounts.some((a) => a === acct || inp.accountNames[a] === acct);
        L(S, 'CAMS_LOGIN_TOKEN', `host ${hc!.name}`, accOk ? 'ok' : 'mismatch', `present; account ${acct ?? '(CAMS_TOKEN_ACCOUNT unset)'}${accOk ? '' : ' is not an account this instance serves'}; never expires`, showFp(lt));
      }
      const cs = ce.vars?.COOKIE_SECRET;
      if (cs) L(S, 'COOKIE_SECRET', `host ${hc!.name}`, cs.fp ? 'ok' : 'missing', cs.fp ? 'present; never expires' : 'empty', showFp(cs));
      const mode = ce.plain?.CONFIG_SOURCE;
      const legacy = it?.camsCameras?.entries ?? [];
      if (legacy.length) {
        const detail = legacy.map((e) => {
          const parts = Object.entries(e.secrets).map(([k, f]) => {
            const m = pool.filter((p) => p.fp === f.fp && !(p.store === 'cams' && p.where === hc!.name));
            return `${k}${m.length ? ` = ${where(m[0])}` : ' (matches nothing checked)'}`;
          });
          return `${String(e.ctx.id ?? e.path)}${e.path.endsWith('proxy') ? '.proxy' : ''}: ${parts.join(', ')}`;
        });
        L(S, 'cameras.json secrets', `host ${hc!.name}`, mode === 'cams-admin' ? 'unused' : 'ok', `${mode === 'cams-admin' ? 'CONFIG_SOURCE=cams-admin: legacy copies' : `CONFIG_SOURCE=${mode ?? 'file'}: in use`}; ${detail.join('; ')}`);
      }
    }
  }

  // Mac copies not tied to a checked host: report what each matches.
  const scopeHosts = new Set(scope.hosts.map((h) => h.name));
  const sshHost = (h?: string) => !!h && scope.hosts.some((x) => x.name === h && x.ssh);
  for (const c of pool.filter((p) => p.where === 'mac' && !((p.role === 'admin-token' || p.role === 'ftp') && sshHost(p.host)))) {
    const m = pool.filter((p) => p.fp === c.fp && p.where !== 'mac');
    const inScope = c.host ? scopeHosts.has(c.host) : m.some((p) => scopeHosts.has(p.where));
    if (!inScope && !scope.all) continue;
    const owner = c.host ? scope.hosts.find((h) => h.name === c.host) : undefined;
    if (owner && !owner.ssh && !m.length) { L('mac', c.role, where(c), 'unknown', `the copy for ${owner.name}, which has no ssh: not compared`, showFp(c)); continue; }
    if (m.length) L('mac', c.role, where(c), 'ok', `same as ${names(m)}`, showFp(c));
    else L('mac', c.role, where(c), 'unused', `matches no copy on the checked hosts${c.camera ? ` (camera ${c.camera}${c.user ? `, user ${c.user}` : ''})` : ''}`, showFp(c));
  }
  // Modes of the Mac files.
  for (const [id, r] of Object.entries(inp.mac.items)) if (r?.exists && badMode(r.mode)) L('mac', 'file mode', macLabel(inp, id), 'mismatch', `mode ${r.mode}: readable by others (chmod 600)`);
  return lines;
}

function cameraPasswordLines(L: (s: string, c: string, cp: string, st: Status, r: string, fp?: string) => void, S: string, cam: string, a: ApiCamera | undefined, o: { missing: string[] } | undefined, it: HostResult['items'] | undefined, pool: Copy[], host: string | undefined, hostNote: string | null) {
  const cred = `camera password ${cam}`;
  if (a?.credentials) {
    const c = a.credentials;
    const src = c.source === 'env' ? c.envName ?? 'env' : c.source === 'store' ? 'data/admin/camera-passwords.json' : 'none';
    if (c.source === 'none') L(S, cred, 'proxy login', 'missing', 'the proxy has no password for it');
    else if (c.authOk === false) L(S, cred, 'proxy login', 'mismatch', `the camera refused the password from ${src}`);
    else if (c.authOk === true) L(S, cred, 'proxy login', 'ok', `the camera accepts the proxy's password (from ${src})`);
    else L(S, cred, 'proxy login', 'unknown', `not known yet (password from ${src})`);
  } else if (o) {
    L(S, cred, 'proxy login', o.missing.includes('login') ? 'mismatch' : 'ok', o.missing.includes('login') ? "the proxy's onboarding says the login step is not ok" : `login step ok per the proxy's report${hostNote ? ` (${hostNote})` : ''}`);
  }
  if (!host || !it) return;
  // The value the proxy logs in with, then every other copy of this camera's passwords.
  const envName = a?.credentials?.source === 'env' ? (a.credentials.envName ?? '').replace(/_FILE$/, '') : undefined;
  const effLabel = envName ? `${host} config/.env ${envName}` : a?.credentials?.source === 'store' ? `${host} data/admin/camera-passwords.json ${cam}` : undefined;
  const eff = effLabel ? pool.find((p) => p.label === effLabel) : undefined;
  const loginUser = it.cameraUsers?.users?.[cam] ?? undefined;
  const copies = pool.filter((p) => p.role === 'camera-password' && (p.camera === cam || (p.camera === '*' && p.where === host)) && p !== eff);
  if (eff) {
    const alike = pool.filter((p) => p !== eff && p.fp === eff.fp && p.camera !== cam);
    L(S, cred, where(eff), 'ok', `the proxy's login password${loginUser ? ` (user ${loginUser})` : ''}${alike.length ? `; the same value as ${names(alike)}` : ''}`, showFp(eff));
  }
  for (const c of copies) {
    let st: Status;
    let why: string;
    if (!eff) { st = 'unknown'; why = 'the proxy\'s own value was not found to compare'; }
    else if (c.fp === eff.fp) { st = 'ok'; why = `same as the proxy's login${c.user ? ` (copy for user ${c.user})` : ''}`; }
    else if (c.camera === '*') { st = 'unused'; why = 'the shared CAMPROXY_CAMERA_PASSWORD differs and is not used by this camera'; }
    else if (c.store === 'store' || (c.store === 'env' && c.where === host)) { st = 'unused'; why = 'shadowed by the proxy\'s login source and different from it'; }
    else if (c.user && loginUser && c.user === loginUser) { st = 'mismatch'; why = `a copy for user ${c.user}, the proxy's login user, but it differs`; }
    else if (c.user && !loginUser && !copies.some((x) => x.fp === eff.fp)) {
      const twins = pool.filter((p) => p !== c && p.fp === c.fp);
      st = 'unknown'; why = `a copy for user ${c.user}; the proxy's login user is unknown and no copy of this camera matches its password${twins.length ? `; same as ${names(twins)}` : ''}`;
    }
    else {
      const twins = pool.filter((p) => p !== c && p.fp === c.fp && p !== eff);
      st = twins.length ? 'ok' : 'unknown'; why = `a copy for user ${c.user ?? '?'} (not the proxy's login); ${twins.length ? `same as ${names(twins)}` : 'no other copy to compare, and a camera login is not tried'}`;
    }
    L(S, cred, where(c), st, why, showFp(c));
  }
}

function fileModeLines(L: (s: string, c: string, cp: string, st: Status, r: string) => void, S: string, where: string, file: string, r: { mode?: string; exists?: boolean }) {
  if (r.exists && badMode(r.mode)) L(S, 'file mode', `${where} ${file}`, 'mismatch', `mode ${r.mode}: readable by others (chmod 600)`);
}

const short = (f: string) => (f.startsWith('SHA256:') ? `SHA256:${f.slice(7, 19)}…` : f);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// ---- output ----------------------------------------------------------------

export function exitCode(lines: Line[]): number {
  if (lines.some((l) => l.severity === 'problem')) return 1;
  if (lines.some((l) => l.severity === 'warn')) return 2;
  return 0;
}

export function formatText(lines: Line[], header: string): string {
  const out = [header];
  let section = '';
  for (const l of lines) {
    if (l.section !== section) { section = l.section; out.push('', `== ${section}`); }
    out.push(`${l.status.padEnd(8)} ${l.credential} | ${l.copy}${l.fp ? ` | ${l.fp}` : ''} | ${l.reason}`);
  }
  const count = (s: Severity) => lines.filter((l) => l.severity === s).length;
  out.push('', `${lines.length} lines: ${count('ok')} ok, ${count('info')} unknown, ${count('warn')} warnings, ${count('problem')} problems`);
  return out.join('\n');
}
