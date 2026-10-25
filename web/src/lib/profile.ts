// The proxy profile (proxy profile design §3): text for the Profile card, the dashboard notice and the firewall
// lines the Start move form shows. cams-admin only reads the profile: a person sets it on the proxy.

export interface Profile {
  set: boolean; name: string | null; cameras: number; storageGB: number | null; held: number;
  ftp: { enabled: boolean; port: number | null; passive: { from: number; to: number } | null };
  storage: { budgetBytes: number | null; usedBytes: number | null; diskBytes: number | null; freeBytes: number | null };
  hardware: { pi: string | null; cpuCores: number | null; cpuModel: string | null; memoryBytes: number | null; load5: number | null; cpuTempC: number | null };
  warnings: string[];
  firewall: { tool: 'ufw' | 'nft' | null; lines: string[] };
}

// The first cam-proxy release that reports a profile.
export const PROFILE_SINCE = '2026.10.26';
export const NO_PROFILE = `no profile reported (needs cam-proxy ${PROFILE_SINCE} or later)`;

// Sizes as cam-proxy counts the storage budget (GB = 10^9 bytes).
export function size(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1e6) return `${Math.round(n / 1e3)} kB`;
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  if (n < 1e12) return `${n < 1e10 ? (n / 1e9).toFixed(1) : Math.round(n / 1e9)} GB`;
  return `${(n / 1e12).toFixed(1)} TB`;
}

// "1 of 3 cameras".
export const camerasLine = (p: Pick<Profile, 'held' | 'cameras'>): string => `${p.held} of ${p.cameras} camera${p.cameras === 1 ? '' : 's'}`;

// "Budget 600 GB (set as 600 GB), 41 GB used; disk 1.0 TB, 880 GB free".
export function storageLine(p: Pick<Profile, 'storage' | 'storageGB'>): string {
  const s = p.storage;
  const budget = s.budgetBytes === null ? 'budget unknown' : `budget ${size(s.budgetBytes)}${p.storageGB !== null ? ' (set in the profile)' : ' (from the storage settings)'}`;
  const used = s.usedBytes === null ? '' : `, ${size(s.usedBytes)} used`;
  const disk = s.diskBytes === null ? '' : `; disk ${size(s.diskBytes)}${s.freeBytes === null ? '' : `, ${size(s.freeBytes)} free`}`;
  return `${budget[0].toUpperCase()}${budget.slice(1)}${used}${disk}`;
}

// "Intel N100, 4 cores, 16 GB memory; load 0.70, 48.5 °C".
export function hardwareLine(h: Profile['hardware']): string {
  const what = [h.pi ?? h.cpuModel, h.cpuCores !== null ? `${h.cpuCores} core${h.cpuCores === 1 ? '' : 's'}` : null, h.memoryBytes !== null ? `${size(h.memoryBytes)} memory` : null].filter(Boolean).join(', ');
  const now = [h.load5 !== null ? `load ${h.load5.toFixed(2)}` : null, h.cpuTempC !== null ? `${h.cpuTempC.toFixed(1)} °C` : null].filter(Boolean).join(', ');
  return [what || 'unknown hardware', now].filter(Boolean).join('; ');
}

const WARNINGS: Record<string, string> = {
  profile_ftp_ports: 'The FTP passive range has fewer ports than the profile needs (10 per camera): a move that needs the missing ports is refused.',
  profile_cameras_exceeded: 'The proxy holds more cameras than its profile allows. Nothing is removed, but no camera can move onto it.',
};
export const warningText = (w: string): string => WARNINGS[w] ?? w;

// A camera address without a port (an IPv6 address without its brackets); null when the registry has none to use.
export function hostOnly(host: string | null | undefined): string | null {
  const h = (host ?? '').trim();
  if (!h || h === 'from-proxy') return null;
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const i = h.indexOf(':');
  return i >= 0 && h.indexOf(':', i + 1) < 0 ? h.slice(0, i) : h;
}

// The lines a camera's host needs on the proxy's host (as cam-proxy prints them): the FTP port and the passive range.
export function firewallLines(tool: 'ufw' | 'nft' | null, host: string, port: number, passive: { from: number; to: number } | null): string[] {
  if (tool === 'nft') return [`sudo nft add rule inet filter input ip saddr ${host} tcp dport ${port} accept`, ...(passive ? [`sudo nft add rule inet filter input ip saddr ${host} tcp dport ${passive.from}-${passive.to} accept`] : [])];
  return [`sudo ufw allow from ${host} to any port ${port} proto tcp`, ...(passive ? [`sudo ufw allow from ${host} to any port ${passive.from}:${passive.to} proto tcp`] : [])];
}

// What the Start move form shows for the chosen camera and target: the lines to run on the target first, or why there are none.
export type MoveFirewall = { lines: string[]; tool: 'ufw' | 'nft' } | { none: string };
export function moveFirewall(targetName: string, p: Profile | null | undefined, cameraHost: string | null | undefined): MoveFirewall {
  if (!p) return { none: `${targetName}: ${NO_PROFILE}; check its firewall by hand.` };
  if (!p.ftp.enabled) return { none: `FTP is off on ${targetName}: no firewall lines needed.` };
  const host = hostOnly(cameraHost);
  if (!host) return { none: "The camera's address is not in the registry: the firewall lines need it." };
  if (p.ftp.port === null) return { none: `${targetName} reports no FTP port.` };
  const tool = p.firewall.tool ?? 'ufw';
  return { lines: firewallLines(tool, host, p.ftp.port, p.ftp.passive), tool };
}

// The move detail's space line (the figures cams-admin kept when the request arrived).
export interface SpaceCheck { at: number; needBytes: number; budgetBytes: number; usedBytes: number; leftBytes: number; fits: boolean; overCaps: { kind: string; bytes: number; capBytes: number }[] }
export function spaceText(target: string, s: SpaceCheck | null | undefined): string {
  if (!s) return '';
  const head = `The move needs ${size(s.needBytes)}; ${target} had ${size(s.leftBytes)} of its ${size(s.budgetBytes)} budget left (${size(s.usedBytes)} used).`;
  const caps = s.overCaps.map((c) => `${c.kind} ${size(c.bytes)} is over its ${size(c.capBytes)} cap`).join('; ');
  if (s.fits) return `${head} It fits.`;
  return `${head}${caps ? ` ${caps[0].toUpperCase()}${caps.slice(1)}.` : ''} It does not all fit: leave kinds out or keep the newest content when you approve.`;
}
