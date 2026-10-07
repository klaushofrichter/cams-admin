// The column rules of spec §4, in one place. Inputs are API bodies
// (camelCase); outputs are normalised values. Errors name the field.

export class FieldError extends Error {
  constructor(public field: string, message = 'invalid') {
    super(`${field}: ${message}`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(b: Obj, key: string, o: { min?: number; max: number; re?: RegExp; required?: boolean }): string | null | undefined {
  const v = b[key];
  if (v === undefined) {
    if (o.required) throw new FieldError(key, 'required');
    return undefined;
  }
  if (v === null || v === '') {
    if (o.required) throw new FieldError(key, 'required');
    return null;
  }
  if (typeof v !== 'string') throw new FieldError(key);
  const s = v.trim();
  if (s.length < (o.min ?? 0) || s.length > o.max) throw new FieldError(key, 'length');
  if (o.re && !o.re.test(s)) throw new FieldError(key, 'format');
  return s;
}

function oneOf(b: Obj, key: string, values: readonly string[], required = false): string | null | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw new FieldError(key, 'required');
    return undefined;
  }
  if (v === null && !required) return null;
  if (typeof v !== 'string' || !values.includes(v)) throw new FieldError(key);
  return v;
}

function bool(b: Obj, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new FieldError(key);
  return v;
}

// Fill the full shape (null for absent optionals) or keep only given keys.
function shape<T extends Obj>(out: T, partial: boolean, defaults: Obj): Partial<T> {
  const r: Obj = {};
  for (const [k, v] of Object.entries(out)) {
    if (v !== undefined) r[k] = v;
    else if (!partial) r[k] = k in defaults ? defaults[k] : null;
  }
  return r as Partial<T>;
}

function body(b: unknown): Obj {
  if (!isObj(b)) throw new FieldError('body');
  return b;
}

// --- normalisers -------------------------------------------------------------

const EMAIL_RE = /^[^\s@,;"\\]{1,64}@[^\s@,;"\\]{1,190}$/;
export function normaliseEmail(v: unknown, field = 'email'): string {
  if (typeof v !== 'string') throw new FieldError(field);
  const s = v.trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) throw new FieldError(field);
  return s;
}

