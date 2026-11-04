// The proxy page's registry form: strings while typing, and what really changed for the PATCH.

export type ProxyForm = {
  displayName: string; name: string; runsOn: string; hostKind: string; url: string; adminUiUrl: string;
  dnsName: string; tlsSite: string; tlsServername: string; fps: string; notes: string;
};
interface ProxyRow {
  displayName: string; name: string; runsOn: string; hostKind: string | null; url: string | null; adminUiUrl: string | null;
  dnsName: string | null; tlsSite: string | null; tlsServername: string | null; caFingerprints: string[]; notes: string | null;
}

export const proxyForm = (p: ProxyRow): ProxyForm => ({
  displayName: p.displayName, name: p.name, runsOn: p.runsOn, hostKind: p.hostKind ?? '', url: p.url ?? '', adminUiUrl: p.adminUiUrl ?? '',
  dnsName: p.dnsName ?? '', tlsSite: p.tlsSite ?? '', tlsServername: p.tlsServername ?? '', fps: p.caFingerprints.join('\n'), notes: p.notes ?? '',
});

// As the server's name rule (PROXY_NAME_RE; test/proxy-rename.test.ts holds them together).
export const validProxyName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name.trim());

const fingerprints = (s: string) => s.split(/[\s,]+/).filter(Boolean);

// Only what really changed goes to the server, so the audit's `fields` tell what was edited.
export function proxyPatch(form: ProxyForm, saved: ProxyForm): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of ['displayName', 'name', 'runsOn'] as const) {
    const v = form[k].trim();
    if (v !== saved[k].trim()) patch[k] = v;
  }
  for (const k of ['hostKind', 'url', 'adminUiUrl', 'dnsName', 'tlsSite', 'tlsServername', 'notes'] as const) {
    const v = form[k].trim();
    if (v !== saved[k].trim()) patch[k] = v || null;
  }
  const fps = fingerprints(form.fps);
  if (fps.join('\n') !== fingerprints(saved.fps).join('\n')) patch.caFingerprints = fps;
  return patch;
}
