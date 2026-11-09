import { describe, expect, it } from 'vitest';
import { pinsNotSentText, routePinWarning } from './pins';

const PIN = `SHA256:${'AB'.repeat(32)}`;

describe('#106: pins that a plain-http route leaves out', () => {
  it('the proxy page names each instance and its URL, only while pins are set', () => {
    const routes = [{ displayName: 'Cluster', url: 'http://cam-proxy.cam-proxy.svc.cluster.local:8480' }];
    expect(pinsNotSentText('', routes)).toBe('');
    expect(pinsNotSentText(PIN, [])).toBe('');
    expect(pinsNotSentText(PIN, routes)).toBe("Cluster reaches this proxy over plain http (http://cam-proxy.cam-proxy.svc.cluster.local:8480), so it gets the proxy without these pins: cams takes pins only over https or loopback.");
  });
  it('the instance page warns on a pinned proxy whose URL for this instance is plain http and not loopback', () => {
    expect(routePinWarning([PIN], 'http://cam-proxy.cam-proxy.svc.cluster.local:8480', 'https://proxy.example.net')).toBe("Plain http: this instance gets the proxy without its CA pins (cams takes pins only over https or loopback).");
    expect(routePinWarning([PIN], '', 'http://192.0.2.5:8480')).not.toBe('');
    expect(routePinWarning([PIN], '', 'https://proxy.example.net')).toBe('');
    expect(routePinWarning([PIN], 'http://127.0.0.1:8480', 'https://proxy.example.net')).toBe('');
    expect(routePinWarning([], 'http://192.0.2.5:8480', null)).toBe('');
  });
});
