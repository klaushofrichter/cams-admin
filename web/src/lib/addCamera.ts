// Add camera with a proxy (finding 12b): cams needs a host and a protocol (and a TLS name for a site-CA camera). The
// proxy's report of the camera has them; what it lacks the form asks for. Empty fields are left to the server, which
// takes the report's values.
export interface ReportedCam { ref: string; online?: boolean; address?: string; protocol?: string; tlsName?: string }
export interface FromReport { host: string | null; protocol: 'https' | 'http' | null; tlsName: string | null; needs: ('host' | 'protocol')[] }

export function reportedOf(cameras: ReportedCam[] | null | undefined, ref: string): FromReport {
  const c = (cameras ?? []).find((x) => x.ref === ref);
  const host = c?.address || null;
  const protocol = c?.protocol === 'https' || c?.protocol === 'http' ? c.protocol : null;
  const tlsName = protocol === 'https' && c?.tlsName ? c.tlsName : null;
  return { host, protocol, tlsName, needs: [...(host ? [] : ['host' as const]), ...(protocol ? [] : ['protocol' as const])] };
}

export interface AddCameraForm { camsId: string; name: string; kind: string; proxyId: string; proxyCameraId: string; host: string; protocol: string; tlsName: string }
export function addCameraBody(f: AddCameraForm): Record<string, unknown> {
  const body: Record<string, unknown> = { camsId: f.camsId, name: f.name, kind: f.kind, proxyId: f.proxyId || null, proxyCameraId: f.proxyCameraId || null };
  if (!f.proxyId) return body;
  if (f.host.trim()) body.host = f.host.trim();
  if (f.protocol) body.protocol = f.protocol;
  if (f.tlsName.trim()) body.tlsServername = f.tlsName.trim();
  return body;
}
