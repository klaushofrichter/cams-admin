// Diffs two V8 heap snapshots by constructor/name: count and self size of
// what the end has more of than the start (the load test's --snapshots).
//   tsx scripts/load/heap-diff.ts start.heapsnapshot end.heapsnapshot [top=20]
import { readFileSync } from 'fs';

type Agg = Map<string, { n: number; size: number }>;
function aggregate(file: string): { agg: Agg; total: number; nodes: number } {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const f: string[] = snap.snapshot.meta.node_fields;
  const types: string[] = snap.snapshot.meta.node_types[0];
  const [iType, iName, iSize] = ['type', 'name', 'self_size'].map((k) => f.indexOf(k));
  const nodes: number[] = snap.nodes;
  const strings: string[] = snap.strings;
  const agg: Agg = new Map();
  let total = 0;
  for (let i = 0; i < nodes.length; i += f.length) {
    const type = types[nodes[i + iType]];
    const name = type === 'string' || type === 'concatenated string' || type === 'sliced string' ? '(string)' : type === 'number' ? '(number)' : `${type}:${strings[nodes[i + iName]].slice(0, 60)}`;
    const size = nodes[i + iSize];
    total += size;
    const a = agg.get(name) ?? { n: 0, size: 0 };
    a.n++;
    a.size += size;
    agg.set(name, a);
  }
  return { agg, total, nodes: nodes.length / f.length };
}
const [a, b, top = '20'] = process.argv.slice(2);
const s = aggregate(a), e = aggregate(b);
const MiB = (x: number) => (x / 1048576).toFixed(2);
console.log(`start: ${s.nodes} nodes, ${MiB(s.total)} MiB; end: ${e.nodes} nodes, ${MiB(e.total)} MiB; delta ${MiB(e.total - s.total)} MiB`);
const rows = [...new Set([...s.agg.keys(), ...e.agg.keys()])].map((k) => {
  const x = s.agg.get(k) ?? { n: 0, size: 0 }, y = e.agg.get(k) ?? { n: 0, size: 0 };
  return { k, dn: y.n - x.n, ds: y.size - x.size, n: y.n };
}).sort((p, q) => q.ds - p.ds).slice(0, Number(top));
for (const r of rows) console.log(`${String(r.ds).padStart(10)} B  ${String(r.dn).padStart(7)} objs  (${r.n} now)  ${r.k}`);
