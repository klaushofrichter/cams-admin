// A reference cams client of the cams-v1 service API (contract/cams-v1), for
// tests, the local stack and the rehearsal. It builds the signed texts from
// the contract README on its own (node crypto), not from server/cams/*, so a
// server change that breaks the contract breaks this client too. The only
// shared primitive is jcs (cams copies server/crypto/jcs.ts verbatim).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'crypto';
import { jcs } from '../server/crypto/jcs';

export interface CamsKeyFile {
  v: 1; url: string; apiUrl: string; instanceId: string; instanceName: string; keyId: string; privateKey: string; publicKey: string;
  serverKeys: string[]; serverKeyFingerprints: string[]; accounts: string[]; enrolledAt: number;
}
export interface CamsClientOptions { url: string; instanceId: string; keyId: string; privateKey: string; serverKeys: string[]; clockOffsetMs?: number }
export interface CamsAnswer { status: number; headers: Headers; json: any; bytes: Buffer; signatureOk: boolean }
export interface CamsSnapshot {
  v: 1; type: 'cams-config'; instance: { id: string; name: string; rotateBefore: number | null }; revision: string; generatedAt: number; sig: string;
  accounts: { id: string; name: string; displayName: string; revision: number; users: { email: string; role: string; disabled: boolean }[];
    proxies: { id: string; name: string; displayName: string; url: string | null; adminUiUrl: string | null; tlsServername: string | null; caFingerprints: string[]; tokens: { id: string; kind: string; state: string; retireAt: number | null }[] }[];
    cameras: Record<string, unknown>[] }[];
}

const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const priv = (b64: string) => createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const pub = (b64: string) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
const signText = (k: KeyObject, text: string) => sign(null, Buffer.from(text, 'utf8'), k).toString('base64');
const verifyText = (keys: string[], text: string, sig: string | null) =>
  !!sig && /^[A-Za-z0-9+/]{86}==$/.test(sig) && keys.some((k) => { try { return verify(null, Buffer.from(text, 'utf8'), pub(k), Buffer.from(sig, 'base64')); } catch { return false; } });
// The contract's code rule: upper case, spaces/dashes dropped, O→0, I/L→1, tag CAC1.
export function canonicalCamsCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^CAC1[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return null;
  return `CAC1-${s.slice(4).match(/.{4}/g)!.join('-')}`;
}
const SHA256_FP = (spkiB64: string) => 'SHA256:' + hex(Buffer.from(spkiB64, 'base64')).toUpperCase();

// POST /cams/v1/enroll with a fresh key (unsigned request and answer).
export async function enrollCams(url: string, code: string, camsVersion = 'test-client'): Promise<CamsKeyFile> {
  const canonical = canonicalCamsCode(code);
  if (!canonical) throw new Error('enroll: not a cams enrollment code');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const proof = signText(privateKey, `cams-admin cams-enroll v1\n${canonical}\n${publicKeyB64}`);
  const base = url.replace(/\/+$/, '');
  const r = await fetch(`${base}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: canonical, publicKey: publicKeyB64, proof, camsVersion }), signal: AbortSignal.timeout(10_000) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (r.status !== 201) throw new Error(`enroll: ${r.status} ${j.error ?? ''}`);
  // The answer is unsigned: what a person compares is the fingerprint.
  if ((j.serverKeys as string[]).map(SHA256_FP).join() !== (j.serverKeyFingerprints as string[]).join()) throw new Error('enroll: server key fingerprints do not match the keys');
  return {
    v: 1, url: base, apiUrl: j.apiUrl, instanceId: j.instanceId, instanceName: j.instanceName, keyId: j.keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKeyB64, serverKeys: j.serverKeys, serverKeyFingerprints: j.serverKeyFingerprints, accounts: j.accounts, enrolledAt: Date.now(),
  };
}

export class CamsTestClient {
  offsetMs: number;
  private key: KeyObject;
  constructor(readonly options: CamsClientOptions) {
    this.key = priv(options.privateKey);
    this.offsetMs = options.clockOffsetMs ?? 0;
  }

  // A signed request; the answer must carry a valid X-Cams-Admin-Sig from a
  // pinned server key (else admin_answer_unsigned). A signed 401 clock_skew
  // sets the offset (|offset| ≤ 7 d) and retries once with a fresh nonce.
  async request(method: string, path: string, body?: unknown, o: { headers?: Record<string, string>; retried?: boolean } = {}): Promise<CamsAnswer> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now() + this.offsetMs;
    const nonce = randomBytes(16).toString('base64url');
    const text = `cams-admin/v1 request\n${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${hex(raw)}`;
    const r = await fetch(`${this.options.url.replace(/\/+$/, '')}${path}`, {
      method, body: method === 'GET' ? undefined : raw, signal: AbortSignal.timeout(10_000),
      headers: {
        'X-Cams-Instance': this.options.instanceId, 'X-Cams-Key': this.options.keyId, 'X-Cams-Ts': String(ts), 'X-Cams-Nonce': nonce, 'X-Cams-Sig': signText(this.key, text),
        ...(raw ? { 'Content-Type': 'application/json' } : {}), ...o.headers,
      },
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    const signatureOk = verifyText(this.options.serverKeys, `cams-admin/v1 response\n${r.status}\n${nonce}\n${hex(bytes)}`, r.headers.get('x-cams-admin-sig'));
    if (!signatureOk) throw new Error(`admin_answer_unsigned (${method} ${path}: ${r.status})`);
    const json = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    if (r.status === 401 && json?.error === 'clock_skew' && !o.retried && Number.isSafeInteger(json.serverTime)) {
      const offset = json.serverTime - Date.now();
      if (Math.abs(offset) <= 7 * 86400_000) {
        this.offsetMs = offset;
        return this.request(method, path, body, { ...o, retried: true });
      }
    }
    return { status: r.status, headers: r.headers, json, bytes, signatureOk };
  }

  get(path: string, headers?: Record<string, string>): Promise<CamsAnswer> {
    return this.request('GET', path, undefined, { headers });
  }
  post(path: string, body: unknown): Promise<CamsAnswer> {
    return this.request('POST', path, body);
  }

  // The current snapshot, its own signature checked (jcs over it without sig).
  async snapshot(): Promise<CamsSnapshot> {
    const a = await this.get('/cams/v1/config');
    if (a.status !== 200) throw new Error(`config: ${a.status} ${a.json?.error ?? ''}`);
    if (!verifySnapshot(a.json, this.options.serverKeys)) throw new Error('admin_answer_unsigned (snapshot sig)');
    return a.json as CamsSnapshot;
  }
}

export function verifySnapshot(s: unknown, serverKeys: string[]): boolean {
  if (typeof s !== 'object' || s === null) return false;
  const { sig, ...rest } = s as Record<string, unknown>;
  return typeof sig === 'string' && verifyText(serverKeys, jcs(rest), sig);
}
