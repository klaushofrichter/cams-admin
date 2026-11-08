// What a Delete takes with it, for the confirmation (account-move findings 2026-11-07): what goes, what stays
// (always the audit log), and what refuses it up front. Counts come from GET …/delete-preview; a zero is left out.

export interface DeleteLines { goes: string[]; stays: string[]; blocked: string | null }
export interface ProxyPreview { cameras: number; moves: number; activeMoves: number; tokens: number; liveTokens: number; routes: number; keys: number; commands: number; switches: string[] }
export interface AccountPreview { users: number; proxies: number; cameras: number; moves: number; activeMoves: number; commands: number; tokens: number; routes: number; switches: number; camsInstances: number; viewerTokens: number }

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const some = (n: number, line: string) => (n > 0 ? [line] : []);
const AUDIT = 'the audit log';
const MOVE_RUNNING = 'A camera move is running: finish or cancel it first (Moves).';

export function proxyDeleteLines(p: ProxyPreview): DeleteLines {
  const sw = p.switches;
  return {
    goes: [
      p.keys > 0 ? 'its key (the proxy is disconnected) and any enrollment code' : 'any enrollment code',
      ...some(p.moves, `${count(p.moves, 'camera move record')} (the history of moves to and from it)`),
      ...some(p.tokens, `${count(p.tokens, 'proxy token')} (cams viewers using them lose this proxy)`),
      ...some(p.routes, `${count(p.routes, 'viewer route')} (cams instances stop showing it)`),
      'its live status, history, settings and token revision',
    ],
    stays: [
      ...some(p.cameras, `${count(p.cameras, 'camera')}, left in the account without a proxy`),
      ...some(p.commands, `${count(p.commands, 'command record')}, no longer listed under any proxy`),
      AUDIT,
    ],
    blocked: p.activeMoves > 0 ? MOVE_RUNNING
      : sw.length ? `It operates PoE switch${sw.length > 1 ? 'es' : ''} ${sw.map((n) => `"${n}"`).join(', ')}: move or remove ${sw.length > 1 ? 'them' : 'it'} first (Switches tab).`
      : null,
  };
}

export function accountDeleteLines(a: AccountPreview): DeleteLines {
  return {
    goes: [
      ...some(a.users, count(a.users, 'user')),
      ...some(a.proxies, `${count(a.proxies, 'proxy', 'proxies')} (disconnected, keys revoked)`),
      ...some(a.cameras, count(a.cameras, 'camera')),
      ...some(a.moves, count(a.moves, 'camera move record')),
      ...some(a.commands, count(a.commands, 'command record')),
      ...some(a.tokens, count(a.tokens, 'proxy token')),
      ...some(a.routes, count(a.routes, 'viewer route')),
      ...some(a.switches, count(a.switches, 'PoE switch record')),
      'live status, history and settings',
    ],
    stays: [
      ...some(a.camsInstances, `${count(a.camsInstances, 'cams instance')}, which ${a.camsInstances === 1 ? 'stops' : 'stop'} serving this account`),
      ...some(a.viewerTokens, `${count(a.viewerTokens, 'viewer token')}, which ${a.viewerTokens === 1 ? 'loses' : 'lose'} this account`),
      AUDIT,
    ],
    blocked: a.activeMoves > 0 ? MOVE_RUNNING : null,
  };
}

// From what the cams instance page already loaded (no extra request).
export function instanceDeleteLines(i: { routes: number; overrides: number; accounts: number }): DeleteLines {
  return {
    goes: [
      'its keys and enrollment codes',
      ...some(i.routes, count(i.routes, 'route')),
      ...some(i.overrides, count(i.overrides, 'camera override')),
      ...some(i.accounts, `its link to ${count(i.accounts, 'account')}`),
    ],
    stays: ['every proxy token it holds, revoked at once (listed as revoked)', AUDIT],
    blocked: null,
  };
}

// A camera record (the server refuses while it moves). The proxy may still report it: auto-add never brings it back.
export function cameraDeleteLines(mapped: boolean): DeleteLines {
  return {
    goes: ['its move records', 'its sim settings and cams camera overrides', 'its power-cycle record'],
    stays: [...(mapped ? ['the camera and its recordings on the proxy (never added back automatically)'] : []), AUDIT],
    blocked: null,
  };
}
