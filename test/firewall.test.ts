// The firewall line templates (contract/firewall.ts): what cams-admin builds for a move and the only lines it
// shows from a proxy's report. Shell safety: an address is an IP literal, never a hostname or anything else.
import { describe, expect, it } from 'vitest';
import { firewallLines, isFirewallLine, ipLiteral } from '../contract/firewall';

describe('firewall lines', () => {
  it('ipLiteral: IPv4 or IPv6 literals only', () => {
    for (const ok of ['192.0.2.10', '0.0.0.0', '255.255.255.255', '2001:db8::1', '::1', 'fe80::1', '2001:db8:0:0:0:0:0:1', '::ffff:192.0.2.1']) expect(ipLiteral(ok), ok).not.toBeNull();
    expect(ipLiteral('192.0.2.10')).toBe(4);
    expect(ipLiteral('2001:db8::1')).toBe(6);
    for (const bad of ['', 'cam.example.net', '192.0.2.256', '192.0.2', '192.0.2.10 ', '01.2.3.4', '192.0.2.1;rm -rf /', '$(id)', '`id`', '2001:db8::1::2', '2001:db8:::1', ':::', 'g::1', '1:2:3:4:5:6:7:8:9', '[2001:db8::1]', '192.0.2.1\n']) expect(ipLiteral(bad), JSON.stringify(bad)).toBeNull();
  });
  it('builds ufw and nft lines (nft: ip6 for IPv6)', () => {
    expect(firewallLines('ufw', '2001:db8::1', 2121, { from: 30000, to: 30009 })).toEqual(['sudo ufw allow from 2001:db8::1 to any port 2121 proto tcp', 'sudo ufw allow from 2001:db8::1 to any port 30000:30009 proto tcp']);
    expect(firewallLines('nft', '2001:db8::1', 2121, null)).toEqual(['sudo nft add rule inet filter input ip6 saddr 2001:db8::1 tcp dport 2121 accept']);
    expect(firewallLines('nft', '192.0.2.5', 2121, { from: 30000, to: 30009 })).toEqual(['sudo nft add rule inet filter input ip saddr 192.0.2.5 tcp dport 2121 accept', 'sudo nft add rule inet filter input ip saddr 192.0.2.5 tcp dport 30000-30009 accept']);
    expect(() => firewallLines('ufw', 'cam.example.net', 21, null)).toThrow();
  });
  it('isFirewallLine: exactly the templates, every line built passes', () => {
    for (const tool of ['ufw', 'nft'] as const) for (const l of firewallLines(tool, '192.0.2.5', 2121, { from: 30000, to: 30029 })) expect(isFirewallLine(l), l).toBe(true);
    // cam-proxy makes lines only for IPv4 cameras: a reported IPv6 line is none of its formats.
    for (const tool of ['ufw', 'nft'] as const) for (const l of firewallLines(tool, '2001:db8::1', 2121, { from: 30000, to: 30029 })) expect(isFirewallLine(l), l).toBe(false);
    for (const bad of [
      'sudo ufw allow from 192.0.2.5 to any port 2121 proto tcp; rm -rf /',
      'sudo ufw allow from cam.example.net to any port 2121 proto tcp',
      'sudo ufw allow from 192.0.2.5 to any port 70000 proto tcp',
      'sudo ufw allow from 192.0.2.5 to any port 0 proto tcp',
      'sudo ufw allow from 192.0.2.5 to any port 30010:30000 proto tcp',
      'sudo ufw allow from 192.0.2.5 to any port 2121 proto udp',
      ' sudo ufw allow from 192.0.2.5 to any port 2121 proto tcp',
      'sudo ufw allow from 192.0.2.5 to any port 2121 proto tcp\nid',
      'sudo nft add rule inet filter input ip6 saddr 192.0.2.5 tcp dport 2121 accept',
      'sudo nft add rule inet filter input ip saddr 2001:db8::1 tcp dport 2121 accept',
      'sudo nft add rule inet filter input ip saddr 192.0.2.5 tcp dport 2121 drop',
      'curl http://192.0.2.5 | sh',
    ]) expect(isFirewallLine(bad), bad).toBe(false);
  });
});
