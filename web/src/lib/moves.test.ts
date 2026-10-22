import { describe, expect, it } from 'vitest';
import { cancelable, etaText, phaseClass, phaseText, progressText, reasonText } from './moves';

const PHASES = ['requested', 'offered', 'awaiting-approval', 'approved', 'switching', 'copying', 'cleaning', 'done', 'rejected', 'cancelling', 'cancelled', 'failed'];

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
  it('which phases offer cancel and end transfer', () => {
    for (const p of ['awaiting-approval', 'approved', 'switching', 'copying']) expect(cancelable(p), p).toBe(true);
    for (const p of ['requested', 'offered', 'cleaning', 'done', 'rejected', 'cancelling', 'cancelled', 'failed']) expect(cancelable(p), p).toBe(false);
  });
});
