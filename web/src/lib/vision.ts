// The Account page's Vision tab (design 2026-11-05-vision-management-design.md): the state word, the limit
// check against the ceiling from the last refresh (the proxy has the final word), and save states in words.

export interface UsageProvider {
  id: string; name: string; enabled: boolean; key: string; monthlyLimit: number; remoteMaxMonthly: number; dailyCap: number;
  month: { calls: number }; today: { calls: number }; paused: { reason: string; until: number | null } | null; lastError: { at: number; message: string } | null;
  cameras: { id: string; today: number; month: number }[];
}
export interface SaveState { provider: string; monthlyLimit: number; state: 'previewing' | 'applying' | 'saved' | 'failed'; previewId: string; applyId: string | null; code: string | null; detail: string | null; at: number }
export interface VisionItem {
  proxyId: string; name: string; displayName: string; state: string; access: 'ok' | 'too-old' | 'not-allowed'; refreshing: boolean;
  fetchedAt: number | null; result: { v: 1; at: number; providers: UsageProvider[] } | null; saves: Record<string, SaveState>; lastRefusal: string | null;
}

// The providers cams-admin can manage (the server's PROVIDER_CONFIG); a proxy without figures shows these.
export const PROVIDERS = ['google-vision'];
export const PROVIDER_NAMES: Record<string, string> = { 'google-vision': 'Google Vision' };
export const MONTHLY_MAX = 100_000;
export const POLL_MS = 2000;
export const POLL_FOR_MS = 30_000;

const n = (x: number) => x.toLocaleString('en-US');

export function providerRows(it: VisionItem): { id: string; p: UsageProvider | null }[] {
  const got = it.result?.providers ?? [];
  if (got.length) return got.map((p) => ({ id: p.id, p }));
  return PROVIDERS.map((id) => ({ id, p: null }));
}

// The first that applies (design, cams-admin 1). cls: the chip class (ok, warn, bad, or none).
export function visionState(it: VisionItem, p: UsageProvider | null): { word: string; cls: string } {
  if (it.state !== 'online') return { word: 'Offline', cls: 'bad' };
  if (it.access === 'too-old') return { word: 'Proxy too old', cls: 'warn' };
  if (it.access === 'not-allowed') return { word: 'Not allowed at the proxy', cls: 'warn' };
  if (!p) return { word: 'No figures yet', cls: '' };
  if (p.paused) {
    const why = p.paused.reason === 'invalid_key' ? 'invalid key' : p.paused.reason.replace(/_/g, ' ');
    return { word: `Paused: ${why}${p.paused.until ? ` until ${new Date(p.paused.until).toLocaleString()}` : ''}`, cls: 'warn' };
  }
  if (!p.enabled || p.monthlyLimit === 0) return { word: 'Off', cls: '' };
  if (p.key === 'none') return { word: 'On, no key', cls: 'warn' };
  if (p.month.calls >= p.monthlyLimit) return { word: 'Limit reached this month', cls: 'warn' };
  return { word: 'On', cls: 'ok' };
}

// The page's own check before Save: null when it may go to the proxy. ceiling/current: from the last
// refresh (null when unknown: the proxy decides); enabled: whether it is on now. Lowering is always allowed;
// switching on (any limit above 0 while off) needs a ceiling above 0.
export function limitProblem(value: string, ceiling: number | null, current: number | null, enabled: boolean): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v) || Number(v) > MONTHLY_MAX) return `Enter a whole number from 0 to ${n(MONTHLY_MAX)}.`;
  const x = Number(v);
  if (ceiling === null || x === 0) return null;
  if (ceiling === 0 && !enabled) return "cams-admin can't switch it on: no ceiling at the proxy.";
  if ((current !== null && x <= current) || x <= ceiling) return null;
  if (ceiling === 0) return "cams-admin can't switch it on: no ceiling at the proxy.";
  return `Above the ceiling at the proxy: up to ${n(ceiling)}.`;
}

const CODES: Record<string, string> = {
  above_local_ceiling: 'above the ceiling at the proxy', not_remote_settable: 'the proxy does not let cams-admin set this', held_by_env: 'held by the proxy\'s environment',
  invalid_value: 'not a value the proxy takes', widening_local_only: 'only the proxy itself may raise this', expired: 'the proxy did not answer in time', unknown: 'no final answer from the proxy',
  preview_stale: 'the check is too old', preview_used: 'already saved', not_allowed_on_proxy: 'not allowed at the proxy', paused_on_proxy: 'commands are paused at the proxy',
  no_view: 'no settings read from the proxy yet',
};
export const codeText = (code: string | null): string => (code ? (CODES[code] ?? code.replace(/_/g, ' ')) : 'refused');

export function saveText(s: SaveState): string {
  if (s.state === 'previewing') return 'Checking at the proxy…';
  if (s.state === 'applying') return 'Saving…';
  if (s.state === 'saved') return 'Saved.';
  if (s.code === 'conflict') return 'The proxy\'s settings changed meanwhile: Refresh and save again.';
  return `Refused: ${codeText(s.code)}${s.detail ? ` (${s.detail})` : ''}.`;
}
