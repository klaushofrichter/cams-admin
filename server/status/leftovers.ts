// What a proxy could not clean up itself after a camera moved away (contract v1 heartbeat `moveLeftovers`;
// cam-proxy's capabilities design §7): an entry in config.json, a password in compose's environment or a
// _FILE secret. Read with clamps whatever a proxy sends: at most 16 entries, 4 items of 80 characters each;
// an entry whose camera or move id can't be read, or that keeps no item, is dropped, never the heartbeat. A
// repeated camera and move id keeps the first entry (the Diagnostics page keys its list by the pair).
import { CAMERA_ID_PATTERN, MOVE_ID_PATTERN, MOVE_LEFTOVER_ITEM_LEN, MOVE_LEFTOVER_ITEMS_MAX, MOVE_LEFTOVERS_MAX } from '../../contract/build';

export interface MoveLeftover { camera: string; moveId: string; items: string[] }

const CAMERA_RE = new RegExp(CAMERA_ID_PATTERN);
const MOVE_RE = new RegExp(MOVE_ID_PATTERN);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// [] for null, undefined or anything that is not an array.
export function parseMoveLeftovers(x: unknown): MoveLeftover[] {
  if (!Array.isArray(x)) return [];
  const out: MoveLeftover[] = [];
  const seen = new Set<string>();
  for (const e of x) {
    if (out.length >= MOVE_LEFTOVERS_MAX) break;
    if (!isRecord(e) || typeof e.camera !== 'string' || !CAMERA_RE.test(e.camera) || typeof e.moveId !== 'string' || !MOVE_RE.test(e.moveId)) continue;
    const items = (Array.isArray(e.items) ? e.items : [])
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, MOVE_LEFTOVER_ITEMS_MAX)
      .map((s) => Array.from(s).slice(0, MOVE_LEFTOVER_ITEM_LEN).join(''));
    const key = `${e.camera} ${e.moveId}`;
    if (!items.length || seen.has(key)) continue;
    seen.add(key);
    out.push({ camera: e.camera, moveId: e.moveId, items });
  }
  return out;
}
