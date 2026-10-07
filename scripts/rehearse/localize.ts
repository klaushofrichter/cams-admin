// The rehearsal's localizer (M §11.3): a real cams export (export-config,
// redacted: no password, tokens only as hashes) rewritten for the local
// stack: each proxy group's URL → a local proxy, its pins → the local test
// CA's (only where the file pins), optionally without the proxy TLS name.
// Everything else stays as it is; no field is added.
//   npx tsx scripts/rehearse/localize.ts --in real-export.json --map map.json --out local.json
// map.json: {"proxies": {"<real proxy url>": {"url": "http://127.0.0.1:29100", "caFingerprint": ["SHA256:…"]}}, "dropTlsServername": true}
// Inputs and outputs live in the scratch work dir, never in git.
import { readFileSync, writeFileSync } from 'fs';

export interface LocalizeMap { proxies: Record<string, { url: string; caFingerprint?: string[] }>; dropTlsServername?: boolean }
const trim = (u: string) => u.replace(/\/+$/, '');

function refuseSecrets(v: unknown, path: string): void {
  if (Array.isArray(v)) return v.forEach((x, i) => refuseSecrets(x, `${path}[${i}]`));
  if (typeof v !== 'object' || v === null) return;
  for (const [k, x] of Object.entries(v)) {
    if (/^password$/i.test(k)) throw new Error(`${path}.${k}: a password in the input (use the redacted export-config output)`);
    if (/^(token|adminToken)$/.test(k) && typeof x === 'string') throw new Error(`${path}.${k}: a token in clear in the input (use the redacted export-config output)`);
    refuseSecrets(x, `${path}.${k}`);
  }
}

export function localize(input: any, map: LocalizeMap): any {
  refuseSecrets(input, 'file');
  const byUrl = new Map(Object.entries(map.proxies).map(([k, v]) => [trim(k), v]));
  const out = structuredClone(input);
  for (const c of out.cameras ?? []) {
    if (!c.proxy) continue;
    const local = byUrl.get(trim(c.proxy.url));
    if (!local) throw new Error(`no local proxy for ${trim(c.proxy.url)} in the map`);
    c.proxy.url = local.url;
    if (c.proxy.caFingerprint !== undefined) {
      if (local.caFingerprint?.length) c.proxy.caFingerprint = local.caFingerprint;
      else delete c.proxy.caFingerprint;
    }
    if (map.dropTlsServername) delete c.proxy.tlsServername;
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(`--${n}`);
    if (i < 0 || !args[i + 1]) throw new Error(`--${n} is required`);
    return args[i + 1];
  };
  try {
    const out = localize(JSON.parse(readFileSync(opt('in'), 'utf8')), JSON.parse(readFileSync(opt('map'), 'utf8')));
    writeFileSync(opt('out'), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    console.log(`localize: ${out.cameras.length} cameras → ${opt('out')}`);
  } catch (e) {
    process.stderr.write(`localize: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
