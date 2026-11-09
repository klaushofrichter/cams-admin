import { codeText } from './api';
import { ago } from './format';

// PoE switches and camera power (design 2026-11-07-poe-switches-design.md): the texts and the polling of the
// Switches tab and of the camera power line.

export type Power =
  | { kind: 'poe'; switchId: string; port: number; watts: number; verifiedAt?: number; notSeen?: boolean }
  | { kind: 'data-only'; switchId: string; port: number; verifiedAt?: number; notSeen?: boolean }
  | { kind: 'adapter' }
  | { kind: 'unknown' };
// A configuration problem from the switch's latest survey (chained_switch: another switch on that port).
export interface SwitchProblem { code: 'chained_switch'; port: number; cameras: number }
export const chainedText = (p: SwitchProblem): string =>
  `Configuration issue: another switch is chained on port ${p.port} (${p.cameras} cameras behind it). Connect each PoE switch directly to its proxy's network instead of through another PoE switch.`;
export const trunkText = (cameras: number): string => `trunk (${cameras} cameras)`;
// A camera the survey did not find, with why: the operator's reason codes in words (switch_error with its detail,
// cam-proxy #364 m3); cams-admin's own reasons are words already.
const LOCATE_TEXT: Record<string, string> = {
  not_reachable: 'camera not reachable from the operator', ambiguous: 'no clear port (ambiguous)', no_traffic: 'no traffic on any port', switch_error: 'the switch answered with an error',
};
export function surveyMissText(r: { camsId: string; reason?: string; detail?: string }): string {
  if (!r.reason) return r.camsId;
  const t = LOCATE_TEXT[r.reason] ?? r.reason;
  return `${r.camsId} (${r.detail ? `${t}: ${r.detail}` : t})`;
}
export interface Last { op: string; outcome: 'ok' | 'refused' | 'failed'; code: string | null; at: number }
export interface Flow { op: string; state: 'running' | 'ok' | 'failed'; code: string | null; reason: string | null; requestedAt: number; commandIds: string[]; finishedAt: number | null; force?: boolean }

export function powerLine(p: Power | undefined, switchName: string | null, now: number): string {
  if (!p || p.kind === 'unknown') return 'Unknown';
  if (p.kind === 'adapter') return 'Power adapter';
  if (p.kind === 'data-only') return 'Data only (adapter)';
  const parts = [`PoE: ${switchName ?? 'switch'} port ${p.port}`];
  if (typeof p.verifiedAt === 'number') parts.push(`verified ${ago(p.verifiedAt, now)}`);
  if (p.notSeen) parts.push('not seen in the last survey');
  return parts.join(' · ');
}

// The old proxy-side power-cycle action steps aside for a camera whose power cams-admin knows.
export const powerManaged = (p: Power | undefined): boolean => !!p && p.kind !== 'unknown';

export const forceCycleText = (switchName: string, port: number): string => `Cut power on ${switchName} port ${port} without verification?`;
export const passwordHint = (proxyName: string): string => `The switch password is tied to its address: set it again on ${proxyName}'s Proxy settings → PoE switches before testing.`;
export const removeText = (switchName: string, cameras: string[]): string =>
  cameras.length
    ? `Remove ${switchName}? PoE is switched back on for its cameras, and ${cameras.join(', ')} become unknown (where their power comes from).`
    : `Remove ${switchName}? No camera is mapped to it.`;

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export function lastText(l: Last | null | undefined): string {
  if (!l) return '';
  return `${cap(l.op)}: ${l.outcome === 'ok' ? 'done' : (l.code ? (codeText(l.code) ?? l.code) : l.outcome)}`;
}

export function flowText(f: Flow): string {
  if (f.state === 'running') return 'Running…';
  if (f.state === 'ok') return f.op === 'cycle' ? 'Power-cycled.' : f.op === 'verify' ? 'Verified.' : f.op === 'propose' ? 'Saved.' : 'Found.';
  return (f.code ? codeText(f.code) : undefined) ?? f.reason ?? f.code ?? 'failed';
}

// A flow that is new (not the one that was there before the request) and no longer running.
export const flowDone = (prev: Flow | null, cur: Flow | null): boolean =>
  !!cur && cur.state !== 'running' && !(prev && prev.requestedAt === cur.requestedAt && prev.commandIds.join() === cur.commandIds.join());

// Ask every 2 s until `done`, for at most 60 s; null when it never was.
export async function poll<T>(get: () => Promise<T>, done: (v: T) => boolean, o: { sleep?: (ms: number) => Promise<void>; everyMs?: number; maxMs?: number } = {}): Promise<T | null> {
  const every = o.everyMs ?? 2000;
  const max = o.maxMs ?? 60_000;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += every) {
    const v = await get();
    if (done(v)) return v;
    if (waited + every > max) return null;
    await sleep(every);
  }
}

export const CYCLE_TYPED = 'power-cycle';
export const cycleConfirmText = (camera: string, switchName: string, port: number): string =>
  `Cut power on ${switchName} port ${port} to restart ${camera}, then turn it back on: no video for a few minutes.`;
export const adapterConfirmNeeded = (p: Power | undefined): boolean => p?.kind === 'poe' && typeof p.verifiedAt === 'number';
export function flowLine(f: Flow | null | undefined, now: number): string {
  if (!f) return '';
  const what = f.op === 'cycle' ? (f.force ? 'forced power-cycle' : 'power-cycle') : 'check';
  return `Last ${what} ${ago(f.requestedAt, now)}: ${flowText(f)}`;
}

// The add-switch form's Operating proxy: never a silent default (a cluster proxy runs no physical switch). Proxies that
// run in the cluster go last; the one proxy that doesn't is preset when there is exactly one, else the person chooses.
export function operatingProxies<P extends { id: string; runsOn?: string }>(proxies: P[]): { list: P[]; preset: string } {
  const local = proxies.filter((p) => p.runsOn !== 'cluster');
  const list = [...local, ...proxies.filter((p) => p.runsOn === 'cluster')];
  return { list, preset: local.length === 1 ? local[0].id : '' };
}
