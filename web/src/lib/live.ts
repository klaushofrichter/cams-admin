// GET /api/v1/live (SSE): status and registry events; EventSource reconnects by itself.
export interface LiveStatus { proxyId: string; accountId: string; state: string; ok: boolean | null; problemCount: number | null; lastHeartbeatAt: number | null; cameras: { ref: string; online: boolean | null }[] }

export function live(handlers: { status?: (s: LiveStatus) => void; registry?: (r: { type: string; id: string }) => void; open?: () => void }): () => void {
  const es = new EventSource('/api/v1/live');
  es.addEventListener('status', (e) => handlers.status?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('registry', (e) => handlers.registry?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('open', () => handlers.open?.());
  return () => es.close();
}

// fn at most once per `ms`, a burst of calls coalesced into one.
export function coalesced(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (!t) t = setTimeout(() => { t = null; fn(); }, ms); };
}
