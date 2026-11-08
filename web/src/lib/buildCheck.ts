// "A new version of cams-admin is available" (finding 11): an open tab keeps its old bundle until reloaded, hash
// navigation never fetches a new one. The bundle knows its own build id; the server serves the current one as
// /build.json (written by the build). Checked every 5 minutes and when the tab gets focus; never reloads by itself.
export const BUILD_CHECK_MS = 5 * 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function readServedBuild(f: Fetch = fetch): Promise<string | null> {
  try {
    const r = await f('/build.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const b = (await r.json()) as { id?: unknown } | null;
    return b && typeof b.id === 'string' && b.id.length > 0 ? b.id : null;
  } catch {
    return null;
  }
}

// Calls onNew once with the served id when it differs from `own`. `own` empty (the dev server) never reports.
export function watchBuild(own: string, onNew: (id: string) => void, o: { fetch?: Fetch; target?: EventTarget } = {}): () => void {
  if (!own) return () => {};
  const target = o.target ?? globalThis;
  let done = false;
  const check = async () => {
    if (done) return;
    const id = await readServedBuild(o.fetch);
    if (!done && id !== null && id !== own) {
      done = true;
      onNew(id);
    }
  };
  const timer = setInterval(() => void check(), BUILD_CHECK_MS);
  const onFocus = () => void check();
  target.addEventListener('focus', onFocus);
  return () => {
    done = true;
    clearInterval(timer);
    target.removeEventListener('focus', onFocus);
  };
}
