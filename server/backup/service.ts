import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import type { BackupService, BackupState } from '../api/router';

// Placeholder until the snapshot job lands (plan Task 12): records the run.
export function createBackup(d: { db: Db; clock: Clock; cfg: Config; audit: Audit; env: Record<string, string | undefined> }): BackupService & { start?(): void; stop?(): void } {
  return {
    state: (): BackupState => ({ lastSnapshotAt: null, lastSnapshotOk: null, lastSnapshotError: null, lastReplicationAt: null, alerts: [], configured: false }),
    async snapshotNow(actor: string) {
      d.audit.write({ actorType: 'sysadmin', actor, action: 'backup-snapshot', outcome: 'failed', detail: { error: 'not built yet' } });
      return { ok: false, error: 'not built yet' };
    },
  };
}
