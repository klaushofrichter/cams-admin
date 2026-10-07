// A hash router: #/, #/accounts, #/accounts/:id[/tab], #/accounts/:id/proxies/:pid, #/cams-instances[/:id], #/audit, #/backup.
export interface Route { page: 'dashboard' | 'accounts' | 'account' | 'proxy' | 'cams-instances' | 'cams-instance' | 'audit' | 'backup'; accountId?: string; proxyId?: string; instanceId?: string; tab?: string }

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] === 'accounts' && p[1] && p[2] === 'proxies' && p[3]) return { page: 'proxy', accountId: p[1], proxyId: p[3] };
  if (p[0] === 'accounts' && p[1]) return { page: 'account', accountId: p[1], tab: p[2] ?? 'overview' };
  if (p[0] === 'accounts') return { page: 'accounts' };
  if (p[0] === 'cams-instances' && p[1]) return { page: 'cams-instance', instanceId: p[1] };
  if (p[0] === 'cams-instances') return { page: 'cams-instances' };
  if (p[0] === 'audit') return { page: 'audit' };
  if (p[0] === 'backup') return { page: 'backup' };
  return { page: 'dashboard' };
}
