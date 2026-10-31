import { describe, expect, it } from 'vitest';
import { cancelable, etaText, phaseClass, phaseText, progressText, reasonText, boundsText, startBody, refusalText, cameraLabel, activeMoves, activeLine, checkText, endLabel, canGiveUp, phaseReason, refusedByText, refusalLine, contentLine, contentBasisText, canDelete, presummaryLines, presummarySpaceText, presummaryErrorText } from './moves';

const PHASES = ['requested', 'offered', 'awaiting-approval', 'approved', 'switching', 'copying', 'cleaning', 'done', 'rejected', 'cancelling', 'cancelled', 'failed', 'returning', 'returned'];

describe('moves (UI text)', () => {
  it('phaseText covers every phase', () => {
    const seen = new Set<string>();
    for (const p of PHASES) {
      const t = phaseText(p);
      expect(t, p).toBeTruthy();
      expect(t, p).not.toBe(p === 'done' ? 'x' : '');
      seen.add(t);
    }
    expect(seen.size).toBe(PHASES.length);
    expect(phaseText('awaiting-approval')).toBe('waiting for approval');
    expect(phaseText('copying')).toBe('copying');
    expect(phaseText('weird')).toBe('weird');
  });
  it('phase classes', () => {
    expect(phaseClass('done')).toBe('ok');
    expect(phaseClass('failed')).toBe('bad');
    expect(phaseClass('rejected')).toBe('bad');
    expect(phaseClass('cancelled')).toBe('warn');
    expect(phaseClass('copying')).toBe('');
  });
  it('progressText shows bytes and percent', () => {
    expect(progressText({ bytesDone: 512, bytesTotal: 1024 })).toBe('512 B of 1.0 KiB (50%)');
    expect(progressText({ bytesDone: 0, bytesTotal: 0 })).toBe('nothing to copy');
    expect(progressText({ bytesDone: null, bytesTotal: null })).toBe('');
    expect(progressText({ bytesDone: 5, bytesTotal: null })).toBe('5 B');
    expect(progressText({ bytesDone: 2000, bytesTotal: 1000 })).toBe('2.0 KiB of 1000 B (100%)');
  });
  it('etaText', () => {
    expect(etaText(null)).toBe('');
    expect(etaText(12)).toBe('about 12 s left');
    expect(etaText(150)).toBe('about 3 min left');
    expect(etaText(7300)).toBe('about 2 h left');
  });
  it('reasons in plain words, else the code', () => {
    expect(reasonText('busy')).not.toBe('target_declined');
    expect(reasonText('some_code')).toBe('some_code');
    expect(reasonText('kind_not_accepted')).toBe('the approved plan has a kind the target did not accept');
    expect(reasonText(null)).toBe('');
  });
  it('reasons cams-admin itself answers and fails with', () => {
    expect(reasonText('not_registered')).toBe('the camera is not in the registry');
    expect(reasonText('internal')).toBe('an internal error');
    expect(reasonText('token_lost')).toBe('cams-admin restarted before the offer went out');
  });
  it('failure codes: the step in words, then the code in words (or the code)', () => {
    expect(reasonText('start:camera_unreachable')).toBe("the target could not start: the target cannot reach the camera");
    expect(reasonText('source:token_address')).toBe('the source failed: token_address');
    expect(reasonText('target:disk_full')).toBe('the target failed: disk_full');
    expect(reasonText('release:unknown')).toBe('the source could not release the camera: no answer');
    expect(reasonText('go:expired')).toBe('the source could not hand the camera over: not delivered in time');
    expect(reasonText('open:busy')).toBe('the source could not open the move: a proxy is busy with another move');
    expect(reasonText('offer:not_enrolled')).toBe('the offer could not be sent: not_enrolled');
    expect(reasonText('switch:registry_incomplete')).toBe('the switch-over failed: registry_incomplete');
    expect(reasonText('nostep:x')).toBe('nostep:x');
  });
  it('which phases offer cancel and end transfer', () => {
    for (const p of ['awaiting-approval', 'approved', 'switching', 'copying']) expect(cancelable(p), p).toBe(true);
    for (const p of ['requested', 'offered', 'cleaning', 'done', 'rejected', 'cancelling', 'cancelled', 'failed']) expect(cancelable(p), p).toBe(false);
  });
});

