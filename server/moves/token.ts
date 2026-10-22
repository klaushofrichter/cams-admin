import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { generateToken } from '../tokens/service';

// The per-move bearer token (plan R4, A33): made at move.request. Its hash
// ('sha256:' + lowercase hex of SHA-256 over the token's UTF-8, the format
// cam-proxy's moveTokenMatches compares) goes to the source in move.open; the
// plaintext only into the target's move.offer args (never the DB otherwise,
// an audit record, a log line or a snapshot).
export function moveToken(): { token: string; tokenHash: string } {
  const { token, hash } = generateToken();
  return { token, tokenHash: hash };
}

export type Resolve = (host: string) => Promise<string>;
export const dnsResolve: Resolve = async (host) => (await lookup(host)).address;

const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

// The address the source will see the target come from (R4; cam-proxy final
// review 4): the host of the target's registry url, resolved once when it is a
// name. null when there is no url or it doesn't resolve to an address.
export async function targetAddress(url: string | null, resolve: Resolve = dnsResolve): Promise<string | null> {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
  if (!host) return null;
  let ip: string;
  try {
    ip = isIP(host) ? host : await resolve(host);
  } catch {
    return null;
  }
  return isIP(ip) && IP_RE.test(ip) ? ip : null;
}
