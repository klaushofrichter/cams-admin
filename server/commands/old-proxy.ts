import type { CommandRow } from './service';

// What a proxy on a cam-proxy release older than a command answers for it, in one place (moves summary,
// returns, decommission, Vision):
// - not_allowed: check order step 8 refuses a command the release doesn't implement (cam-proxy
//   src/fleet/command-check.ts). An entry that is off gets the same nack, no field tells the two apart:
//   a site whose command can be off by policy decides with the proxy's reported allow list (Vision does).
// - not_implemented: the command passed the checks but the release has no handler for it (command.done
//   failed, cam-proxy src/fleet/commands.ts).
// - unsupported_version / invalid_args: args of a later version, or a field the release doesn't know.
export const OLD_PROXY_CODES: ReadonlySet<string> = new Set(['not_allowed', 'not_implemented', 'unsupported_version', 'invalid_args']);

// A final answer that says the proxy needs an update: refused at the check or failed at the handler.
export const isOldProxyAnswer = (r: Pick<CommandRow, 'state' | 'outcomeCode'>, codes: ReadonlySet<string> = OLD_PROXY_CODES): boolean =>
  (r.state === 'refused' || r.state === 'failed') && codes.has(r.outcomeCode ?? '');
