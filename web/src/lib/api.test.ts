import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('sends JSON with the CSRF header on writes, and parses the answer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'acc_1' }), { status: 201 }));
    vi.stubGlobal('fetch', f);
    expect(await api('POST', '/accounts', { name: 'x' })).toEqual({ id: 'acc_1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/accounts');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Cams-Admin': '1' });
    expect(init.body).toBe('{"name":"x"}');
  });
  it('maps errors to ApiFailure with the field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'duplicate_email', field: 'email' }), { status: 409 })));
    await expect(api('POST', '/x', {})).rejects.toMatchObject({ status: 409, code: 'duplicate_email', field: 'email' });
    await expect(api('POST', '/x', {})).rejects.toBeInstanceOf(ApiFailure);
  });
  it('204 is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await api('DELETE', '/x')).toBeUndefined();
  });
});
