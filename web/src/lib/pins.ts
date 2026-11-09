// #106: cams takes a proxy's CA pins only over https or loopback http; cams-admin leaves the pins out of the snapshot
// for an instance that reaches the proxy over other plain http. These texts warn where pins and routes are set.
import { pinTransportOk } from '../../../server/cams/pinTransport';

// Proxy page: `fps` is the fingerprint field as typed; `routes` the instances that reach the proxy over plain http.
export function pinsNotSentText(fps: string, routes: { displayName: string; url: string }[]): string {
  if (!fps.trim() || !routes.length) return '';
  const one = routes.length === 1;
  const names = routes.map((r) => r.displayName).join(', ');
  const urls = routes.map((r) => r.url).join(', ');
  return `${names} reach${one ? 'es' : ''} this proxy over plain http (${urls}), so ${one ? 'it gets' : 'they get'} the proxy without these pins: cams takes pins only over https or loopback.`;
}

// Instance page: the proxy's pins, the route URL being edited ('' = the registered URL) and the registered URL.
export function routePinWarning(pins: string[], routeUrl: string, registeredUrl: string | null): string {
  const url = routeUrl.trim() || registeredUrl;
  if (!pins.length || url === null || pinTransportOk(url)) return '';
  return 'Plain http: this instance gets the proxy without its CA pins (cams takes pins only over https or loopback).';
}
