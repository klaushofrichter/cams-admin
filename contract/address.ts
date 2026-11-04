// What a stored address can be used for on a page: only http/https becomes a
// link, and the host says who can reach it. By the text of the address alone:
// no DNS lookup, so a public name pointing at a private address stays "public".

export type AddressScope = 'loopback' | 'private' | 'public';
export interface AddressInfo { href: string | null; scope: AddressScope | null; warning: string | null }

const WARNING: Record<AddressScope, string | null> = {
  loopback: 'Only works on that machine itself: this is probably the wrong address.',
  private: 'Local network address: only reachable from inside that network.',
  public: null,
};

// The compact visible form of WARNING, for tables and lists.
const MARKER: Record<AddressScope, string | null> = { loopback: 'loopback', private: 'LAN', public: null };
export const addressMarker = (scope: AddressScope | null): string | null => (scope ? MARKER[scope] : null);

function ipv4Scope(a: number, b: number): AddressScope {
  if (a === 127 || a === 0) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

// `host` as the URL parser leaves it: compressed, lower case, no brackets.
function ipv6Scope(host: string): AddressScope {
  if (host === '::1' || host === '::') return 'loopback';
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return ipv4Scope(high >> 8, high & 0xff);
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return 'private';
  return 'public';
}

// `hostname` comes from the URL parser, which also turns the other spellings of
// an IPv4 address (2130706433, 0x7f.0.0.1) into the dotted one the browser uses.
export function hostScope(hostname: string): AddressScope {
  if (hostname.startsWith('[')) return ipv6Scope(hostname.slice(1, -1));
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (v4) return ipv4Scope(Number(v4[1]), Number(v4[2]));
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback';
  // A name without a dot only resolves on the local network.
  if (!name.includes('.') || /\.(local|internal|lan)$/.test(name)) return 'private';
  return 'public';
}

export function addressInfo(address: string | null | undefined): AddressInfo {
  const none: AddressInfo = { href: null, scope: null, warning: null };
  if (!address) return none;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return none;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return none;
  const scope = hostScope(url.hostname);
  return { href: url.href, scope, warning: WARNING[scope] };
}
