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

describe('move events', () => {
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
