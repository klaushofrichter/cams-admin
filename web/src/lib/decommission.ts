// Remove camera / Decommission proxy (spec 2026-11-08 B4/B5): the panels' lines and the proxy's answer in words.
import { proxyDeleteLines, type DeleteLines, type ProxyPreview } from './deletes';
import { bytes } from './format';

export interface RemovePreview { camera: string; clips: number; stills: number; archivedClips: number; bytes: number }
export interface RemoveAnswer { removed?: string[]; leftovers?: string[]; deleted?: { clips?: number; stills?: number; archivedClips?: number } }
export type RemoveContent = 'keep' | 'delete';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The archive checkbox: offered only with delete now and only when the camera has archived clips (Klaus 2026-11-08).
export const archiveOffered = (p: RemovePreview | null, content: RemoveContent): boolean => content === 'delete' && !!p && p.archivedClips > 0;

export function removeLines(p: RemovePreview, content: RemoveContent, archive: boolean): DeleteLines {
  const media = `${count(p.clips, 'clip')} and ${count(p.stills, 'still')}`;
  const arch = p.archivedClips > 0 ? [count(p.archivedClips, 'archived clip')] : [];
  const delArchive = content === 'delete' && archive && arch.length > 0;
  return {
    goes: [
      "on the proxy: the camera's FTP upload, its settings, stored password, certificate trust and PTZ positions",
      ...(content === 'delete' ? [`on the proxy, now: ${media}${delArchive ? ` and ${arch[0]}` : ''}`] : []),
      "in cams-admin: the camera's record (never added back automatically), its move records and power record",
    ],
    stays: [
      ...(content === 'keep' ? [`on the proxy: ${media} (${bytes(p.bytes)} in all, with the archive) until retention ages them out`] : []),
      ...(arch.length && !delArchive ? [`on the proxy: ${arch[0]} (outside retention)`] : []),
      'the audit log',
    ],
    blocked: null,
  };
}

export function removeAnswerText(a: RemoveAnswer | null | undefined): string {
  const d = a?.deleted ?? {};
  const parts = [`Removed: ${(a?.removed ?? []).join(', ') || 'nothing'}.`];
  const n = (d.clips ?? 0) + (d.stills ?? 0) + (d.archivedClips ?? 0);
  if (n > 0) parts.push(`Deleted ${count(d.clips ?? 0, 'clip')}, ${count(d.stills ?? 0, 'still')}${d.archivedClips ? `, ${count(d.archivedClips, 'archived clip')}` : ''}.`);
  if (a?.leftovers?.length) parts.push(`Left on the proxy: ${a.leftovers.join(', ')}.`);
  return parts.join(' ');
}

export interface DecommissionPreview extends ProxyPreview { reportedCameras: string[]; connected: boolean }
// What a decommission does: the proxy unenrolls itself, then the record goes as with Delete. Refused while it reports cameras.
export function decommissionLines(p: DecommissionPreview): DeleteLines {
  const del = proxyDeleteLines(p);
  return {
    goes: ["on the proxy: its enrollment (key file, cams-admin address), its token set and the command policy cams-admin set", ...del.goes],
    stays: [...del.stays.filter((l) => l !== 'the audit log'), "on the proxy's host: its files, settings and recordings", 'the audit log'],
    blocked: p.reportedCameras.length ? `The proxy still holds ${p.reportedCameras.join(', ')}: remove ${p.reportedCameras.length > 1 ? 'them' : 'it'} first.` : del.blocked,
  };
}
export const OFFLINE_DECOMMISSION = "The proxy is not connected, so it can't unenroll itself. Delete record only, then run `admin-unenroll` on its host (docker compose exec -T cam-proxy node dist/src/cli.js admin-unenroll).";
