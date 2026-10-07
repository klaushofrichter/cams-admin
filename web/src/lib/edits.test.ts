import { describe, expect, it } from 'vitest';
import { keepEdits } from './edits';

describe('keepEdits: a reload never clobbers what the person is typing', () => {
  it('keeps an edited buffer while the server value is unchanged; takes the server value when it changed', () => {
    const seen = { a: { url: 'x' }, b: { url: 'y' } };
    const buf = { a: { url: 'typing…' }, b: { url: 'y' } };
    const fresh = { a: { url: 'x' }, b: { url: 'z' }, c: { url: 'new' } };
    expect(keepEdits(buf, seen, fresh)).toEqual({ a: { url: 'typing…' }, b: { url: 'z' }, c: { url: 'new' } });
  });
  it('drops entries the server no longer has; first fill takes the server values', () => {
    expect(keepEdits({ a: { url: 'q' } }, { a: { url: 'x' } }, {})).toEqual({});
    expect(keepEdits({}, {}, { a: { url: 'x' } })).toEqual({ a: { url: 'x' } });
  });
});