describe('boundsText', () => {
  it('says what the request was approved within', () => {
    expect(boundsText(null)).toBe('Approval on the source proxy');
    expect(boundsText({ transfer: true, kinds: ['clips', 'stills'], space: 'fit', maxBudgetS: 3600 })).toBe('Auto-approved within: clips, stills; space fit; at most 60 min');
    expect(boundsText({ transfer: false, kinds: [], space: 'all', maxBudgetS: 90 })).toBe('Auto-approved within: no content; at most 2 min');
    expect(boundsText({ transfer: true, kinds: ['clips', 'ptz'], space: 'fit', maxBudgetS: 3600 })).toBe('Auto-approved within: clips, PTZ positions; space fit; at most 60 min');
  });
});

describe('startBody and refusalText', () => {
  it('startBody carries the default bounds', () => {
    expect(startBody('prx_a', 'prx_b', 'porch')).toEqual({
      sourceProxyId: 'prx_a', targetProxyId: 'prx_b', cameraId: 'porch',
      bounds: { transfer: true, kinds: ['clips', 'stills', 'events', 'checks', 'archive'], space: 'fit', maxBudgetS: 86400 },
    });
  });
  it('refusalText joins the failed precheck rules', () => {
    const report = { ok: false, reason: 'target_offline', rules: [
      { rule: 'online', ok: false, reason: 'target_offline', detail: 'target offline' },
      { rule: 'x', ok: true, reason: 'busy' },
      { rule: 'busy', ok: false, reason: 'busy' },
    ] };
    expect(refusalText({ error: 'precheck', report })).toBe('target offline; a proxy is busy with another move');
  });
  it('refusalText falls back to the error code in words', () => {
    expect(refusalText({ error: 'busy' })).toBe('a proxy is busy with another move');
    expect(refusalText({ error: 'source_offline' })).toBeTruthy();
    expect(refusalText({ error: 'zzz_unknown' })).toBe('zzz_unknown');
    expect(refusalText(null)).toBeTruthy();
  });
  it('a second start of the same camera: the server\'s detail, else the code in words', () => {
    expect(refusalText({ error: 'move_pending', detail: 'a move of cam3 was just requested' })).toBe('a move of cam3 was just requested');
    expect(refusalText({ error: 'move_pending' })).toBe('a move of this camera was just requested or is under way');
  });
});

describe('cameraLabel (Start move camera list)', () => {
  it('name, then the alias and the address', () => {
    expect(cameraLabel({ name: 'Backyard', camsId: 'cam4', proxyCameraId: 'cam4', host: '192.0.2.85' })).toBe('Backyard (cam4, 192.0.2.85)');
  });
  it('the proxy\'s own id when it differs from the alias', () => {
    expect(cameraLabel({ name: 'Gate', camsId: 'gate', proxyCameraId: 'cam1', host: null })).toBe('Gate (gate, cam1)');
  });
  it('no address for a camera reached through its proxy', () => {
    expect(cameraLabel({ name: 'Gate', camsId: 'cam1', proxyCameraId: 'cam1', host: 'from-proxy' })).toBe('Gate (cam1)');
  });
  it('the alias alone when there is no name', () => {
    expect(cameraLabel({ name: '', camsId: 'cam2', proxyCameraId: null, host: null })).toBe('cam2');
  });
});

describe('active moves (menu and Dashboard)', () => {
  const m = (o: Record<string, unknown> = {}) => ({ id: 'mv_1', camsId: 'cam4', cameraName: 'Backyard', source: { name: 'Mini PC' }, target: { name: 'een' }, phase: 'copying', bytesDone: 25, bytesTotal: 100, endedAt: null, ...o });
  it('activeMoves keeps the moves that have not ended', () => {
    expect(activeMoves([m(), m({ id: 'mv_2', phase: 'done', endedAt: 5 }), m({ id: 'mv_3', phase: 'switching' })]).map((x) => x.id)).toEqual(['mv_1', 'mv_3']);
    expect(activeMoves(undefined)).toEqual([]);
  });
  it('activeLine: camera, route, phase and progress', () => {
    expect(activeLine(m())).toBe('Backyard: Mini PC → een, copying 25%');
  });
  it('activeLine: no percent outside the copy', () => {
    expect(activeLine(m({ phase: 'switching', bytesTotal: null }))).toBe(`Backyard: Mini PC → een, ${phaseText('switching')}`);
  });
  it('activeLine: the alias when there is no name', () => {
    expect(activeLine(m({ cameraName: '' }))).toMatch(/^cam4: /);
  });
  it('a copy back is active and phrased as copying back', () => {
    expect(activeMoves([m({ phase: 'returning' }), m({ id: 'mv_2', phase: 'returned', endedAt: 5 })]).map((x) => x.id)).toEqual(['mv_1']);
    expect(activeLine(m({ phase: 'returning' }))).toBe('Backyard: Mini PC → een, copying back 25%');
  });
});

