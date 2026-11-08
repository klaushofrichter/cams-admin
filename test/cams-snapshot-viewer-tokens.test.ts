// Viewer tokens in the cams snapshot (format 4, design 2026-11-05): only the
// valid tokens of the accounts the instance serves, by fingerprint; every
// change moves the revision; never the token or its ciphertext; a viewer's
// report of last use lands in memory, not in the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { buildSnapshot, snapshotRevision, type SnapshotDeps } from '../server/cams/snapshot';
import { viewerFingerprint } from '../server/viewerTokens/crypto';
import { tmpDir } from './helpers/tmp';
import { startServer, type Running } from './helpers/server';
import { strictCamsValidator, strictCamsErrors } from './helpers/contract';

const DAY = 86400_000;

describe('viewer tokens in the snapshot', () => {
  const dir = tmpDir();
  let s: Running;
  let d: SnapshotDeps;
  let home: { id: string }, beta: { id: string }, cluster: { id: string }, pi: { id: string };
  beforeAll(async () => {
    const keyFile = join(dir, 'viewer.key');
    writeFileSync(keyFile, randomBytes(32).toString('base64'));
    chmodSync(keyFile, 0o600);
    s = await startServer(dir, { VIEWER_TOKEN_KEY_FILE: keyFile });
    d = { db: s.built.db, clock: s.built.clock, signingKey: s.built.signing.key, signingFingerprint: s.built.signing.fingerprint };
    home = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
    beta = await s.api('POST', '/accounts', { name: 'beta', displayName: 'Beta' });
    cluster = await s.api('POST', '/cams-instances', { name: 'cluster', displayName: 'Cluster', accounts: [home.id, beta.id] });
    pi = await s.api('POST', '/cams-instances', { name: 'pi', displayName: 'Pi', accounts: [home.id] });
  });
  afterAll(() => s.stop());
  const tokensOf = (instanceId: string, accountId: string) => buildSnapshot(d, instanceId).accounts.find((a) => a.id === accountId)!.viewerTokens;

  it('a token is in every serving instance\'s snapshot, by fingerprint; strict passes; never the token or its ciphertext', async () => {
    const c = await s.api('POST', '/viewer-tokens', { name: 'Kitchen tablet', accountIds: [home.id, beta.id], days: 30 });
    const want = { id: c.item.id, name: 'Kitchen tablet', fingerprint: viewerFingerprint(c.token), expiresAt: c.item.expiresAt, role: 'viewer' };
    expect(tokensOf(cluster.id, home.id)).toEqual([want]);
    expect(tokensOf(cluster.id, beta.id)).toEqual([want]);
    expect(tokensOf(pi.id, home.id)).toEqual([want]);
    for (const i of [cluster, pi]) {
      const snap = buildSnapshot(d, i.id);
      expect(strictCamsValidator('snapshot')(snap), strictCamsErrors()).toBe(true);
      const text = JSON.stringify(snap);
      expect(text).not.toContain(c.token.slice(4));
      const secret = (s.built.db.prepare('SELECT secret FROM viewer_tokens WHERE id = ?').get(c.item.id) as { secret: string }).secret;
      expect(text).not.toContain(secret.split(':')[3].slice(0, 20));
    }
    await s.api('DELETE', `/viewer-tokens/${c.item.id}`);
  });

  it('revoke, a shorter validity, an account removed and delete each move the revision; revoked and expired tokens are left out', async () => {
    const c = await s.api('POST', '/viewer-tokens', { name: 'phone', accountIds: [home.id], days: 30 });
    let r = snapshotRevision(d.db, pi.id, d.signingFingerprint);
    const moved = (what: string) => {
      const n = snapshotRevision(d.db, pi.id, d.signingFingerprint);
      expect(n, what).not.toBe(r);
      r = n;
    };
    await s.api('POST', `/viewer-tokens/${c.item.id}/validity`, { days: 1 });
    moved('shorter validity');
    expect(tokensOf(pi.id, home.id)[0].expiresAt).toBeLessThanOrEqual(Date.now() + DAY);
    await s.api('POST', `/viewer-tokens/${c.item.id}/revoke`);
    moved('revoke');
    expect(tokensOf(pi.id, home.id)).toEqual([]);
    await s.api('POST', `/viewer-tokens/${c.item.id}/validity`, { days: 7 });
    moved('valid again');
    expect(tokensOf(pi.id, home.id).map((t) => t.id)).toEqual([c.item.id]);
    const v = (await s.api('GET', `/viewer-tokens?account=${home.id}`)).items[0].version;
    await s.api('PUT', `/viewer-tokens/${c.item.id}/accounts`, { accountIds: [beta.id], version: v });
    moved('account removed');
    expect(tokensOf(pi.id, home.id)).toEqual([]);
    expect(tokensOf(cluster.id, beta.id).map((t) => t.id)).toEqual([c.item.id]);
    const rc = snapshotRevision(d.db, cluster.id, d.signingFingerprint);
    await s.api('DELETE', `/viewer-tokens/${c.item.id}`);
    expect(snapshotRevision(d.db, cluster.id, d.signingFingerprint)).not.toBe(rc);
    expect(tokensOf(cluster.id, beta.id)).toEqual([]);
  });

  it('an expired token is left out without a new revision (cams checks expiresAt itself)', async () => {
    const c = await s.api('POST', '/viewer-tokens', { name: 'short', accountIds: [home.id], days: 1 });
    const r = snapshotRevision(d.db, pi.id, d.signingFingerprint);
    const later = { ...d, clock: { now: () => c.item.expiresAt } };
    expect(buildSnapshot(later, pi.id).accounts[0].viewerTokens).toEqual([]);
    expect(snapshotRevision(d.db, pi.id, d.signingFingerprint)).toBe(r);
    await s.api('DELETE', `/viewer-tokens/${c.item.id}`);
  });

  it('a report\'s viewerTokens set "last used" in memory and are not stored with the report', async () => {
    const c = await s.api('POST', '/viewer-tokens', { name: 'seen', accountIds: [home.id] });
    const now = s.built.clock.now();
    const base = { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] };
    s.built.camsInstances.report(pi.id, { ...base, viewerTokens: [{ id: c.item.id, lastUsedAt: now - 60_000 }] }, now);
    expect((await s.api('GET', `/viewer-tokens?account=${home.id}`)).items[0].lastUsedAt).toBe(now - 60_000);
    const stored = (s.built.db.prepare('SELECT last_report FROM cams_instances WHERE id = ?').get(pi.id) as { last_report: string }).last_report;
    expect(stored).not.toContain('viewerTokens');
    // Another use: no new database write for the report.
    const epoch = (s.built.db.prepare('SELECT write_epoch FROM meta').get() as { write_epoch: number }).write_epoch;
    s.built.camsInstances.report(pi.id, { ...base, viewerTokens: [{ id: c.item.id, lastUsedAt: now }] }, now);
    expect((s.built.db.prepare('SELECT write_epoch FROM meta').get() as { write_epoch: number }).write_epoch).toBe(epoch);
    expect((await s.api('GET', `/viewer-tokens?account=${home.id}`)).items[0].lastUsedAt).toBe(now);
    await s.api('DELETE', `/viewer-tokens/${c.item.id}`);
  });
});

