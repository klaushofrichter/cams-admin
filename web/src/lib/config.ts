// P3: a proxy's settings as the Settings card shows them, and the text of
// settings commands. The rules mirror the contract (remote-settable.json):
// the proxy re-checks everything; this only keeps the editor honest.
import remoteSettable from '../../../contract/v1/remote-settable.json';
import { cmdStateText } from './commands';

export type Leaf = boolean | number | string;
export interface ConfigPath { v?: unknown; s: 'default' | 'file' | 'override' | 'env'; r?: 'restart' | 'process'; p?: true; n?: unknown; by?: { cmdId: string; actor: string; at: number } }
export interface Settable { type: 'integer' | 'boolean' | 'string'; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }
export interface ConfigView {
  revision: string; schema: number | null; cameras: string[]; omittedCameras: string[]; paths: Record<string, ConfigPath>; settable: Record<string, Settable>;
  fetchedAt: number; cmdId: string; clampedPaths?: number;
}
export interface Change { path: string; from?: unknown; to?: unknown; sourceFrom: string; sourceTo: string; restart?: 'restart' | 'process' }
export interface Row { path: string; label: string; p: ConfigPath; editable: boolean; why?: string }
export interface Group { group: string; camera?: string; rows: Row[] }

const REMOTE = new Set<string>(remoteSettable.remote);
const NARROW = remoteSettable.narrow as Record<string, 'less' | 'more'>;
const PATH_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$/;
const UNSET_IS_NO_CAP = new Set(['stills.maxGB', 'previews.maxGB', 'ftp.maxGB']);
const ZERO_IS_NO_CAP = new Set(['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap']);
const STORAGE = /^(storage(\.|$)|cameras\.[^.]+\.storage(\.|$))/;

export const patternOf = (path: string): string => path.replace(/^cameras\.[^.]+\./, 'cameras.*.');

export function isRemoteSettable(path: string, settable: Record<string, Settable>): boolean {
  const pat = patternOf(path);
  return PATH_RE.test(path) && REMOTE.has(pat) && Object.hasOwn(settable, pat);
}

export function narrowNote(path: string): string | null {
  if (STORAGE.test(path)) return 'storage settings are local only';
  const dir = NARROW[patternOf(path)];
  return dir === 'more' ? 'only higher from cams-admin (keeps data longer)' : dir === 'less' ? 'only lower from cams-admin (spending)' : null;
}

