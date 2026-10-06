// P2: what cams-admin may send a proxy (as the proxy reports it), command
// states and token states, as text for the Proxy page and the dashboard.

export type CommandsPolicy = 'unsupported' | 'off' | 'paused' | 'none-allowed' | 'allowed';

export function commandsText(v: CommandsPolicy | string | undefined | null, allow: string[] = []): string {
  switch (v) {
    case 'off': return 'commands are off on the proxy (environment)';
    case 'paused': return 'paused on the proxy';
    case 'none-allowed': return 'no command allowed on the proxy';
    case 'allowed': return `allowed: ${allow.join(', ')}`;
    default: return 'this proxy version takes no commands';
  }
}

export function cmdStateText(state: string, code: string | null): string {
  if (state === 'refused' || state === 'failed') return code ? `${state}: ${code}` : state;
  if (state === 'unknown') return "unknown: check the proxy's audit log";
  return state;
}

export function cmdStateClass(state: string): string {
  if (state === 'done') return 'ok';
  if (state === 'refused' || state === 'failed') return 'bad';
  if (state === 'unknown' || state === 'expired') return 'warn';
  return '';
}

export function tokenStateClass(state: string): string {
  return state === 'active' ? 'ok' : state === 'retiring' ? 'warn' : state === 'revoked' ? 'bad' : '';
}

// Why an Issue button is disabled (null: it isn't). The proxy decides; this is the hint.
export function issueBlocked(kind: 'client' | 'admin', policy: string | undefined, allow: string[]): string | null {
  if (policy !== 'allowed') return commandsText(policy, allow);
  if (!allow.includes('tokens.apply')) return 'the proxy does not allow tokens.apply';
  if (kind === 'admin' && !allow.includes('tokens.apply.admin')) return 'the proxy does not allow tokens.apply.admin';
  return null;
}
