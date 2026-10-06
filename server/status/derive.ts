// What the server derives from the stored status (spec §8.6). Pure
// functions of the rows and the server's clock.

export type ProxyState = 'pending' | 'never-connected' | 'online' | 'offline' | 'stopped' | 'rejected' | 'revoked';
export type PinState = 'match' | 'mismatch' | 'hint' | 'none';

export interface ReportedCamera { ref: string; online: boolean; name?: string; model?: string | null }
export interface CommandsInfo { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; seenWindow: number }
export interface TokensInfo { revision: number; client: number; admin: number; blocked: string[] }
export interface Reported {
  cameras: ReportedCamera[]; caFingerprint: string[]; site?: string | null; publicUrl?: string | null; startedAt?: number | null; uptimeS?: number | null; configSchema?: number | null; pin?: PinState;
  // P2: the hello's capabilities and the heartbeat's command policy, token and config revisions.
  capabilities?: string[]; commands?: CommandsInfo | null; tokens?: TokensInfo | null; configRevision?: string | null;
}

export interface StatusRow {
  proxyId: string; connected: boolean; connectedSince: number | null; lastHelloAt: number | null; lastHeartbeatAt: number | null;
  closedReason: string | null; stopped: boolean; proxyVersion: string | null; clockSkewMs: number | null; summary: unknown;
  summaryAt: number | null; ok: boolean | null; problemCount: number | null; reported: Reported | null; online: boolean;
}

export const SKEW_PROBLEM_MS = 60_000;

// Liveness by server time only: online while the last heartbeat is younger
// than offlineAfterMs. The age clamps at 0 if the server clock went back.
export function heartbeatFresh(s: StatusRow | null, now: number, offlineAfterMs: number): boolean {
  return !!s && s.lastHeartbeatAt !== null && Math.max(0, now - s.lastHeartbeatAt) < offlineAfterMs;
}

export function deriveProxyState(p: { state: string }, s: StatusRow | null, hasActiveKey: boolean, now: number, offlineAfterMs: number): ProxyState {
  if (p.state === 'revoked') return 'revoked';
  if (p.state === 'pending') return 'pending';
  if (!hasActiveKey) return 'rejected';
  if (!s || s.lastHelloAt === null) return 'never-connected';
  if (s.stopped) return 'stopped';
  return heartbeatFresh(s, now, offlineAfterMs) ? 'online' : 'offline';
}

// Cameras from the last summary while the proxy is online; unknown (null) otherwise.
export function cameraStates(s: StatusRow | null, state: ProxyState): { ref: string; online: boolean | null }[] {
  const cams = s?.reported?.cameras ?? [];
  return cams.map((c) => ({ ref: c.ref, online: state === 'online' ? c.online : null }));
}

// Registered pins (cams's trust anchor) against what the proxy reports.
// cams refuses the proxy when its current CA (the first reported) is not pinned.
export function pinState(registered: string[], reported: string[]): PinState {
  if (reported.length === 0) return 'none';
  if (registered.length === 0) return 'hint';
  return registered.includes(reported[0]) ? 'match' : 'mismatch';
}

export function reconcile(
  proxy: { name: string },
  registered: { proxyCameraId: string | null }[],
  accountCamsIds: Set<string>,
  s: StatusRow | null,
): { reportedNotRegistered: { ref: string; proposedCamsId: string }[]; registeredNotReported: string[] } {
  const reported = s?.reported?.cameras;
  if (!reported) return { reportedNotRegistered: [], registeredNotReported: [] };
  const regIds = new Set(registered.map((c) => c.proxyCameraId).filter((x): x is string => !!x));
  const repIds = new Set(reported.map((c) => c.ref));
  return {
    reportedNotRegistered: reported.filter((c) => !regIds.has(c.ref)).map((c) => ({
      ref: c.ref,
      proposedCamsId: !accountCamsIds.has(c.ref) ? c.ref : `${proxy.name}-${c.ref}`.slice(0, 32),
    })),
    registeredNotReported: [...regIds].filter((id) => !repIds.has(id)),
  };
}

// P2: what cams-admin may send this proxy, as the proxy reports it (the
// proxy decides; commands are off by default on every proxy).
export type CommandsPolicy = 'unsupported' | 'off' | 'paused' | 'none-allowed' | 'allowed';
export function deriveCommands(rep: Reported | null | undefined): CommandsPolicy {
  if (!rep?.capabilities?.includes('commands') || !rep.commands) return 'unsupported';
  if (!rep.commands.enabled) return 'off';
  if (rep.commands.paused) return 'paused';
  return rep.commands.allow.length === 0 ? 'none-allowed' : 'allowed';
}