describe('last used survives a restart (saved with the 10-minute status snapshot only)', () => {
  const dir = tmpDir();
  it('a report sets it in memory; the snapshot (here: the shutdown flush) saves it without a new revision; the restarted server shows it', async () => {
    const keyFile = join(dir, 'viewer.key');
    writeFileSync(keyFile, randomBytes(32).toString('base64'));
    chmodSync(keyFile, 0o600);
    let s = await startServer(dir, { VIEWER_TOKEN_KEY_FILE: keyFile });
    try {
      const home = await s.api('POST', '/accounts', { name: 'home', displayName: 'Home' });
      const pi = await s.api('POST', '/cams-instances', { name: 'pi', displayName: 'Pi', accounts: [home.id] });
      const c = await s.api('POST', '/viewer-tokens', { name: 'kept', accountIds: [home.id] });
      const fp = s.built.signing.fingerprint;
      const rev = snapshotRevision(s.built.db, pi.id, fp);
      const now = s.built.clock.now();
      const base = { v: 1, mode: 'cams-admin', version: 't', appliedRevision: null, cacheVerifiedAt: null, lastPullAt: null, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 }, problems: [] };
      s.built.camsInstances.report(pi.id, { ...base, viewerTokens: [{ id: c.item.id, lastUsedAt: now - 5000 }] }, now);
      const col = () => (s.built.db.prepare('SELECT last_used_at FROM viewer_tokens WHERE id = ?').get(c.item.id) as { last_used_at: number | null }).last_used_at;
      // Not written by the report, nor by a status flush before the 10 minutes are up.
      s.built.status.flush();
      expect(col()).toBeNull();
      // The snapshot writes it, in its own transaction, and moves no snapshot revision (no viewer pulls for it).
      const epoch = (s.built.db.prepare('SELECT write_epoch FROM meta').get() as { write_epoch: number }).write_epoch;
      s.built.status.flush(true);
      expect(col()).toBe(now - 5000);
      expect((s.built.db.prepare('SELECT write_epoch FROM meta').get() as { write_epoch: number }).write_epoch).toBe(epoch + 1);
      expect(snapshotRevision(s.built.db, pi.id, fp)).toBe(rev);
      // Nothing new: the next snapshot writes nothing for it.
      s.built.status.flush(true);
      expect((s.built.db.prepare('SELECT write_epoch FROM meta').get() as { write_epoch: number }).write_epoch).toBe(epoch + 1);
      // A newer use, saved by the shutdown flush; the restarted server reads it back.
      s.built.camsInstances.report(pi.id, { ...base, viewerTokens: [{ id: c.item.id, lastUsedAt: now }] }, now);
      s = await s.restart();
      // Read from the new process's store (a fetch could reuse the old server's closed keep-alive socket).
      expect(s.built.viewerTokens.list(home.id).items[0].lastUsedAt).toBe(now);
    } finally {
      await s.stop();
    }
  });
});
