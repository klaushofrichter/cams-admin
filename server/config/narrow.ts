// The contract's path rules for cams-admin's own pre-check (R3-16): what a
// proxy may let cams-admin set is remote-settable.json's `remote` list
// intersected with the proxy's reported `settable`, and the `narrow` paths
// move one way only. The proxy re-checks everything (R2-15).
import { PATH_PATTERN, REMOTE_SETTABLE } from '../../contract/build';

export type Leaf = boolean | number | string;
export interface Settable { type: 'integer' | 'boolean' | 'string'; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }

export const PATH_RE = new RegExp(PATH_PATTERN);
const REMOTE = new Set(REMOTE_SETTABLE.remote);
// Size caps: unset means no cap. Google Vision caps: 0 means no cap.
const UNSET_IS_NO_CAP = new Set(['stills.maxGB', 'previews.maxGB', 'ftp.maxGB']);
const ZERO_IS_NO_CAP = new Set(['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap']);
export const STORAGE_LOCAL_ONLY = /^(storage\.|cameras\.[^.]+\.storage\.)/;

// cameras.<id>.<leaf> → cameras.*.<leaf>
export const patternOf = (path: string): string => path.replace(/^cameras\.[^.]+\./, 'cameras.*.');

export function isRemoteSettable(path: string, settable: Record<string, Settable>): boolean {
  const pat = patternOf(path);
  return PATH_RE.test(path) && REMOTE.has(pat) && Object.hasOwn(settable, pat);
}

// May a remote change move `pattern` from `from` to `to` (undefined = unset)?
// An unknown value never passes a narrow path (cams-admin can't know what a
// Reset restores; the proxy decides).
export function narrowingOk(pattern: string, from: unknown, to: unknown): boolean {
  const dir = REMOTE_SETTABLE.narrow[pattern];
  if (!dir) return true;
  if (typeof from === 'boolean' || typeof to === 'boolean') {
    if (to === from) return true;
    return dir === 'less' ? to === false : to === true;
  }
  const size = (x: unknown): number => {
    if (x === undefined || x === null) return UNSET_IS_NO_CAP.has(pattern) ? Infinity : NaN;
    if (typeof x !== 'number') return NaN;
    return ZERO_IS_NO_CAP.has(pattern) && x === 0 ? Infinity : x;
  };
  const f = size(from);
  const t = size(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return false;
  return dir === 'less' ? t <= f : t >= f;
}

export function narrowReason(pattern: string): string | null {
  const dir = REMOTE_SETTABLE.narrow[pattern];
  return dir === 'less' ? 'a remote change may only lower spending' : dir === 'more' ? 'a remote change may only keep data longer' : null;
}
