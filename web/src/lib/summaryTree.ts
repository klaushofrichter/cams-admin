// Every leaf of a stored health summary as {path, text}: the proxy page's
// "All fields" list renders exactly this, so the end-to-end metrics test can
// prove every field the proxy sends is shown (spec §15.4). Text only.
export interface Leaf { path: string; text: string }

const MAX = 2000;

export function summaryLeaves(v: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (x: unknown, path: string) => {
    if (out.length >= MAX) return;
    if (x === null || x === undefined) return void out.push({ path, text: '—' });
    if (Array.isArray(x)) {
      if (x.length === 0) return void out.push({ path, text: '[]' });
      x.forEach((y, i) => walk(y, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (typeof x === 'object') {
      const entries = Object.entries(x as Record<string, unknown>).filter(([k]) => !k.startsWith('$'));
      if (entries.length === 0) return void out.push({ path, text: '{}' });
      for (const [k, y] of entries) walk(y, path ? `${path}.${k}` : k);
      return;
    }
    out.push({ path, text: String(x) });
  };
  walk(v, '');
  return out;
}
