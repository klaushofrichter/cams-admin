import { describe, expect, it } from 'vitest';
import { cancelable, etaText, phaseClass, phaseText, progressText, reasonText, boundsText, startBody, refusalText, cameraLabel, activeMoves, activeLine, checkText, endLabel, canGiveUp } from './moves';

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
