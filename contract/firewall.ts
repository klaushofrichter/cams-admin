// The firewall line templates (proxy profile design §1, §3): the lines cams-admin builds for a camera move (IPv4, and
// IPv6 for a camera with one: ufw as is, nft with ip6), and the only lines it shows from a proxy's report
// (server/status/profile.ts drops every other). They are plain text for a
// person to run, so an address is an IP literal and nothing else: never a hostname or a character a shell reads.
// cam-proxy prints the same lines. Not part of the vendored v1/ folder; the server and the web UI both import it.

export type FirewallTool = 'ufw' | 'nft';
export interface PortRange { from: number; to: number }

const V4_PART = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4 = new RegExp(`^${V4_PART}(?:\\.${V4_PART}){3}$`);
const HEX = /^[0-9A-Fa-f]{1,4}$/;

// 4 for an IPv4 literal, 6 for an IPv6 literal (no brackets, no zone), null for anything else.
export function ipLiteral(s: string): 4 | 6 | null {
  if (V4.test(s)) return 4;
  if (!s.includes(':') || s.length > 45) return null;
  let body = s;
  let extra = 0;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!V4.test(tail)) return null;
    body = s.slice(0, lastColon + 1) + '0'; // stand-in group; the IPv4 tail counts as two groups
    extra = 1;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const parts = halves.flatMap(groups);
  if (!parts.every((g) => HEX.test(g))) return null;
  const n = parts.length + extra;
  return (halves.length === 2 ? n <= 7 : n === 8) ? 6 : null;
}

const ports = (port: number, range: PortRange | null, sep: string) => [String(port), ...(range ? [`${range.from}${sep}${range.to}`] : [])];

// The lines a camera at `ip` needs on the proxy's host: its FTP port and its passive range. Throws on a non-IP address.
export function firewallLines(tool: FirewallTool | null, ip: string, port: number, passive: PortRange | null): string[] {
  const fam = ipLiteral(ip);
  if (!fam) throw new Error('not an IP address');
  if (tool === 'nft') return ports(port, passive, '-').map((p) => `sudo nft add rule inet filter input ${fam === 6 ? 'ip6' : 'ip'} saddr ${ip} tcp dport ${p} accept`);
  return ports(port, passive, ':').map((p) => `sudo ufw allow from ${ip} to any port ${p} proto tcp`);
}

// cam-proxy's formats, exactly (IPv4 cameras only; one place: a change of its wording is a change here):
//   sudo ufw allow from <ip> to any port <port>[:<to>] proto tcp
//   sudo nft add rule inet filter input ip saddr <ip> tcp dport <port>[-<to>] accept
const UFW = /^sudo ufw allow from (\S+) to any port ([0-9]{1,5})(?::([0-9]{1,5}))? proto tcp$/;
const NFT = /^sudo nft add rule inet filter input ip saddr (\S+) tcp dport ([0-9]{1,5})(?:-([0-9]{1,5}))? accept$/;
const portOk = (p: string | undefined) => p === undefined || (Number(p) >= 1 && Number(p) <= 65535);
const rangeOk = (a: string, b: string | undefined) => portOk(a) && portOk(b) && (b === undefined || Number(b) >= Number(a));

// A line of a proxy's report that cams-admin shows: one of cam-proxy's formats with an IPv4 literal.
export function isFirewallLine(line: string): boolean {
  const m = UFW.exec(line) ?? NFT.exec(line);
  return !!m && ipLiteral(m[1]) === 4 && rangeOk(m[2], m[3]);
}