describe('copy back, check, End after Archive', () => {
  it('phases and reasons of a copy back', () => {
    expect(phaseText('returning')).toBe('copying back');
    expect(phaseText('returned')).toBe('copied back');
    expect(reasonText('given_up')).toBe('copy back given up');
    expect(reasonText('paused:no_space')).toBe('paused: no room on the original proxy');
    expect(phaseClass('returning')).toBe('warn');
    expect(phaseClass('returned')).toBe('');
    expect(reasonText('paused:proxy_update:source')).toBe('waiting: the new proxy needs the cam-proxy update');
    expect(reasonText('paused:proxy_update:target')).toBe('waiting: the original proxy needs the cam-proxy update');
  });
  it('a given-up copy back reads "copy back given up" only', () => {
    expect(phaseText('returned', 'given_up')).toBe('copy back given up');
    expect(phaseReason('returned', 'given_up')).toBe('');
    expect(phaseText('returned', null)).toBe('copied back');
    expect(phaseReason('returning', 'paused:no_space')).toBe('paused: no room on the original proxy');
    expect(phaseReason('failed', null)).toBe('');
  });
  it('checkText: complete, or the counts per kind', () => {
    expect(checkText(null)).toBe('');
    expect(checkText({ complete: true, missing: {}, recovered: { stills: 1 }, failed: {}, expired: {} })).toBe('Complete');
    expect(checkText({ complete: false, missing: { stills: 2 }, recovered: {}, failed: { archive: 1 }, expired: { clips: 3 } })).toBe('2 stills missing, 1 Archive failed, 3 clips expired');
    expect(checkText({ complete: false, missing: {}, recovered: {}, failed: {}, expired: {} })).toBe('Incomplete');
    expect(checkText({ complete: false, missing: { clips: 0, events: 4 }, recovered: {}, failed: {}, expired: {} })).toBe('4 events missing');
  });
  it('endLabel: plain, waiting for Archive, ending after Archive', () => {
    expect(endLabel({ archivePending: false, endRequested: false })).toBe('End transfer…');
    expect(endLabel({ archivePending: true, endRequested: false })).toBe('End after Archive…');
    expect(endLabel({ archivePending: true, endRequested: true })).toBe('Ending after Archive');
    expect(endLabel({ archivePending: false, endRequested: true })).toBe('Ending after Archive');
  });
  it('only a copy back can be given up; it is not cancelable', () => {
    expect(canGiveUp('returning')).toBe(true);
    for (const p of ['returned', 'copying', 'cancelled', 'done']) expect(canGiveUp(p), p).toBe(false);
    expect(cancelable('returning')).toBe(false);
  });
});