// The contract's narrow rule (same as the server's pre-check).
export function narrowOk(path: string, from: unknown, to: unknown): boolean {
  const pat = patternOf(path);
  const dir = NARROW[pat];
  if (!dir) return true;
  if (typeof from === 'boolean' || typeof to === 'boolean') return to === from || (dir === 'less' ? to === false : to === true);
  const size = (x: unknown) => (x === undefined || x === null ? (UNSET_IS_NO_CAP.has(pat) ? Infinity : NaN) : typeof x !== 'number' ? NaN : ZERO_IS_NO_CAP.has(pat) && x === 0 ? Infinity : x);
  const f = size(from);
  const t = size(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return false;
  return dir === 'less' ? t <= f : t >= f;
}

function why(path: string, p: ConfigPath, settable: Record<string, Settable>): { editable: boolean; why?: string } {
  if (p.s === 'env') return { editable: false, why: "set in the proxy's environment" };
  if (STORAGE.test(path)) return { editable: false, why: 'storage settings are local only' };
  if (!isRemoteSettable(path, settable)) return { editable: false, why: 'never remote (addresses, ports, files, trust, users)' };
  const dir = NARROW[patternOf(path)];
  return dir ? { editable: true, why: dir === 'less' ? 'only lower from cams-admin' : 'only higher from cams-admin' } : { editable: true };
}

// Grouped as the proxy's Settings page: by top-level key, each camera its own group (last).
export function groupPaths(view: ConfigView): Group[] {
  const groups = new Map<string, Group>();
  for (const path of Object.keys(view.paths).sort()) {
    const cam = /^cameras\.([^.]+)\.(.+)$/.exec(path);
    const key = cam ? `~cameras/${cam[1]}` : path.split('.')[0];
    const label = cam ? cam[2] : path.slice(path.indexOf('.') + 1) || path;
    if (!groups.has(key)) groups.set(key, cam ? { group: 'cameras', camera: cam[1], rows: [] } : { group: key, rows: [] });
    const w = why(path, view.paths[path], view.settable);
    groups.get(key)!.rows.push({ path, label, p: view.paths[path], editable: w.editable, ...(w.why ? { why: w.why } : {}) });
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}

export function parseValue(s: Settable, text: string): { ok: true; value: Leaf } | { ok: false; error: string } {
  if (s.type === 'boolean') return text === 'true' ? { ok: true, value: true } : text === 'false' ? { ok: true, value: false } : { ok: false, error: 'true or false' };
  if (s.type === 'integer') {
    if (!/^-?\d+$/.test(text.trim())) return { ok: false, error: 'a whole number' };
    const n = Number(text.trim());
    if (!Number.isSafeInteger(n)) return { ok: false, error: 'a whole number' };
    if (s.min !== undefined && n < s.min) return { ok: false, error: `at least ${s.min}` };
    if (s.max !== undefined && n > s.max) return { ok: false, error: `at most ${s.max}` };
    if (s.oneOf && !s.oneOf.includes(n)) return { ok: false, error: `one of ${s.oneOf.join(', ')}` };
    return { ok: true, value: n };
  }
  if (text.length > 512) return { ok: false, error: 'at most 512 characters' };
  if (s.enum && !s.enum.includes(text)) return { ok: false, error: `one of ${s.enum.join(', ')}` };
  if (s.pattern) {
    try {
      if (!new RegExp(s.pattern, 'u').test(text)) return { ok: false, error: 'not in the expected form' };
    } catch { /* a pattern this browser can't read: the proxy checks */ }
  }
  return { ok: true, value: text };
}

export function valueText(v: unknown): string {
  if (v === undefined) return 'unset';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function stateLine(row: { state: string; outcomeCode: string | null; retryAfterS?: number | null; dryRun?: boolean }): string {
  if (['queued', 'sent', 'received'].includes(row.state)) return 'sent, waiting for the proxy';
  if (row.state === 'done') return row.dryRun ? 'previewed' : 'applied';
  if (row.outcomeCode === 'conflict') return 'changed on the proxy since you loaded it';
  if (row.state === 'refused' && row.outcomeCode === 'rate_limited' && row.retryAfterS) return `the proxy's limit: try again in ${Math.max(1, Math.ceil(row.retryAfterS / 60))} min`;
  return cmdStateText(row.state, row.outcomeCode);
}

// R3-21: a real, successful settings write with at least one change.
export function rollbackable(row: { command: string; dryRun: boolean; state: string; result?: unknown }): boolean {
  const changes = (row.result as { changes?: unknown } | null | undefined)?.changes;
  return ['config.set', 'config.unset', 'config.rollback'].includes(row.command) && !row.dryRun && row.state === 'done' && Array.isArray(changes) && changes.length > 0;
}

export const isFinal = (state: string) => !['queued', 'sent', 'received'].includes(state);

// Polls a command until it is final (the proxy answers in well under a second
// when it is connected); null after `ms`.
export async function waitCommand(fetchRow: () => Promise<any>, ms = 30_000, every = 300): Promise<any | null> {
  const end = Date.now() + ms;
  for (;;) {
    const row = await fetchRow();
    if (isFinal(row.state)) return row;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

// What a disruptive action does, for its confirmation (Klaus's decision 3).
export const EFFECT: Record<string, string> = {
  restart: "Restarts the proxy's worker for this camera: stream, events and stills pause briefly.",
  'camera-reboot': 'Reboots the camera: no video for about two minutes.',
  'camera-powercycle': "Cuts the camera's PoE power and turns it back on: no video for a few minutes.",
  'camera-ftp-setup': "Writes the proxy's FTP upload settings into the camera.",
  'camera-ftp-off': "Turns the camera's FTP upload off.",
  'camera-ntp-set': "Writes the proxy's NTP server into the camera.",
  'camera-cert-push': "Pushes the proxy's certificate to the camera; the camera restarts its web server.",
  'proxy.restart': "Restarts the proxy process: every camera's stream and events pause until it is back.",
};
