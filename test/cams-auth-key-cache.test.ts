import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tmpDir } from './helpers/tmp';
import { fakeClock } from './helpers/clock';
import { startServer, type Running } from './helpers/server';
import { enrollCamsKey, signedFetch } from './helpers/cams';

// Counts the public-key parses of the cams request check (efficiency, 2026-11-17): a key is parsed once,
// not on every signed request; a revoked key is still refused (the key row is read every time).
const parse = vi.hoisted(() => ({ count: 0 }));
vi.mock('../server/crypto/ed25519', async (orig) => {
  const actual = await orig<typeof import('../server/crypto/ed25519')>();
  return { ...actual, publicFromB64: (b64: string) => { parse.count++; return actual.publicFromB64(b64); } };
});

describe('cams-v1 request check: parsed public keys are cached', () => {
  const dir = tmpDir();
  const clock = fakeClock(Date.now());
  let s: Running;
  let acc: { id: string };
  beforeAll(async () => {
    s = await startServer(dir, {}, 0, clock);
    acc = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
  });
  afterAll(() => s.stop());

  it('three signed requests parse the key once; after a block the same key is refused', async () => {
    const inst = await s.api('POST', '/cams-instances', { name: 'kc', displayName: 'kc', accounts: [acc.id] });
    const key = await enrollCamsKey(s, inst.id);
    const call = () => signedFetch(s, key, 'GET', '/cams/v1/ping', undefined, { now: () => clock.now() });
    const before = parse.count;
    for (let i = 0; i < 3; i++) expect((await call()).status).toBe(200);
    expect(parse.count - before).toBe(1);
    await s.api('POST', `/cams-instances/${inst.id}/block`, {});
    const r = await call();
    expect([r.status, (await r.json()).error]).toEqual([403, 'revoked']);
  });
});
