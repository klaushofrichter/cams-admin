import type { ImportResult } from '../server/import/importer';

// The importer's result as text lines (npm run import): changes, mismatches
// (with the ids --accept-mismatch takes) and the outcome. Hashes appear only
// as the 8-hex prefixes the result carries.
export function formatImport(r: ImportResult): string[] {
  const out = [`${r.dryRun ? 'dry run' : 'apply'}: account ${r.account}, instance ${r.instance}`];
  for (const c of r.changes) {
    switch (c.kind) {
      case 'proxy-matched': out.push(`  proxy ${c.name}: matched by ${c.by} (${c.fileUrl})`); break;
      case 'proxy-new': out.push(`  proxy NEW ${c.name}: ${c.url}`); break;
      case 'route-add': out.push(`  route ${c.name}: ${c.url ?? '(registered URL)'}`); break;
      case 'route-change': out.push(`  route ${c.name}: ${c.was ?? '(hidden)'} → ${c.url ?? '(registered URL)'}`); break;
      case 'route-hide': out.push(`  route ${c.name}: hidden for this instance`); break;
      case 'camera-new': out.push(`  camera NEW ${c.camsId}`); break;
      case 'camera-change': out.push(`  camera ${c.camsId}: ${Object.entries(c.fields).map(([k, v]) => `${k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(', ')}`); break;
      case 'camera-override': out.push(`  camera ${c.camsId}: override for ${c.instance}: ${Object.entries(c.fields).map(([k, v]) => `${k} ${JSON.stringify(v!.from)} → ${JSON.stringify(v!.to)}${v!.override === null ? " (the camera's value)" : ''}`).join(', ')}`); break;
      case 'pins-set': out.push(`  pins ${c.name}: ${c.from.join(',') || '(none)'} → ${c.to.join(',')}`); break;
      case 'proxy-tls-name': out.push(`  TLS name ${c.name}: ${c.from ?? '(none)'} → ${c.to}`); break;
      case 'token-external': out.push(`  external ${c.tokenKind} token on ${c.name}: ${c.hashPrefix}`); break;
      case 'registry-only': out.push(`  camera ${c.camsId}: in the registry, not in the file (kept)`); break;
    }
  }
  if (r.looksLike?.length) out.push(`  WARNING: this file looks like the export of cams instance ${r.looksLike.join(', ')}, not ${r.instance}`);
  for (const m of r.mismatches) out.push(`  MISMATCH ${m.id} ${m.what}: ${m.detail}`);
  for (const b of r.blockers) out.push(`  BLOCKED: ${b}${b === 'unknown_proxy' ? ' (--create-proxies)' : ''}`);
  out.push(r.noChanges ? 'No changes.' : r.applied ? 'Applied.' : r.blocked ? 'Not applied: accept the mismatches (--accept-mismatch) or fix them.' : 'Dry run: nothing written (--apply).');
  return out;
}
