// The proxy -> cams-admin events of the v1 contract: command.done (unchanged)
// and the camera-move kinds, which carry no cmdId.
import { describe, expect, it } from 'vitest';
import { fixtureList, fixtureNamed, strictErrors, strictValid } from './helpers/contractV1';
import { validateMessage } from '../server/contract';

const MV = 'mv_0123456789ABCDEFGHJK';
const KINDS = ['targets', 'request', 'approve', 'cancel', 'phase', 'progress'];
const base = () => fixtureNamed('valid-event-command-done').message;
// A move event body in the envelope of the signed command.done fixture (the signature is not checked by the schema).
const wrap = (body: Record<string, unknown>) => ({ ...base(), body: { proxyId: base().body.proxyId, connId: base().body.connId, ...body } });
const progress = (chunks: unknown) => wrap({ kind: 'move.progress', moveId: MV, chunks, bytesDone: 0, bytesTotal: 1, rateBps: 0, etaS: 0 });

const phase = (o: Record<string, unknown>) => wrap({ kind: 'move.phase', moveId: MV, role: 'target', ok: true, ...o });
describe('move events', () => {
  it('move.phase carries check, keepDays and returnPending', () => {
    const none = { complete: false, missing: { stills: 2 }, recovered: {}, failed: { archive: 1 }, expired: {} };
    expect(strictValid('event', phase({ phase: 'copied', check: none }))).toBe(true);
    expect(strictValid('event', phase({ phase: 'finished', keepDays: 30 }))).toBe(true);
    expect(strictValid('event', phase({ phase: 'finished', keepDays: 3650 }))).toBe(true);
    expect(strictValid('event', phase({ phase: 'finished', keepDays: 3 }))).toBe(false);
    expect(strictValid('event', phase({ phase: 'finished', keepDays: 3651 }))).toBe(false);
    expect(strictValid('event', phase({ phase: 'cancelled', returnPending: true }))).toBe(true);
    expect(strictValid('event', phase({ phase: 'copied', check: { complete: true } }))).toBe(false); // all five keys required
    expect(strictValid('event', phase({ phase: 'copied', check: { ...none, missing: { photos: 1 } } }))).toBe(false);
  });
  it('has the new move.phase and return fixtures', () => {
    const names = fixtureList().map((f) => f.name);
    for (const n of ['valid-event-move-phase-check', 'valid-event-move-phase-return-pending', 'invalid-event-move-phase-keepdays-low']) expect(names, n).toContain(n);
    expect(strictValid('event', fixtureNamed('invalid-event-move-phase-keepdays-low').message)).toBe(false);
  });
  it('has a valid fixture for every move event kind', () => {
    const names = fixtureList().map((f) => f.name);
    for (const k of KINDS) expect(names, k).toContain(`valid-event-move-${k}`);
  });
  it('accepts every move event kind without cmdId (strict and run time)', () => {
    for (const f of fixtureList().filter((x) => x.name.startsWith('valid-event-move-'))) {
      expect(f.message.body.cmdId, f.name).toBeUndefined();
      expect(strictValid('event', f.message), `${f.name} ${strictErrors()}`).toBe(true);
      expect(validateMessage(f.message), f.name).toMatchObject({ ok: true });
    }
  });
  it('refuses a move.progress chunk id that is not <kind>:<date>', () => {
    expect(strictValid('event', progress([{ id: 'clips:2026-10-21', state: 'copied' }]))).toBe(true);
    expect(strictValid('event', progress([{ id: 'clips', state: 'copied' }]))).toBe(false);
    expect(strictValid('event', progress([{ id: 'clips:2026-10-2', state: 'copied' }]))).toBe(false);
    expect(strictValid('event', progress([{ id: 'photos:2026-10-21', state: 'copied' }]))).toBe(false);
    const f = fixtureNamed('invalid-event-move-progress-bad-chunk');
    expect(strictValid('event', f.message)).toBe(false);
    expect(validateMessage(f.message)).toMatchObject({ ok: false, code: 'bad_message' });
  });
  it('chunk state failed means copied with failures; unknown states are refused', () => {
    for (const state of ['pending', 'copied', 'verified', 'skipped', 'failed']) expect(strictValid('event', progress([{ id: 'stills:2026-10-21', state }])), state).toBe(true);
    expect(strictValid('event', progress([{ id: 'stills:2026-10-21', state: 'done' }]))).toBe(false);
  });
  it('move.phase: closed phase list, failed carries a code', () => {
    const phase = (p: string, extra: object = {}) => wrap({ kind: 'move.phase', moveId: MV, role: 'target', phase: p, ok: false, ...extra });
    for (const p of ['opened', 'switching', 'switched', 'released', 'copying', 'copied', 'finished', 'cancelled']) expect(strictValid('event', phase(p)), p).toBe(true);
    expect(strictValid('event', phase('failed', { code: 'token_address', detail: 'x' }))).toBe(true);
    // failed without a code is invalid, strict and at run time
    expect(strictValid('event', phase('failed'))).toBe(false);
    expect(validateMessage(phase('failed'))).toMatchObject({ ok: false, code: 'bad_message' });
    expect(validateMessage(phase('failed', { code: 'token_address' }))).toMatchObject({ ok: true });
    expect(strictValid('event', phase('exploded'))).toBe(false);
    expect(strictValid('event', phase('failed', { role: 'both' }))).toBe(false);
  });
  it('move.request names the camera by its proxy camera id and the target by prx_ id, never a password', () => {
    const m = fixtureNamed('valid-event-move-request').message;
    expect(m.body.camera.proxyCameraId).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(m.body.target).toMatch(/^prx_/);
    expect(m.body.actor).toEqual({ origin: expect.stringMatching(/^(local|managed)$/), label: expect.any(String) });
    expect(JSON.stringify(m)).not.toMatch(/password/i);
    const bad = structuredClone(m);
    bad.body.camera.password = 'x';
    expect(strictValid('event', bad)).toBe(false);
    const noActor = structuredClone(m);
    delete noActor.body.actor;
    expect(strictValid('event', noActor)).toBe(false);
    const badTarget = structuredClone(m);
    badTarget.body.target = 'proxy-b';
    expect(strictValid('event', badTarget)).toBe(false);
  });
  it('move.request with bounds, with bounds null and without bounds are valid (strict)', () => {
    const base = fixtureNamed('valid-event-move-request').message;
    expect(base.body.bounds).toBeUndefined();
    expect(strictValid('event', base)).toBe(true);
    const withB = fixtureNamed('valid-event-move-request-bounds').message;
    expect(withB.body.bounds).toEqual({ transfer: true, kinds: ['clips', 'events'], space: 'fit', maxBudgetS: 3600 });
    expect(strictValid('event', withB)).toBe(true);
    const nul = structuredClone(withB);
    nul.body.bounds = null;
    expect(strictValid('event', nul)).toBe(true);
  });
  it('move.request with bounds outside the closed object is invalid', () => {
    const m = fixtureNamed('valid-event-move-request-bounds').message;
    for (const bad of [{ ...m.body.bounds, maxBudgetS: 0 }, { ...m.body.bounds, maxBudgetS: 604801 }, { ...m.body.bounds, extra: 1 }, { ...m.body.bounds, space: 'some' }, { transfer: true }]) {
      const b = structuredClone(m);
      b.body.bounds = bad;
      expect(strictValid('event', b)).toBe(false);
    }
  });
  it('move.request and move.approve: settings leaves are all optional, no nulls, no extra fields', () => {
    const m = fixtureNamed('valid-event-move-request').message;
    for (const settings of [{}, { name: 'Front door' }, { ftp: { stream: 'sub' } }, { events: { poll: { enabled: true } } }]) {
      const c = structuredClone(m);
      c.body.settings = settings;
      expect(strictValid('event', c), JSON.stringify(settings)).toBe(true);
    }
    for (const settings of [{ name: null }, { ftp: { enabled: null } }, { newThing: 1 }, { stills: { enabled: true, color: 'red' } }, { analytics: { kinds: { person: 'yes' } } }]) {
      const c = structuredClone(m);
      c.body.settings = settings;
      expect(strictValid('event', c), JSON.stringify(settings)).toBe(false);
    }
  });
  it('move.request summary has all five kinds, times nullable', () => {
    const m = fixtureNamed('valid-event-move-request').message;
    const c = structuredClone(m);
    delete c.body.summary.archive;
    expect(strictValid('event', c)).toBe(false);
    const d = structuredClone(m);
    d.body.summary.clips = { files: 0, bytes: 0, rows: 0, oldest: null, newest: null };
    expect(strictValid('event', d)).toBe(true);
  });
  it('move.cancel (event) names the choice for copied content; the move id pattern is closed', () => {
    const c = (o: object) => wrap({ kind: 'move.cancel', moveId: MV, copied: 'delete', ...o });
    expect(strictValid('event', c({}))).toBe(true);
    expect(strictValid('event', c({ copied: 'age-out' }))).toBe(true);
    expect(strictValid('event', c({ copied: 'keep' }))).toBe(false);
    expect(strictValid('event', c({ moveId: 'mv_0123456789ABCDEFGHJI' }))).toBe(false);
  });
  it('still requires cmdId, phase and status for command.done', () => {
    const ok = fixtureNamed('valid-event-command-done').message;
    expect(strictValid('event', ok)).toBe(true);
    expect(validateMessage(ok)).toMatchObject({ ok: true });
    for (const key of ['cmdId', 'phase', 'status']) {
      const m = structuredClone(ok);
      delete m.body[key];
      expect(strictValid('event', m), key).toBe(false);
      expect(validateMessage(m), key).toMatchObject({ ok: false, code: 'bad_message' });
    }
  });
  it('an unknown event kind is refused in strict', () => {
    expect(strictValid('event', wrap({ kind: 'move.explode' }))).toBe(false);
  });
});
