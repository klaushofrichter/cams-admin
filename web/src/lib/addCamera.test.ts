import { describe, expect, it } from 'vitest';
import { addCameraBody, reportedOf } from './addCamera';

const reported = [
  { ref: 'cam1', online: true, address: '192.0.2.10', protocol: 'https', tlsName: 'cam1.site.internal' },
  { ref: 'cam2', online: true, address: '192.0.2.11', protocol: 'http' },
  { ref: 'cam3', online: false },
];

describe('Add camera: host, protocol and TLS name (finding 12b)', () => {
  it("reads the proxy's report of the camera; what it lacks the form asks for", () => {
    expect(reportedOf(reported, 'cam1')).toEqual({ host: '192.0.2.10', protocol: 'https', tlsName: 'cam1.site.internal', needs: [] });
    expect(reportedOf(reported, 'cam2')).toEqual({ host: '192.0.2.11', protocol: 'http', tlsName: null, needs: [] });
    expect(reportedOf(reported, 'cam3')).toEqual({ host: null, protocol: null, tlsName: null, needs: ['host', 'protocol'] });
    expect(reportedOf(reported, 'cam9')).toEqual({ host: null, protocol: null, tlsName: null, needs: ['host', 'protocol'] });
    expect(reportedOf(null, 'cam1').needs).toEqual(['host', 'protocol']);
  });
  it('the body: typed values win, empty ones are left to the server (the report); no proxy, none of them', () => {
    const base = { camsId: 'e1', name: 'PTZ', kind: 'camera' };
    expect(addCameraBody({ ...base, proxyId: 'prx_1', proxyCameraId: 'cam1', host: '', protocol: '', tlsName: '' }))
      .toEqual({ ...base, proxyId: 'prx_1', proxyCameraId: 'cam1' });
    expect(addCameraBody({ ...base, proxyId: 'prx_1', proxyCameraId: 'cam3', host: ' 192.0.2.12 ', protocol: 'https', tlsName: 'e1.pi.internal' }))
      .toEqual({ ...base, proxyId: 'prx_1', proxyCameraId: 'cam3', host: '192.0.2.12', protocol: 'https', tlsServername: 'e1.pi.internal' });
    expect(addCameraBody({ ...base, proxyId: '', proxyCameraId: '', host: '192.0.2.12', protocol: 'https', tlsName: '' }))
      .toEqual({ ...base, proxyId: null, proxyCameraId: null });
  });
});
