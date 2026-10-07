// Edit buffers filled from the server: a reload (any live registry event)
// keeps what the person is typing unless the server's value itself changed.
export function keepEdits<T>(buffer: Record<string, T>, seen: Record<string, T>, fresh: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(fresh)) {
    const unchanged = id in seen && JSON.stringify(seen[id]) === JSON.stringify(v);
    out[id] = unchanged && id in buffer ? buffer[id] : v;
  }
  return out;
}
