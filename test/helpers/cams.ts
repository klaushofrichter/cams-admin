import { randomBytes } from 'crypto';
import { camsRequestText, generateKeyPair, privateFromB64, sign, signedText } from '../../server/crypto/ed25519';
import { normaliseCamsCode } from '../../server/ids';
import type { Running } from './server';

// A cams instance's key as the tests hold it (built with the server's own
// helpers; test-client/cams.ts is the independent client).
export interface CamsKeyT { instanceId: string; keyId: string; privateKey: string; publicKey: string }
export interface SignOpts {
  ts?: number; tsOffset?: number; nonce?: string; sigWith?: string; drop?: string; keyId?: string; instanceId?: string;
  tamperBody?: boolean; signPath?: string; headers?: Record<string, string>; now?: () => number;
}
export type SignedResponse = Response & { nonce: string };

export const newNonce = (): string => randomBytes(16).toString('base64url');

export async function enrollCamsKey(s: Running, instanceId: string): Promise<CamsKeyT> {
  const { code } = await s.api('POST', `/cams-instances/${instanceId}/enrollment-codes`, { lifetimeH: 1 });
  const k = generateKeyPair();
  const proof = sign(privateFromB64(k.privateKeyPkcs8B64), signedText.camsEnroll(normaliseCamsCode(code)!, k.publicKeySpkiB64));
  const r = await fetch(`${s.url}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, publicKey: k.publicKeySpkiB64, proof, camsVersion: 'test' }) });
  if (r.status !== 201) throw new Error(`enroll: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { instanceId: j.instanceId, keyId: j.keyId, privateKey: k.privateKeyPkcs8B64, publicKey: k.publicKeySpkiB64 };
}

export async function signedFetch(s: Running, key: CamsKeyT, method: string, path: string, body?: unknown, o: SignOpts = {}): Promise<SignedResponse> {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const ts = o.ts ?? (o.now ? o.now() : Date.now()) + (o.tsOffset ?? 0);
  const nonce = o.nonce ?? newNonce();
  const text = camsRequestText(method, o.signPath ?? path, ts, nonce, Buffer.from(raw, 'utf8'));
  const headers: Record<string, string> = {
    'X-Cams-Instance': o.instanceId ?? key.instanceId, 'X-Cams-Key': o.keyId ?? key.keyId, 'X-Cams-Ts': String(ts), 'X-Cams-Nonce': nonce,
    'X-Cams-Sig': sign(privateFromB64(o.sigWith ?? key.privateKey), text), ...(raw ? { 'Content-Type': 'application/json' } : {}), ...o.headers,
  };
  if (o.drop) delete headers[o.drop];
  const sent = o.tamperBody ? raw.replace(/}$/, ',"x":1}') : raw;
  const r = await fetch(`${s.url}${path}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : sent });
  return Object.assign(r, { nonce });
}
