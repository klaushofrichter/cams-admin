// The proxy profile a heartbeat reports (contract v1 heartbeat `profile`; proxy
// profile design §2): what the proxy may hold, as the person set it on the
// proxy. Read with clamps whatever a proxy sends: an unreadable profile is
// dropped (null), never a reason to refuse the heartbeat. cams-admin never
// sets it. The firewall lines hold camera LAN addresses: never logged.
import { isFirewallLine } from '../../contract/firewall';

export interface Profile {
  set: boolean; name: string | null; cameras: number; storageGB: number | null; held: number;
  ftp: { enabled: boolean; port: number | null; passive: { from: number; to: number } | null };
  storage: { budgetBytes: number | null; usedBytes: number | null; diskBytes: number | null; freeBytes: number | null };
  hardware: { pi: string | null; cpuCores: number | null; cpuModel: string | null; memoryBytes: number | null; load5: number | null; cpuTempC: number | null };
  warnings: string[];
  // Only lines of the ufw/nft templates (contract/firewall.ts); `dropped` counts the others, never shown.
  firewall: { tool: 'ufw' | 'nft' | null; lines: string[]; dropped: number };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const intIn = (x: unknown, min: number, max: number): number | null => (Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max ? (x as number) : null);
const bytes = (x: unknown): number | null => intIn(x, 0, Number.MAX_SAFE_INTEGER);
const numMin = (x: unknown, min: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= min ? x : null);
const text = (x: unknown, max: number): string | null => (typeof x === 'string' && x.length > 0 ? Array.from(x).slice(0, max).join('') : null);
const strs = (x: unknown, maxItems: number, len: number): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, maxItems).map((s) => Array.from(s).slice(0, len).join('')) : []);

export function parseProfile(x: unknown): Profile | null {
  if (!isRecord(x) || typeof x.set !== 'boolean') return null;
  const cameras = intIn(x.cameras, 1, 64);
  const held = intIn(x.held, 0, 64);
  if (cameras === null || held === null) return null;
  const ftp = isRecord(x.ftp) ? x.ftp : {};
  const pas = isRecord(ftp.passive) ? ftp.passive : null;
  const from = intIn(pas?.from, 1, 65535), to = intIn(pas?.to, 1, 65535);
  const st = isRecord(x.storage) ? x.storage : {};
  const hw = isRecord(x.hardware) ? x.hardware : {};
  const fw = isRecord(x.firewall) ? x.firewall : {};
  // Read whole (at most 64): a line cut short is no template line, so it is dropped, never shown cut.
  const lines = Array.isArray(fw.lines) ? fw.lines.slice(0, 64).filter((l): l is string => typeof l === 'string') : [];
  return {
    set: x.set, name: text(x.name, 60), cameras, storageGB: intIn(x.storageGB, 1, 100000), held,
    ftp: { enabled: ftp.enabled === true, port: intIn(ftp.port, 1, 65535), passive: from !== null && to !== null && to >= from ? { from, to } : null },
    storage: { budgetBytes: bytes(st.budgetBytes), usedBytes: bytes(st.usedBytes), diskBytes: bytes(st.diskBytes), freeBytes: bytes(st.freeBytes) },
    hardware: {
      pi: text(hw.pi, 200), cpuCores: intIn(hw.cpuCores, 1, 1024), cpuModel: text(hw.cpuModel, 100), memoryBytes: bytes(hw.memoryBytes),
      load5: numMin(hw.load5, 0), cpuTempC: numMin(hw.cpuTempC, -273),
    },
    warnings: [...new Set(strs(x.warnings, 8, 64))],
    firewall: { tool: fw.tool === 'ufw' || fw.tool === 'nft' ? fw.tool : null, lines: lines.filter(isFirewallLine), dropped: lines.filter((l) => !isFirewallLine(l)).length },
  };
}

// FTP passive ports in the reported range (0 without one).
export const passivePorts = (p: Profile): number => (p.ftp.passive ? p.ftp.passive.to - p.ftp.passive.from + 1 : 0);
