import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { localize } from '../scripts/rehearse/localize';
import { parseCamsExport } from '../server/import/export-format';

const CLUSTER = JSON.parse(readFileSync(join(__dirname, 'fixtures/import/cluster.json'), 'utf8'));
const LOCAL_FP = 'SHA256:' + 'CD'.repeat(32);
const MAP = { proxies: { 'https://proxy.example.net:8480': { url: 'http://127.0.0.1:29100', caFingerprint: [LOCAL_FP] }, 'https://cluster-proxy.example.net': { url: 'http://127.0.0.1:29200' } } };

describe('localize (rehearsal, M §11.3)', () => {
  it('rewrites URLs by proxy group and pins to the local CA; everything else identical, no field added', () => {
    const out = localize(CLUSTER, MAP);
    expect(out.cameras.map((c: any) => c.proxy.url)).toEqual(['http://127.0.0.1:29100', 'http://127.0.0.1:29200']);
    expect(out.cameras[0].proxy.caFingerprint).toEqual([LOCAL_FP]);
    const strip = (x: any) => ({ ...x, cameras: x.cameras.map((c: any) => ({ ...c, proxy: { ...c.proxy, url: 'U', caFingerprint: 'P' } })) });
    expect(strip(out)).toEqual(strip(CLUSTER));
    expect(Object.keys(out.cameras[1].proxy).sort()).toEqual(Object.keys(CLUSTER.cameras[1].proxy).sort());
    expect(parseCamsExport(out).cameras).toHaveLength(2);
    expect(CLUSTER.cameras[0].proxy.url).toBe('https://proxy.example.net:8480'); // the input is not changed
  });
  it('drops the proxy TLS name when asked (local proxies are plain http)', () => {
    const f = structuredClone(CLUSTER);
    f.cameras[1].proxy.tlsServername = 'cluster-proxy.example.net';
    expect(localize(f, { ...MAP, dropTlsServername: true }).cameras[1].proxy.tlsServername).toBeUndefined();
    expect(localize(f, MAP).cameras[1].proxy.tlsServername).toBe('cluster-proxy.example.net');
  });
  it('refuses input with a password or a token in clear, and an unmapped proxy URL', () => {
    const pw = structuredClone(CLUSTER);
    pw.cameras[0].password = 'x';
    expect(() => localize(pw, MAP)).toThrow(/password/);
    const tok = structuredClone(CLUSTER);
    tok.cameras[0].proxy.token = 'a'.repeat(43);
    expect(() => localize(tok, MAP)).toThrow(/token/);
    expect(() => localize(CLUSTER, { proxies: {} })).toThrow(/no local proxy for https:\/\/proxy\.example\.net:8480/);
  });
});
