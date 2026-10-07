import { describe, expect, it } from 'vitest';
import { jcs } from '../server/crypto/jcs';
import { keyFromSeed, privateFromB64, publicFromB64, signEnvelope, unsigned, verifyEnvelope } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';

describe('JCS (RFC 8785)', () => {
  it('RFC 8785 §3.2.3: keys sorted by UTF-16 code units', () => {
    const input = { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Smiley', '\u0080': 'Control', '\u00f6': 'Latin' };
    expect(jcs(input)).toBe('{"\\r":"CR","1":"One","\u0080":"Control","\u00f6":"Latin","\u20ac":"Euro","\ud83d\ude00":"Smiley","\ufb33":"Hebrew"}');
  });
  it('numbers and escapes as ES writes them', () => {
    expect(jcs([-0, 1e21, 1e-7, 0.1, 100, 'a"\\\n\u2028'])).toBe('[0,1e+21,1e-7,0.1,100,"a\\"\\\\\\n\u2028"]');
  });
  it('refuses what JSON cannot say', () => {
    // eslint-disable-next-line no-sparse-arrays
    for (const bad of [undefined, NaN, -Infinity, () => 1, new Date(0), { a: undefined }, [1, , 2], new Map()]) expect(() => jcs(bad)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(() => jcs(deep)).toThrow(/too deep/);
  });
  it('the committed vectors: every jcs case, every envelope signature', () => {
    const v = vectors as unknown as { jcs: { name: string; input: unknown; text: string }[]; envelopes: { key: string; envelope: Record<string, unknown>; text: string; sig: string }[] };
    expect(v.jcs.length).toBeGreaterThanOrEqual(4);
    expect(v.envelopes.map((e) => (e.envelope as { type: string }).type)).toEqual(['command', 'result', 'event', 'command', 'command', 'result', 'command', 'result', 'command', 'command', 'command', 'command']);
    const p3 = v.envelopes.slice(4) as unknown as { envelope: { body: Record<string, any> } }[];
    expect(p3[0].envelope.body).toMatchObject({ command: 'config.set', args: { v: 1, dryRun: false, set: { 'sse.pingS': 5 } } });
    // Deny vector: a local-only capture switch, refused by the proxy.
    expect(p3[2].envelope.body).toMatchObject({ command: 'config.set', args: { set: { 'ftp.enabled': false } } });
    expect(p3[3].envelope.body).toMatchObject({ status: 'failed', code: 'not_remote_settable' });
    // JCS edge cases: non-ASCII names (UTF-16 order, U+2028), a null camera, rollback, unset with dotted keys.
    expect(p3[4].envelope.body).toMatchObject({ command: 'camera.name.set', args: { name: 'Café 😀 Ost' } });
    expect(p3[5].envelope.body).toMatchObject({ command: 'camera.action', args: { camera: null, action: 'retention-run' } });
    expect(p3[6].envelope.body).toMatchObject({ command: 'config.rollback' });
    expect(p3[7].envelope.body).toMatchObject({ command: 'config.unset', args: { paths: ['sse.pingS', 'cameras.cam1.name'] } });
    expect(p3[1].envelope.body).toMatchObject({ phase: 'done', status: 'ok', result: { changes: [{ path: 'sse.pingS', from: 30, to: 5, sourceFrom: 'default', sourceTo: 'override' }] } });
    for (const c of v.jcs) expect(jcs(c.input), c.name).toBe(c.text);
    for (const e of v.envelopes) {
      const k = (vectors.keys as Record<string, { seedHex: string; publicKey: string }>)[e.key];
      expect(jcs(e.envelope)).toBe(e.text);
      expect(signEnvelope(privateFromB64(keyFromSeed(k.seedHex).privateKeyPkcs8B64), e.envelope)).toBe(e.sig);
      expect(verifyEnvelope(publicFromB64(k.publicKey), { ...e.envelope, sig: e.sig })).toBe(true);
      expect(verifyEnvelope(publicFromB64(vectors.keys.other.publicKey), { ...e.envelope, sig: e.sig })).toBe(false);
      expect(verifyEnvelope(publicFromB64(k.publicKey), { ...e.envelope, sig: e.sig, extra: 1 })).toBe(false);
      expect(unsigned({ ...e.envelope, sig: e.sig })).toEqual(e.envelope);
    }
  });
});
