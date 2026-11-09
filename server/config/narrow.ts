// The contract's path rules for cams-admin's own pre-check (R3-16): what a
// proxy may let cams-admin set is remote-settable.json's `remote` list
// intersected with the proxy's reported `settable`, and the `narrow` paths
// move one way only (or only up to the proxy's local ceiling). The proxy
// re-checks everything (R2-15).
import { ABOVE_LOCAL_CEILING, PATH_PATTERN, REMOTE_SETTABLE, type NarrowKind } from '../../contract/build';

export type Leaf = boolean | number | string;
export interface Settable { type: 'integer' | 'boolean' | 'string'; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: NarrowKind }

export const PATH_RE = new RegExp(PATH_PATTERN);
const REMOTE = new Set(REMOTE_SETTABLE.remote);
// Size caps: unset means no cap. Google Vision caps: 0 means no cap.
const UNSET_IS_NO_CAP = new Set(['stills.maxGB', 'previews.maxGB', 'ftp.maxGB']);
const ZERO_IS_NO_CAP = new Set(['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap']);
// The capture intervals (narrow `less`: never longer from cams-admin, #20).
const INTERVAL = /\.intervalS$/;
// A camera setting whose unset value is the host's (cam-proxy #396): its effective value then.
const INHERITS: Readonly<Record<string, string>> = { 'cameras.*.stills.intervalS': 'stills.intervalS' };
export const inheritedPathOf = (pattern: string): string | null => (Object.hasOwn(INHERITS, pattern) ? INHERITS[pattern] : null);
export const STORAGE_LOCAL_ONLY = /^(storage\.|cameras\.[^.]+\.storage\.)/;

// cameras.<id>.<leaf> → cameras.*.<leaf>
export const patternOf = (path: string): string => path.replace(/^cameras\.[^.]+\./, 'cameras.*.');

export function isRemoteSettable(path: string, settable: Record<string, Settable>): boolean {
  const pat = patternOf(path);
  return PATH_RE.test(path) && REMOTE.has(pat) && Object.hasOwn(settable, pat);
}

// The local ceiling path of a ceiling / ceilingGated path (remote-settable.json `ceilings`), else null.
export const ceilingPathOf = (pattern: string): string | null => (Object.hasOwn(REMOTE_SETTABLE.ceilings, pattern) ? REMOTE_SETTABLE.ceilings[pattern] : null);
const isCeilingKind = (dir: NarrowKind | undefined) => dir === 'ceiling' || dir === 'ceilingGated';

// May a remote change move `pattern` from `from` to `to` (undefined = unset)?
// An unknown value never passes a less/more path (cams-admin can't know what a
// Reset restores; the proxy decides). The ceiling kinds pass a value at or
// below the current one, or within `ceiling` (the proxy's local ceiling, from
// the last view) when it is known; with no known ceiling (or a Reset) the
// proxy decides (above_local_ceiling). `inherited`: for a camera setting whose
// unset value is the host's (inheritedPathOf), the host's value from the last
// view; an unset side takes it (from: before, to: after the change).
export function narrowingOk(pattern: string, from: unknown, to: unknown, ceiling?: unknown, inherited?: unknown): boolean {
  const dir = REMOTE_SETTABLE.narrow[pattern];
  if (!dir) return true;
  if (inheritedPathOf(pattern) !== null) {
    if (from === undefined) from = inherited;
    if (to === undefined) to = inherited;
  }
  if (isCeilingKind(dir)) {
    if (to === undefined) return true;
    const known = typeof ceiling === 'number' && Number.isFinite(ceiling);
    if (dir === 'ceilingGated') {
      if (typeof to !== 'boolean') return false;
      return to === false || to === from || !known || (ceiling as number) > 0;
    }
    if (typeof to !== 'number') return false;
    return (typeof from === 'number' && to <= from) || !known || to <= (ceiling as number);
  }
  // M1: the boolean rule only when both sides are booleans; a mix never passes.
  if (typeof from === 'boolean' || typeof to === 'boolean') {
    if (typeof from !== 'boolean' || typeof to !== 'boolean') return false;
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

// The error code of a narrowing refusal: above_local_ceiling for the ceiling kinds, else widening_local_only.
export function narrowCode(pattern: string): 'widening_local_only' | typeof ABOVE_LOCAL_CEILING {
  return isCeilingKind(REMOTE_SETTABLE.narrow[pattern]) ? ABOVE_LOCAL_CEILING : 'widening_local_only';
}

export function narrowReason(pattern: string, ceiling?: unknown): string | null {
  const dir = REMOTE_SETTABLE.narrow[pattern];
  if (dir === 'ceilingGated') return `cams-admin may not switch it on: no ceiling at the proxy (${ceilingPathOf(pattern)} is ${typeof ceiling === 'number' ? ceiling : 0})`;
  if (dir === 'ceiling') return `cams-admin may allow up to ${typeof ceiling === 'number' ? ceiling : 0} (${ceilingPathOf(pattern)})`;
  if (dir === 'less' && INTERVAL.test(pattern)) return 'a remote change may only shorten the interval; a longer one is a local change';
  return dir === 'less' ? 'a remote change may only lower spending' : dir === 'more' ? 'a remote change may only keep data longer' : null;
}