export function normaliseFingerprint(v: unknown, field = 'fingerprint'): string {
  if (typeof v !== 'string') throw new FieldError(field);
  const hex = v.trim().replace(/^sha256:/i, '').replace(/:/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new FieldError(field);
  return 'SHA256:' + hex.toUpperCase();
}

// cams's proxy.url rule: http(s), no credentials, query or hash.
export function checkUrl(v: string, field: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new FieldError(field);
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || !/^https?:\/\//.test(v)) throw new FieldError(field);
  return v;
}
const url = (b: Obj, key: string) => {
  const s = str(b, key, { max: 300 });
  return typeof s === 'string' ? checkUrl(s, key) : s;
};

// --- entities ----------------------------------------------------------------

export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const PROXY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CAMS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOSTNAME_RE = /^[A-Za-z0-9.-]{1,253}$/;

export interface AccountFields { name: string; displayName: string; notes: string | null }
export function accountInput(raw: unknown, partial: boolean): Partial<AccountFields> {
  const b = body(raw);
  return shape({
    name: str(b, 'name', { max: 32, re: ACCOUNT_NAME_RE, required: !partial }),
    displayName: str(b, 'displayName', { min: 1, max: 80, required: !partial }),
    notes: str(b, 'notes', { max: 2000 }),
  }, partial, {}) as Partial<AccountFields>;
}

export const ROLES = ['admin', 'viewer'] as const;
export interface UserFields { email: string; displayName: string | null; role: 'admin' | 'viewer'; disabled: boolean }
export function userInput(raw: unknown, partial: boolean): Partial<UserFields> {
  const b = body(raw);
  return shape({
    email: b.email === undefined && partial ? undefined : normaliseEmail(b.email),
    displayName: str(b, 'displayName', { max: 80 }),
    role: oneOf(b, 'role', ROLES, !partial),
    disabled: bool(b, 'disabled'),
  }, partial, { disabled: false }) as Partial<UserFields>;
}

export const RUNS_ON = ['cluster', 'local-host', 'cloud'] as const;
export const HOST_KINDS = ['pi', 'mini-pc', 'pc', 'mac', 'vm', 'container', 'other'] as const;
export interface ProxyFields {
  name: string; displayName: string; runsOn: string; hostKind: string | null; url: string | null; adminUiUrl: string | null;
  dnsName: string | null; tlsSite: string | null; tlsServername: string | null; caFingerprints: string[]; notes: string | null;
}
export function proxyInput(raw: unknown, partial: boolean): Partial<ProxyFields> {
  const b = body(raw);
  let caFingerprints: string[] | undefined;
  if (b.caFingerprints !== undefined) {
    if (!Array.isArray(b.caFingerprints) || b.caFingerprints.length > 2) throw new FieldError('caFingerprints');
    caFingerprints = b.caFingerprints.map((f) => normaliseFingerprint(f, 'caFingerprints'));
  }
  return shape({
    name: str(b, 'name', { max: 32, re: PROXY_NAME_RE, required: !partial }),
    displayName: str(b, 'displayName', { min: 1, max: 80, required: !partial }),
    runsOn: oneOf(b, 'runsOn', RUNS_ON, !partial),
    hostKind: oneOf(b, 'hostKind', HOST_KINDS),
    url: url(b, 'url'),
    adminUiUrl: url(b, 'adminUiUrl'),
    dnsName: str(b, 'dnsName', { max: 253, re: HOSTNAME_RE }),
    tlsSite: str(b, 'tlsSite', { max: 63, re: /^[a-z0-9][a-z0-9-]{0,62}$/ }),
    tlsServername: str(b, 'tlsServername', { max: 253, re: HOSTNAME_RE }),
    caFingerprints,
    notes: str(b, 'notes', { max: 2000 }),
  }, partial, { caFingerprints: [] }) as Partial<ProxyFields>;
}

export const CAMERA_KINDS = ['camera', 'sim'] as const;
export interface CameraFields {
  proxyId: string | null; camsId: string; proxyCameraId: string | null; name: string; kind: 'camera' | 'sim'; model: string | null;
  host: string | null; protocol: string | null; tlsServername: string | null; cameraUser: string | null; webUiUrl: string | null;
  webUiNote: string | null; notes: string | null;
}
export function cameraInput(raw: unknown, partial: boolean): Partial<CameraFields> {
  const b = body(raw);
  const out = shape({
    proxyId: str(b, 'proxyId', { max: 40, re: /^prx_[0-9A-Z]{20}$/ }),
    camsId: str(b, 'camsId', { max: 32, re: CAMS_ID_RE, required: !partial }),
    proxyCameraId: str(b, 'proxyCameraId', { max: 32, re: CAMS_ID_RE }),
    name: str(b, 'name', { min: 1, max: 80, required: !partial }),
    kind: oneOf(b, 'kind', CAMERA_KINDS, !partial),
    model: str(b, 'model', { max: 80 }),
    host: str(b, 'host', { max: 253 }),
    protocol: oneOf(b, 'protocol', ['https', 'http']),
    tlsServername: str(b, 'tlsServername', { max: 253, re: HOSTNAME_RE }),
    cameraUser: cameraUserOf(b),
    webUiUrl: url(b, 'webUiUrl'),
    webUiNote: str(b, 'webUiNote', { max: 120 }),
    notes: str(b, 'notes', { max: 2000 }),
  }, partial, {}) as Partial<CameraFields>;
  if (!partial) checkCameraProxy(out as CameraFields);
  return out;
}
// The camera user: ≤ 64 characters, no control or format characters (NUL,
// newlines, bidi overrides): it is a login name, and shown in the audit log.
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;
function cameraUserOf(b: Obj, min = 0): string | null | undefined {
  const v = str(b, 'cameraUser', { min, max: 64 });
  if (typeof v === 'string' && CONTROL_RE.test(v)) throw new FieldError('cameraUser', 'format');
  return v;
}
export const isCameraUser = (v: string): boolean => v.length >= 1 && v.length <= 64 && !CONTROL_RE.test(v);
// A camera behind a proxy needs the proxy's id for it.
export function checkCameraProxy(c: Pick<CameraFields, 'proxyId' | 'proxyCameraId'>): void {
  if (c.proxyId && !c.proxyCameraId) throw new FieldError('proxyCameraId', 'required with proxyId');
}

export const SIM_RUNS_ON = ['mac', 'cluster', 'pi', 'pc', 'cloud', 'other'] as const;
export interface SimFields { runsOn: string; controlUrl: string | null; uiUrl: string | null; image: string | null; notes: string | null }
export function simInput(raw: unknown): SimFields {
  const b = body(raw);
  return shape({
    runsOn: oneOf(b, 'runsOn', SIM_RUNS_ON, true),
    controlUrl: url(b, 'controlUrl'),
    uiUrl: url(b, 'uiUrl'),
    image: str(b, 'image', { max: 200 }),
    notes: str(b, 'notes', { max: 2000 }),
  }, false, {}) as SimFields;
}

// A per-instance camera override (migration 7): only host and cameraUser.
// The host as cams dials it: a hostname or IPv4 (an IPv6 address in
// brackets) with an optional port, or "from-proxy"; the user as the camera's.
const CAMERA_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::([0-9]{1,5}))?$/;
export function checkCameraHost(v: string, field = 'host'): string {
  const m = CAMERA_HOST_RE.exec(v);
  if (!m || v.length > 253 || (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535))) throw new FieldError(field, 'format');
  return v;
}
export interface CameraOverrideFields { host: string | null; cameraUser: string | null }
export function cameraOverrideInput(raw: unknown): CameraOverrideFields & { version: number | undefined } {
  const b = body(raw);
  for (const k of Object.keys(b)) if (!['host', 'cameraUser', 'version'].includes(k)) throw new FieldError(k, 'unknown');
  const host = str(b, 'host', { max: 253 }) ?? null;
  if (host !== null) checkCameraHost(host);
  const cameraUser = cameraUserOf(b, 1) ?? null;
  if (host === null && cameraUser === null) throw new FieldError('host', 'required: host or cameraUser');
  if (b.version !== undefined && !Number.isInteger(b.version)) throw new FieldError('version');
  return { host, cameraUser, version: b.version as number | undefined };
}
