import { describe, expect, it } from 'vitest';
import { summaryLeaves } from './summaryTree';

describe('summaryLeaves', () => {
  it('lists every leaf depth-first with its path and text', () => {
    expect(summaryLeaves({ ok: true, n: 1.5, s: 'x', none: null, cams: [{ id: 'cam1', items: [] }], o: {} })).toEqual([
      { path: 'ok', text: 'true' }, { path: 'n', text: '1.5' }, { path: 's', text: 'x' }, { path: 'none', text: '—' },
      { path: 'cams.0.id', text: 'cam1' }, { path: 'cams.0.items', text: '[]' }, { path: 'o', text: '{}' },
    ]);
  });
  it('skips the internal $truncated marker and stays bounded', () => {
    expect(summaryLeaves({ $truncated: true, a: 1 })).toEqual([{ path: 'a', text: '1' }]);
    const many = { a: Array.from({ length: 5000 }, (_, i) => i) };
    expect(summaryLeaves(many).length).toBe(2000);
  });
});
