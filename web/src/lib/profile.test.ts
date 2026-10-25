import { describe, expect, it } from 'vitest';
import { camerasLine, firewallLines, hardwareLine, hostOnly, moveFirewall, NO_PROFILE, size, spaceText, storageLine, warningText, type Profile } from './profile';
import { makeProfile, firewallLines as clientLines } from '../../../test-client/summaries';

const een = makeProfile() as Profile;

describe('profile (UI text)', () => {
  it('sizes in decimal units, as the storage budget counts them', () => {
    expect([size(null), size(500), size(41_000_000), size(4_500_000_000), size(600_000_000_000), size(1_000_000_000_000)]).toEqual(['—', '1 kB', '41 MB', '4.5 GB', '600 GB', '1.0 TB']);
  });
  it('the card lines', () => {
    expect(camerasLine(een)).toBe('1 of 3 cameras');
    expect(camerasLine({ held: 1, cameras: 1 })).toBe('1 of 1 camera');
    expect(storageLine(een)).toBe('Budget 600 GB (set in the profile), 41 GB used; disk 1.0 TB, 880 GB free');
    expect(storageLine({ storageGB: null, storage: { budgetBytes: 50_000_000_000, usedBytes: null, diskBytes: null, freeBytes: null } })).toBe('Budget 50 GB (from the storage settings)');
    expect(storageLine({ storageGB: null, storage: { budgetBytes: null, usedBytes: null, diskBytes: 1e12, freeBytes: null } })).toBe('Budget unknown; disk 1.0 TB');
    expect(hardwareLine(een.hardware)).toBe('Intel N100, 4 cores, 16 GB memory; load 0.70, 48.5 °C');
    expect(hardwareLine({ pi: 'Raspberry Pi 4 Model B', cpuCores: 4, cpuModel: 'Cortex-A72', memoryBytes: null, load5: 0.2, cpuTempC: null })).toBe('Raspberry Pi 4 Model B, 4 cores; load 0.20');
    expect(hardwareLine({ pi: null, cpuCores: null, cpuModel: null, memoryBytes: null, load5: null, cpuTempC: null })).toBe('unknown hardware');
  });
  it('warnings in plain words; an unknown one as it came', () => {
    expect(warningText('profile_ftp_ports')).toMatch(/^The FTP passive range has fewer ports/);
    expect(warningText('profile_cameras_exceeded')).toMatch(/^The proxy holds more cameras/);
    expect(warningText('profile_new_thing')).toBe('profile_new_thing');
  });
  it('the firewall lines match what the fixtures carry (cam-proxy prints the same)', () => {
    for (const tool of ['ufw', 'nft'] as const) expect(firewallLines(tool, '192.0.2.85', 2121, { from: 30000, to: 30029 })).toEqual(clientLines(tool, '192.0.2.85', 2121, { from: 30000, to: 30029 }));
    expect(firewallLines('ufw', '192.0.2.85', 2121, { from: 30000, to: 30029 })).toEqual(['sudo ufw allow from 192.0.2.85 to any port 2121 proto tcp', 'sudo ufw allow from 192.0.2.85 to any port 30000:30029 proto tcp']);
    expect(een.firewall.lines).toEqual(firewallLines('ufw', '192.0.2.85', 2121, { from: 30000, to: 30029 }));
    expect(firewallLines(null, '192.0.2.9', 21, null)).toEqual(['sudo ufw allow from 192.0.2.9 to any port 21 proto tcp']);
  });
  it('hostOnly: the address without a port; none for from-proxy or empty', () => {
    expect(['192.0.2.10', '192.0.2.10:443', '[2001:db8::1]:443', '2001:db8::1', 'cam.example.net', 'from-proxy', '', null].map(hostOnly)).toEqual(['192.0.2.10', '192.0.2.10', '2001:db8::1', '2001:db8::1', 'cam.example.net', null, null, null]);
  });
  it('moveFirewall: the target lines for the moving camera, by the target tool', () => {
    expect(moveFirewall('een', een, '192.0.2.10:443')).toEqual({ tool: 'ufw', lines: ['sudo ufw allow from 192.0.2.10 to any port 2121 proto tcp', 'sudo ufw allow from 192.0.2.10 to any port 30000:30029 proto tcp'] });
    expect(moveFirewall('mini', makeProfile({ tool: 'nft', port: 2121, passive: { from: 30000, to: 30019 } }) as Profile, '192.0.2.11')).toEqual({ tool: 'nft', lines: ['sudo nft add rule inet filter input ip saddr 192.0.2.11 tcp dport 2121 accept', 'sudo nft add rule inet filter input ip saddr 192.0.2.11 tcp dport 30000-30019 accept'] });
    expect(moveFirewall('old', null, '192.0.2.10')).toEqual({ none: `old: ${NO_PROFILE}; check its firewall by hand.` });
    expect(moveFirewall('cl', makeProfile({ ftp: false }) as Profile, '192.0.2.10')).toEqual({ none: 'FTP is off on cl: no firewall lines needed.' });
    expect(moveFirewall('een', een, 'from-proxy')).toEqual({ none: "The camera's address is not in the registry: the firewall lines need it." });
  });
  it('spaceText names the figures kept at request time', () => {
    expect(spaceText('een', null)).toBe('');
    expect(spaceText('een', { at: 1, needBytes: 37e9, budgetBytes: 600e9, usedBytes: 41e9, leftBytes: 559e9, fits: true, overCaps: [] })).toBe('The move needs 37 GB; een had 559 GB of its 600 GB budget left (41 GB used). It fits.');
    expect(spaceText('een', { at: 1, needBytes: 37e9, budgetBytes: 50e9, usedBytes: 41e9, leftBytes: 9e9, fits: false, overCaps: [{ kind: 'stills', bytes: 5e9, capBytes: 4e9 }] }))
      .toBe('The move needs 37 GB; een had 9.0 GB of its 50 GB budget left (41 GB used). Stills 5.0 GB is over its 4.0 GB cap. It does not all fit: leave kinds out or keep the newest content when you approve.');
  });
});
