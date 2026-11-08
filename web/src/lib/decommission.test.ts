import { describe, expect, it } from 'vitest';
import { archiveOffered, decommissionLines, removeAnswerText, removeLines } from './decommission';

const pre = { camera: 'cam1', clips: 12, stills: 340, archivedClips: 2, bytes: 3 * 1024 ** 3 };
const proxyPre = { cameras: 0, moves: 1, activeMoves: 0, tokens: 2, liveTokens: 2, routes: 1, keys: 1, commands: 5, switches: [] as string[] };

describe('Remove camera lines', () => {
  it('keep: content stays for retention, archive stays; nothing deleted on the proxy', () => {
    const l = removeLines(pre, 'keep', false);
    expect(l.goes.join('|')).not.toContain('now:');
    expect(l.stays).toEqual(['on the proxy: 12 clips and 340 stills (3.0 GiB in all, with the archive) until retention ages them out', 'on the proxy: 2 archived clips (outside retention)', 'the audit log']);
  });
  it('delete without archive: clips and stills go, the archive stays; with archive: all go', () => {
    expect(removeLines(pre, 'delete', false).goes).toContain('on the proxy, now: 12 clips and 340 stills');
    expect(removeLines(pre, 'delete', false).stays).toContain('on the proxy: 2 archived clips (outside retention)');
    expect(removeLines(pre, 'delete', true).goes).toContain('on the proxy, now: 12 clips and 340 stills and 2 archived clips');
    expect(removeLines(pre, 'delete', true).stays).toEqual(['the audit log']);
  });
  it('the archive checkbox only with delete and archived clips', () => {
    expect(archiveOffered(pre, 'delete')).toBe(true);
    expect(archiveOffered(pre, 'keep')).toBe(false);
    expect(archiveOffered({ ...pre, archivedClips: 0 }, 'delete')).toBe(false);
    expect(archiveOffered(null, 'delete')).toBe(false);
  });
  it("the proxy's answer in words", () => {
    expect(removeAnswerText({ removed: ['configuration', 'stored password'], leftovers: [], deleted: { clips: 0, stills: 0, archivedClips: 0 } })).toBe('Removed: configuration, stored password.');
    expect(removeAnswerText({ removed: ['configuration'], leftovers: ['camera FTP upload off (camera offline)'], deleted: { clips: 1, stills: 2, archivedClips: 3 } }))
      .toBe('Removed: configuration. Deleted 1 clip, 2 stills, 3 archived clips. Left on the proxy: camera FTP upload off (camera offline).');
  });
});

describe('Decommission lines', () => {
  it('names what goes on the proxy and in cams-admin, what stays on the host; blocked while cameras are reported', () => {
    const l = decommissionLines({ ...proxyPre, reportedCameras: [], connected: true });
    expect(l.goes[0]).toContain('its enrollment');
    expect(l.stays).toContain("on the proxy's host: its files, settings and recordings");
    expect(l.stays.at(-1)).toBe('the audit log');
    expect(l.blocked).toBeNull();
    expect(decommissionLines({ ...proxyPre, reportedCameras: ['cam1', 'e1'], connected: true }).blocked).toBe('The proxy still holds cam1, e1: remove them first.');
    expect(decommissionLines({ ...proxyPre, activeMoves: 1, reportedCameras: [], connected: true }).blocked).toContain('move is running');
  });
});
