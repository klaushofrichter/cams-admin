import { FILE_KINDS } from '../../contract/build';
import type { Profile } from '../status/profile';
import { isCount } from '../validate';

// The space a move needs against what the target reports (proxy profile design §3, "space"): not a precheck
// rule. cams-admin first knows the content size when the source's move.request arrives with its summary; then it
// compares the summary with the target's reported budget left (budgetBytes - usedBytes) and its per-kind caps.
// A shortfall never refuses the move: the move detail names the figures beside the content checklist, and the
// approval chooses what to leave out or to keep the newest content. Kept on the move as it was at request time.
export interface SpaceCheck {
  at: number; needBytes: number; budgetBytes: number; usedBytes: number; leftBytes: number; fits: boolean;
  // The kinds bigger than their cap on the target (stills.maxGB, ftp.maxGB for clips), from its last settings view.
  overCaps: { kind: string; bytes: number; capBytes: number }[];
}
export type KindCaps = Partial<Record<(typeof FILE_KINDS)[number], number>>;

const count = (x: unknown): number => (isCount(x) ? x : 0);

export function spaceCheck(summary: unknown, p: Profile | null | undefined, caps: KindCaps, now: number): SpaceCheck | null {
  if (!p || p.storage.budgetBytes === null || p.storage.usedBytes === null) return null;
  const s = (summary && typeof summary === 'object' ? summary : {}) as Record<string, { bytes?: unknown } | undefined>;
  const needBytes = FILE_KINDS.reduce((n, k) => n + count(s[k]?.bytes), 0);
  const leftBytes = Math.max(0, p.storage.budgetBytes - p.storage.usedBytes);
  const overCaps = FILE_KINDS.flatMap((k) => {
    const cap = caps[k];
    const b = count(s[k]?.bytes);
    return cap !== undefined && b > cap ? [{ kind: k, bytes: b, capBytes: cap }] : [];
  });
  return { at: now, needBytes, budgetBytes: p.storage.budgetBytes, usedBytes: p.storage.usedBytes, leftBytes, fits: needBytes <= leftBytes && overCaps.length === 0, overCaps };
}

// The per-kind caps from a proxy's stored settings view (P3 config.get): stills.maxGB for stills, ftp.maxGB for
// clips (the FTP clips). An unset cap is no cap. GB as cam-proxy counts them (10^9 bytes).
const CAP_PATHS: [keyof KindCaps, string][] = [['stills', 'stills.maxGB'], ['clips', 'ftp.maxGB']];
export function capsOf(view: unknown): KindCaps {
  const paths = (view && typeof view === 'object' ? (view as { paths?: unknown }).paths : null) as Record<string, { v?: unknown }> | null;
  if (!paths || typeof paths !== 'object') return {};
  const out: KindCaps = {};
  for (const [kind, path] of CAP_PATHS) {
    const v = paths[path]?.v;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[kind] = Math.round(v * 1e9);
  }
  return out;
}
