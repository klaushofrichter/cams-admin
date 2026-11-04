import { describe, expect, it } from 'vitest';
import { addressInfo, addressMarker } from './address';

const scope = (a: string) => addressInfo(a).scope;

describe('addressInfo: which addresses warn', () => {
  it.each([
    'http://127.0.0.1:8080', 'http://127.255.255.254/', 'http://localhost', 'https://LOCALHOST:8443/x', 'http://localhost.', 'http://cams.localhost',
    'http://[::1]', 'http://[::1]:8080/', 'http://[0:0:0:0:0:0:0:1]', 'http://[::ffff:127.0.0.1]:8080', 'http://0.0.0.0:8080', 'http://[::]:8080',
    // Other spellings of 127.0.0.1 that a browser accepts.
    'http://2130706433', 'http://0x7f.0.0.1',
  ])('%s is loopback', (a) => {
    expect(scope(a)).toBe('loopback');
    expect(addressInfo(a).warning).toBe('Only works on that machine itself: this is probably the wrong address.');
  });

  it.each([
    'http://10.0.0.1', 'http://10.255.255.255:8080', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.0.1:8080/', 'http://169.254.1.1', 'http://100.64.0.1', 'http://100.127.255.255',
    'http://[fc00::1]', 'http://[fd12:3456::1]:8080', 'http://[fe80::1]', 'http://[febf::1]', 'http://[::ffff:192.168.0.1]',
    'http://minipc.local', 'https://cams.site.internal:8443', 'http://pi.lan', 'http://PI.LAN/', 'http://pi.local.', 'http://minipc:8080',
  ])('%s is a local network address', (a) => {
    expect(scope(a)).toBe('private');
    expect(addressInfo(a).warning).toBe('Local network address: only reachable from inside that network.');
  });

  it.each([
    'https://cams.example.net', 'https://cams.example.net:8443/a/', 'http://192.0.2.10:8080',
    // Just outside the ranges.
    'http://172.15.255.255', 'http://172.32.0.1', 'http://192.169.0.1', 'http://192.167.0.1', 'http://169.253.0.1', 'http://169.255.0.1', 'http://100.63.255.255', 'http://100.128.0.1',
    'http://11.0.0.1', 'http://9.255.255.255', 'http://128.0.0.1', 'http://126.0.0.1', 'http://1.0.0.1',
    'http://[2001:db8::1]', 'http://[fbff::1]', 'http://[fe00::1]', 'http://[fec0::1]', 'http://[::2]', 'http://[::ffff:192.0.2.1]',
    // A name only looks local by its last label.
    'https://local.example.net', 'https://example.lan.example.net', 'https://mylan.example', 'https://localhost.example.net',
  ])('%s is public: no warning', (a) => {
    expect(scope(a)).toBe('public');
    expect(addressInfo(a).warning).toBeNull();
  });
});

describe('addressInfo: what becomes a link', () => {
  it('http and https, with their port and path', () => {
    expect(addressInfo('https://cams.example.net:8443/a').href).toBe('https://cams.example.net:8443/a');
    expect(addressInfo('http://192.0.2.10:8080').href).toBe('http://192.0.2.10:8080/');
    expect(addressInfo('HTTP://[::1]:8080').href).toBe('http://[::1]:8080/');
  });
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'ftp://192.0.2.10/', 'file:///etc/hosts', 'cams.example.net', '192.0.2.10:8080', 'http://', ''])('%s is no link and no warning', (a) => {
    expect(addressInfo(a)).toEqual({ href: null, scope: null, warning: null });
  });
  it('no address at all', () => {
    expect(addressInfo(null).href).toBeNull();
    expect(addressInfo(undefined).href).toBeNull();
  });
});

describe('addressMarker: the compact form of the warning', () => {
  it('marks exactly the addresses that warn', () => {
    expect(addressMarker(addressInfo('http://garage.local:8480').scope)).toBe('LAN');
    expect(addressMarker(addressInfo('http://127.0.0.1:8480').scope)).toBe('loopback');
    expect(addressMarker(addressInfo('https://proxy.example.net').scope)).toBeNull();
    expect(addressMarker(addressInfo(null).scope)).toBeNull();
  });
});
