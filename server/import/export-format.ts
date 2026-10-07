import { ApiError } from '../registry';
import { checkUrl, FieldError, isCameraUser, normaliseFingerprint } from '../validate';

// The redacted export of a cams cameras.json (cams `export-config`, M §11.1):
// every camera field but the password; tokens only as {sha256: <hex>}; the
// store counts. Parsed strictly: anything secret-shaped is refused, so a file
// with a secret in it never reaches the database or a diff.

export interface ExportProxy { url: string; token: { sha256: string }; adminToken?: { sha256: string }; camera?: string; caFingerprint?: string[]; tlsServername?: string }
export interface ExportCamera {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsServername?: string; webUiUrl?: string | null; webUiNote?: string; user: string; proxy?: ExportProxy;
}
export interface CamsExport {
  v: 1; kind: 'cams-export'; exportedAt: number; camsVersion: string; source: 'cameras-file';
  cameras: ExportCamera[];
  counts: { preferencesUsers: number; proxySwitchOff: number; tlsCas: number; tlsPins: number };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_CAMERAS = 256;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (field: string): never => { throw new ApiError(400, 'invalid', field); };

// A key named like a secret anywhere in the file refuses it (never quoted back).
function noSecrets(v: unknown, path: string): void {
  if (Array.isArray(v)) return v.forEach((x, i) => noSecrets(x, `${path}[${i}]`));
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (/^(password|secret|privateKey|clientSecret)$/i.test(k)) bad(`${path}.${k}`);
    noSecrets(x, `${path}.${k}`);
  }
}

function str(o: Record<string, unknown>, k: string, path: string, max: number, required = true): string | undefined {
  const v = o[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) bad(`${path}.${k}`);
  return (v as string).trim();
}
function hashOf(v: unknown, path: string): { sha256: string } {
  if (!isObj(v) || typeof v.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v.sha256) || Object.keys(v).length !== 1) bad(path);
  return { sha256: ((v as { sha256: string }).sha256).toLowerCase() };
}
function pins(v: unknown, path: string): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : bad(path);
  if (list.length < 1 || list.length > 2) bad(path);
  try {
    return list.map((x) => normaliseFingerprint(x, path));
  } catch (e) {
    if (e instanceof FieldError) bad(path);
    throw e;
  }
}

function proxyOf(v: unknown, path: string): ExportProxy {
  if (!isObj(v)) bad(path);
  const p = v as Record<string, unknown>;
  const url = str(p, 'url', path, 300)!;
  try {
    checkUrl(url, `${path}.url`);
  } catch {
    bad(`${path}.url`);
  }
  const out: ExportProxy = { url, token: hashOf(p.token, `${path}.token`) };
  if (p.adminToken !== undefined) out.adminToken = hashOf(p.adminToken, `${path}.adminToken`);
  if (p.camera !== undefined) {
    if (typeof p.camera !== 'string' || !ID_RE.test(p.camera)) bad(`${path}.camera`);
    out.camera = p.camera as string;
  }
  if (p.caFingerprint !== undefined) out.caFingerprint = pins(p.caFingerprint, `${path}.caFingerprint`);
  if (p.tlsServername !== undefined) {
    if (typeof p.tlsServername !== 'string' || !HOST_RE.test(p.tlsServername)) bad(`${path}.tlsServername`);
    out.tlsServername = p.tlsServername as string;
  }
  return out;
}

export function parseCamsExport(raw: unknown): CamsExport {
  if (!isObj(raw)) bad('file');
  noSecrets(raw, 'file');
  const f = raw as Record<string, unknown>;
  if (f.v !== 1) bad('v');
  if (f.kind !== 'cams-export') bad('kind');
  if (f.source !== 'cameras-file') bad('source');
  if (!Number.isSafeInteger(f.exportedAt)) bad('exportedAt');
  const camsVersion = str(f, 'camsVersion', 'file', 64)!;
  if (!Array.isArray(f.cameras) || f.cameras.length > MAX_CAMERAS) bad('cameras');
  const seen = new Set<string>();
  const cameras = (f.cameras as unknown[]).map((c, i): ExportCamera => {
    const path = `cameras[${i}]`;
    if (!isObj(c)) bad(path);
    const e = c as Record<string, unknown>;
    const id = str(e, 'id', path, 32)!;
    if (!ID_RE.test(id) || seen.has(id)) bad(`${path}.id`);
    seen.add(id);
    const protocol = e.protocol === undefined ? 'https' : e.protocol;
    if (protocol !== 'https' && protocol !== 'http') bad(`${path}.protocol`);
    const out: ExportCamera = { id, name: str(e, 'name', path, 80)!, host: str(e, 'host', path, 253)!, protocol: protocol as 'https' | 'http', user: str(e, 'user', path, 64)! };
    if (!isCameraUser(out.user)) bad(`${path}.user`);
    const tls = str(e, 'tlsServername', path, 253, false);
    if (tls !== undefined) {
      if (!HOST_RE.test(tls)) bad(`${path}.tlsServername`);
      out.tlsServername = tls;
    }
    if (e.webUiUrl !== undefined) {
      if (e.webUiUrl !== null && (typeof e.webUiUrl !== 'string' || !/^https?:\/\/\S+$/.test(e.webUiUrl) || e.webUiUrl.length > 300)) bad(`${path}.webUiUrl`);
      out.webUiUrl = e.webUiUrl as string | null;
    }
    const note = str(e, 'webUiNote', path, 120, false);
    if (note !== undefined) out.webUiNote = note;
    if (e.proxy !== undefined) out.proxy = proxyOf(e.proxy, `${path}.proxy`);
    return out;
  });
  const counts = isObj(f.counts) ? f.counts : bad('counts');
  const n = (k: string) => (Number.isSafeInteger(counts[k]) && (counts[k] as number) >= 0 ? (counts[k] as number) : bad(`counts.${k}`));
  return {
    v: 1, kind: 'cams-export', exportedAt: f.exportedAt as number, camsVersion, source: 'cameras-file', cameras,
    counts: { preferencesUsers: n('preferencesUsers'), proxySwitchOff: n('proxySwitchOff'), tlsCas: n('tlsCas'), tlsPins: n('tlsPins') },
  };
}

// cams's proxy group rule (server/proxy/groupKey.ts) with the token's hash.
export const groupKey = (p: ExportProxy): string => `${p.url.replace(/\/+$/, '')}\0${p.token.sha256}`;
export const trimUrl = (u: string | null | undefined): string | null => (u ? u.replace(/\/+$/, '') : null);