describe('rejections and the content checklist', () => {
  const tgt = { target: { name: 'Pi' } };
  it('who refused: the target by name, or cams-admin; nothing for a move that was not rejected', () => {
    expect(refusedByText({ ...tgt, phase: 'rejected', refusedBy: 'target' })).toBe('Pi refused');
    expect(refusedByText({ ...tgt, phase: 'rejected', refusedBy: 'cams-admin' })).toBe('cams-admin refused');
    expect(refusedByText({ ...tgt, phase: 'failed', refusedBy: null })).toBe('');
    // An older server's view without refusedBy: the reason only.
    expect(refusedByText({ ...tgt, phase: 'rejected' })).toBe('');
  });
  it('the row line: who refused and the reason in plain words', () => {
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'target', reason: 'incompatible' })).toBe("Pi refused: its configuration can't take this camera");
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'cams-admin', reason: 'incompatible' })).toBe("cams-admin refused: the source's camera address or protocol differs from the registry");
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'cams-admin', reason: 'busy' })).toBe('cams-admin refused: a proxy is busy with another move');
    // camera_limit: the target's own refusal, and cams-admin's from the target's reported profile (precheck capacity, ftp_ports).
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'target', reason: 'camera_limit' })).toBe('Pi refused: the target has no room for another camera');
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'cams-admin', reason: 'camera_limit' })).toBe("cams-admin refused: the target's profile has no room for another camera (cameras or FTP ports)");
    expect(refusalText({ error: 'precheck', reason: 'camera_limit', report: { rules: [{ rule: 'capacity', ok: false, reason: 'camera_limit', detail: 'een holds 3 of 3 cameras' }] } })).toBe('een holds 3 of 3 cameras');
    expect(refusalLine({ ...tgt, phase: 'rejected', refusedBy: 'target', reason: 'camera_unreachable' })).toBe('Pi refused: the target cannot reach the camera');
    expect(refusalLine({ ...tgt, phase: 'rejected', reason: 'incompatible' })).toBe("its configuration can't take this camera");
    expect(reasonText('incompatible')).not.toContain('not compatible');
  });
  it('only a rejected move can be deleted', () => {
    expect(canDelete('rejected')).toBe(true);
    for (const p of PHASES.filter((x) => x !== 'rejected')) expect(canDelete(p), p).toBe(false);
  });
  it('a content line: included or left out, the size, the copy progress', () => {
    const chunks = (total: number, done: number, failed = 0, abandoned = 0) => ({ total, done, failed, abandoned });
    expect(contentLine({ kind: 'clips', included: true, files: 12, bytes: 3072, chunks: chunks(3, 1, 1) })).toBe('Clips: included, 12 files, 3.0 KiB; 1 of 3 days copied, 1 with failures');
    expect(contentLine({ kind: 'stills', included: false, files: 5, bytes: 500, chunks: chunks(0, 0) })).toBe('Stills: left out, 5 files, 500 B');
    expect(contentLine({ kind: 'archive', included: true, files: 1, bytes: null, chunks: chunks(2, 2) })).toBe('Archive: included, 1 file; 2 of 2 days copied');
    expect(contentLine({ kind: 'checks', included: null, files: null, bytes: null, chunks: chunks(0, 0) })).toBe('Checks: not decided yet');
    expect(contentLine({ kind: 'events', included: true, files: 0, bytes: 0, rows: 0, chunks: chunks(4, 1, 0, 3) })).toBe('Events: included, nothing to copy; 1 of 4 days copied, 3 left behind');
  });
  it('events and checks are counted by rows, stills, clips and Archive by files and bytes', () => {
    const none = { total: 0, done: 0, failed: 0, abandoned: 0 };
    expect(contentLine({ kind: 'events', included: true, files: 0, bytes: 0, rows: 654, chunks: none })).toBe('Events: included, 654 events');
    expect(contentLine({ kind: 'checks', included: false, files: 0, bytes: 0, rows: 1, chunks: none })).toBe('Checks: left out, 1 check');
    expect(contentLine({ kind: 'checks', included: true, files: null, bytes: null, rows: null, chunks: none })).toBe('Checks: included');
    expect(contentLine({ kind: 'stills', included: true, files: 54556, bytes: 48350227367, rows: 0, chunks: none })).toBe('Stills: included, 54556 files, 45.0 GiB');
    expect(contentLine({ kind: 'clips', included: true, files: 236, bytes: 290655300, rows: 142, chunks: none })).toBe('Clips: included, 236 files, 277.2 MiB');
    expect(contentLine({ kind: 'archive', included: true, files: 0, bytes: 0, rows: 0, chunks: none })).toBe('Archive: included, nothing to copy');
  });
  it('the basis of the checklist', () => {
    expect(contentBasisText('plan')).toBe('As approved');
    expect(contentBasisText('bounds')).toBe('Within the pre-approval bounds');
    expect(contentBasisText(null)).toBe('Not approved yet: sizes as the source reported them');
  });
});


describe('PTZ positions', () => {
  it('kindLine for ptz reads "PTZ positions: included"', () => {
    const k = { kind: 'ptz', included: true, files: null, bytes: null, rows: null, chunks: { total: 0, done: 0, failed: 0, abandoned: 0 } };
    expect(contentLine(k)).toBe('PTZ positions: included');
    expect(contentLine({ ...k, included: false })).toBe('PTZ positions: left out');
  });
  it('the presummary keeps the five file kinds', () => {
    const one = { files: 1, bytes: 1, rows: 1, oldest: null, newest: null };
    expect(presummaryLines({ clips: one, ptz: one }).map((l) => l.kind)).toEqual(['clips']);
  });
});

