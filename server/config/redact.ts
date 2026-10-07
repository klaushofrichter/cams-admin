// cams-admin's own redaction of proxy-reported config and answers (security
// review I2): defence in depth on top of the proxy's scrub. A key, or a
// dotted path, that looks secret (the contract's SECRET_KEY_PATTERN) keeps
// its name; its value becomes "[redacted]". An object naming such a path in
// `path` (a change, a failed path) loses its values (from, to, v, n).
import { SECRET_KEY_PATTERN } from '../../contract/build';

export const SECRET_RE = new RegExp(SECRET_KEY_PATTERN, 'i');
export const REDACTED = '[redacted]';
const VALUE_KEYS = ['from', 'to', 'v', 'n'];

export function redactSecrets(x: unknown, depth = 0): { value: unknown; changed: boolean } {
  if (x === null || typeof x !== 'object' || depth > 32) return { value: x, changed: false };
  let changed = false;
  if (Array.isArray(x)) {
    const value = x.map((e) => {
      const r = redactSecrets(e, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value, changed };
  }
  const o = x as Record<string, unknown>;
  const pathIsSecret = typeof o.path === 'string' && SECRET_RE.test(o.path);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    let nv: unknown;
    if (SECRET_RE.test(k) || (pathIsSecret && VALUE_KEYS.includes(k))) {
      nv = REDACTED;
      changed ||= v !== REDACTED;
    } else {
      const r = redactSecrets(v, depth + 1);
      changed ||= r.changed;
      nv = r.value;
    }
    // defineProperty: a "__proto__" key stays a plain own property.
    Object.defineProperty(out, k, { value: nv, enumerable: true, writable: true, configurable: true });
  }
  return { value: out, changed };
}
