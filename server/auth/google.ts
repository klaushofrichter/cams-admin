import { createHash, createPublicKey, createVerify, type JsonWebKeyInput } from 'crypto';

type JsonWebKey = JsonWebKeyInput['key'];
import type { Config } from '../config';

// Google OAuth, authorization code flow, scope "openid email" (spec §7).
// The ID token is verified here against Google's JWKS (RS256, iss, aud,
// exp), so a fake Google can stand in for the tests; real Google is never
// used in tests.

// PKCE S256 (RFC 7636) and the OIDC nonce: the callback can only be completed
// by the browser that started the sign-in.
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export function authUrl(cfg: Config, state: string, verifier: string, nonce: string): string {
  const p = new URLSearchParams({
    client_id: cfg.google.clientId, redirect_uri: cfg.google.redirectUri, response_type: 'code', scope: 'openid email', state,
    code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', nonce,
    prompt: 'select_account', // Logout really logs out: Google always asks.
  });
  return `${cfg.google.authUrl}?${p.toString()}`;
}

let jwksCache: { at: number; url: string; keys: (JsonWebKey & { kid?: string })[] } | null = null;
async function jwks(url: string): Promise<(JsonWebKey & { kid?: string })[]> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const keys = ((await r.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys;
  jwksCache = { at: Date.now(), url, keys };
  return keys;
}

export interface IdClaims { email: string; emailVerified: boolean }

const SKEW_S = 120;

export async function verifyIdToken(cfg: Config, token: string, nowMs: number, nonce: string): Promise<IdClaims> {
  const [h, c, s] = token.split('.');
  if (!h || !c || !s) throw new Error('id_token: malformed');
  const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string };
  if (head.alg !== 'RS256') throw new Error('id_token: alg');
  let keys = await jwks(cfg.google.certsUrl);
  let jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) {
    jwksCache = null; // rotated keys
    keys = await jwks(cfg.google.certsUrl);
    jwk = keys.find((k) => k.kid === head.kid);
  }
  if (!jwk) throw new Error('id_token: unknown key');
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('id_token: signature');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as { iss?: string; aud?: string; exp?: number; iat?: number; nbf?: number; nonce?: string; email?: string; email_verified?: boolean | string };
  if (claims.iss !== cfg.google.issuer && claims.iss !== cfg.google.issuer.replace(/^https:\/\//, '')) throw new Error('id_token: iss');
  if (claims.aud !== cfg.google.clientId) throw new Error('id_token: aud');
  if (!claims.exp || claims.exp * 1000 <= nowMs) throw new Error('id_token: expired');
  const now = nowMs / 1000;
  if (typeof claims.iat !== 'number' || claims.iat > now + SKEW_S) throw new Error('id_token: iat');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + SKEW_S)) throw new Error('id_token: nbf');
  if (claims.nonce !== nonce) throw new Error('id_token: nonce');
  if (typeof claims.email !== 'string') throw new Error('id_token: no email');
  return { email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true' };
}

export async function exchangeCode(cfg: Config, code: string, verifier: string): Promise<string> {
  const r = await fetch(cfg.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.google.clientId, client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', redirect_uri: cfg.google.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  const j = (await r.json()) as { id_token?: string };
  if (!j.id_token) throw new Error('token endpoint: no id_token');
  return j.id_token;
}