describe('the content before a move (Start move form, move.summary)', () => {
  const k = (files: number, bytes: number, rows: number) => ({ files, bytes, rows, oldest: null, newest: null });
  it('one line per kind in the checklist order, files and bytes for stills, clips and Archive, rows for events and checks', () => {
    expect(presummaryLines({ clips: k(12, 3072, 14), stills: k(54556, 48350227367, 0), events: k(0, 0, 654), checks: k(0, 0, 1), archive: k(0, 0, 0) })).toEqual([
      { kind: 'stills', text: 'Stills: 54556 files, 45.0 GiB' },
      { kind: 'clips', text: 'Clips: 12 files, 3.0 KiB' },
      { kind: 'events', text: 'Events: 654 events' },
      { kind: 'checks', text: 'Checks: 1 check' },
      { kind: 'archive', text: 'Archive: nothing to copy' },
    ]);
    // A kind the proxy left out is not shown; an unknown one is ignored.
    expect(presummaryLines({ clips: k(1, 10, 0), extra: k(1, 1, 1) } as never)).toEqual([{ kind: 'clips', text: 'Clips: 1 file, 10 B' }]);
    expect(presummaryLines({ events: k(0, 0, 0) })).toEqual([{ kind: 'events', text: 'Events: nothing to copy' }]);
  });
  it("the target's free budget and whether it fits; why it is unknown otherwise", () => {
    const space = { at: 1, needBytes: 2_000_000_000, budgetBytes: 600_000_000_000, usedBytes: 41_000_000_000, leftBytes: 559_000_000_000, fits: true, overCaps: [] };
    expect(presummarySpaceText({ name: 'een', profile: true }, space)).toBe('The move needs 2.0 GB; een has 559 GB of its 600 GB budget left (41 GB used). It fits.');
    expect(presummarySpaceText({ name: 'een', profile: true }, { ...space, leftBytes: 1_000_000_000, fits: false })).toBe('The move needs 2.0 GB; een has 1.0 GB of its 600 GB budget left (41 GB used). It does not all fit.');
    expect(presummarySpaceText({ name: 'een', profile: true }, { ...space, fits: false, overCaps: [{ kind: 'stills', bytes: 2_000_000_000, capBytes: 1_000_000_000 }] }))
      .toBe('The move needs 2.0 GB; een has 559 GB of its 600 GB budget left (41 GB used). Stills 2.0 GB is over its 1.0 GB cap. It does not all fit.');
    expect(presummarySpaceText({ name: 'Old proxy', profile: false }, null)).toBe('Old proxy: no profile reported (needs cam-proxy 2026.10.26 or later); its free budget is unknown.');
    expect(presummarySpaceText({ name: 'een', profile: true }, null)).toBe('een reports no storage budget: whether it fits is unknown.');
    expect(presummarySpaceText(null, null)).toBe('');
  });
  it('why the content is not available, in words', () => {
    expect(presummaryErrorText({ error: 'proxy_update_needed', detail: 'the proxy needs cam-proxy 2026.10.26 or later' })).toBe('the proxy needs cam-proxy 2026.10.26 or later');
    expect(presummaryErrorText({ error: 'proxy_update_needed' })).toBe('the proxy needs cam-proxy 2026.10.26 or later');
    expect(presummaryErrorText({ error: 'source_offline' })).toBe('the source proxy is offline');
    expect(presummaryErrorText({ error: 'timeout' })).toBe('the source proxy did not answer in time');
    expect(presummaryErrorText({ error: 'not_allowed_on_proxy' })).toBe('the source proxy does not allow camera moves (move.send)');
    expect(presummaryErrorText({ error: 'unknown_camera' })).toBe('the source proxy does not know this camera');
    expect(presummaryErrorText({ error: 'proxy_failed', detail: 'internal' })).toBe('the source proxy failed: internal');
    expect(presummaryErrorText({ error: 'something_new' })).toBe('something_new');
    expect(presummaryErrorText(null)).toBe('no answer');
  });
});
