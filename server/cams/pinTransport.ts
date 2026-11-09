// #106: cams takes a proxy's CA pins only with an https URL or a loopback http one (cams server/tls/loopback.ts,
// "else the token travels in clear"); a pin with a plain-http, non-loopback URL makes it refuse the whole account
// part (snapshot_invalid). Pure (no imports): the web pages use it for their warnings too.

export const isLoopbackHost = (h: string): boolean => {
  const x = h.toLowerCase();
  return x === 'localhost' || x === '[::1]' || /^127(\.\d{1,3}){3}$/.test(x);
};

// Whether cams accepts pins with this URL. No URL, or one that does not parse, is left to cams's own checks (true).
export function pinTransportOk(url: string | null): boolean {
  if (url === null) return true;
  let u: URL;
  try { u = new URL(url); } catch { return true; }
  return u.protocol !== 'http:' || isLoopbackHost(u.hostname);
}
