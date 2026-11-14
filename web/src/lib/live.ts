// GET /api/v1/live (SSE): status and registry events; EventSource reconnects by itself.
// One stream per tab, shared by every subscriber (the server allows a few per session).
export type { LiveStatus } from '../../../server/live';
import type { LiveStatus } from '../../../server/live';

type Handlers = { status?: (s: LiveStatus) => void; registry?: (r: { type: string; id: string }) => void; open?: () => void };

const subscribers = new Set<Handlers>();
let source: EventSource | null = null;

function connect(): EventSource {
  const es = new EventSource('/api/v1/live');
  // Each handler gets its own parsed copy, as when every subscriber had its own stream.
  es.addEventListener('status', (e) => { for (const h of [...subscribers]) h.status?.(JSON.parse((e as MessageEvent).data)); });
  es.addEventListener('registry', (e) => { for (const h of [...subscribers]) h.registry?.(JSON.parse((e as MessageEvent).data)); });
  es.addEventListener('open', () => { for (const h of [...subscribers]) h.open?.(); });
  return es;
}

export function live(handlers: Handlers): () => void {
  const mine: Handlers = { ...handlers };
  subscribers.add(mine);
  source ??= connect();
  return () => {
    if (!subscribers.delete(mine) || subscribers.size > 0) return;
    source?.close();
    source = null;
  };
}

// fn at most once per `ms`, a burst of calls coalesced into one.
export function coalesced(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (!t) t = setTimeout(() => { t = null; fn(); }, ms); };
}
