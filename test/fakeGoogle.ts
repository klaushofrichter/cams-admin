// A stand-in for Google's OAuth endpoints, for the tests and the e2e (real
// Google is never used). /auth redirects straight back with a code naming
// the email; /token answers an RS256 ID token for it; /certs the JWKS.
//   node: npx tsx test/fakeGoogle.ts <port>
import { createServer, type Server } from 'http';
import { createSign, generateKeyPairSync, randomBytes } from 'crypto';

export interface FakeGoogle { url: string; port: number; setEmail(e: string, verified?: boolean): void; close(): Promise<void>; server: Server }

export async function startFakeGoogle(o: { port?: number; clientId?: string; issuer?: string } = {}): Promise<FakeGoogle> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(4).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  let email = 'admin@example.com';
  let verified = true;
  const codes = new Map<string, { email: string; verified: boolean; aud: string }>();
  const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/auth') {
      const code = randomBytes(8).toString('hex');
      const hint = u.searchParams.get('login_hint');
      codes.set(code, { email: hint ?? email, verified, aud: u.searchParams.get('client_id') ?? '' });
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        if (!c) return void res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid_grant"}');
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
        const claims = b64({ iss: o.issuer ?? 'https://accounts.google.com', aud: f.get('client_id') ?? c.aud, sub: '1', email: c.email, email_verified: c.verified, iat: now, exp: now + 3600 });
        const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKey);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: `${head}.${claims}.${b64(sig)}`, access_token: 'x', token_type: 'Bearer' }));
      });
      return;
    }
    // The e2e sets who signs in next (test-only server, loopback).
    if (u.pathname === '/set') {
      email = u.searchParams.get('email') ?? email;
      verified = u.searchParams.get('verified') !== 'false';
      return void res.writeHead(204).end();
    }
    if (u.pathname === '/certs') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, port, server,
    setEmail(e, v = true) { email = e; verified = v; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export const fakeGoogleEnv = (g: { url: string }) => ({
  GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_CERTS_URL: `${g.url}/certs`,
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
});

if (require.main === module) {
  startFakeGoogle({ port: Number(process.argv[2] || 0) }).then((g) => console.log(`fake google on ${g.url}`));
}
