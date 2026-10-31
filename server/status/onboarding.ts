// Each camera's compact onboarding status (contract v1 heartbeat `onboarding`; cam-proxy onboarding design §4.5):
// {<camera id>: {ready, missing}}. Read with clamps whatever a proxy sends: at most 64 cameras, 16 step names of
// 32 characters each; a camera whose id or `ready` can't be read is dropped, never the heartbeat. Unknown step
// names (a newer proxy) are kept; `ready` is false whenever a required step is missing, whatever the proxy says.
import { CAMERA_ID_PATTERN, ONBOARDING_CAMERAS_MAX, ONBOARDING_REQUIRED, ONBOARDING_STEP_LEN } from '../../contract/build';

export interface CameraOnboarding { ready: boolean; missing: string[] }

export const ONBOARDING_MISSING_MAX = 16;
const CAMERA_RE = new RegExp(CAMERA_ID_PATTERN);
const STEP_RE = /^[a-z][A-Za-z0-9-]*$/;
const REQUIRED = new Set<string>(ONBOARDING_REQUIRED);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// null for undefined/null/non-object (the proxy sends none); {} for an object with nothing readable.
export function parseOnboarding(x: unknown): Record<string, CameraOnboarding> | null {
  if (!isRecord(x)) return null;
  const out: Record<string, CameraOnboarding> = {};
  let n = 0;
  for (const [id, v] of Object.entries(x)) {
    if (n >= ONBOARDING_CAMERAS_MAX) break;
    if (!CAMERA_RE.test(id) || !isRecord(v) || typeof v.ready !== 'boolean') continue;
    const missing: string[] = [];
    for (const s of Array.isArray(v.missing) ? v.missing : []) {
      if (missing.length >= ONBOARDING_MISSING_MAX) break;
      if (typeof s !== 'string' || !STEP_RE.test(s)) continue;
      const step = s.slice(0, ONBOARDING_STEP_LEN);
      if (!missing.includes(step)) missing.push(step);
    }
    out[id] = { ready: v.ready && !missing.some((s) => REQUIRED.has(s)), missing };
    n++;
  }
  return out;
}
