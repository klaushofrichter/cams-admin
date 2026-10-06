# Restoring cams-admin

The backup (spec §13): Litestream replicates the SQLite file continuously to
`s3://klaushofrichter-k3s-cams-admin-backups/cams-admin/prod/litestream`
(RPO: seconds), and the app writes a daily snapshot (03:15 America/Chicago)
to `cams-admin/prod/snapshots/YYYY/MM/DD/cams-admin-<UTC>.sqlite.gz`, kept
30 days (`BACKUP_SNAPSHOT_RETENTION_DAYS`; the bucket's lifecycle rule must
match). Both are tested on every PR by `scripts/backup/restore-test.sh`.

## A fresh volume

Nothing to do: the pod's `restore` init container runs
`litestream restore -if-db-not-exists -if-replica-exists`, so a new node or a
cloud move starts from the newest replicated state. An existing database is
never overwritten.

## Point in time

1. **Stop the app:** scale the Deployment to 0. The release workflow's
   account can't; Klaus or the kube-setup session does.
2. **From Litestream** (a workstation or a one-off pod with the backup
   Secret; Litestream 0.5.17, `scripts/backup/litestream.sh` fetches it):
   ```sh
   litestream restore -config ls.yml -o /tmp/r.db [-timestamp 2026-10-06T08:00:00Z] /var/lib/cams-admin/cams-admin.db
   sqlite3 /tmp/r.db 'PRAGMA integrity_check'   # must print ok
   ```
   (`ls.yml` as in `scripts/backup/restore-drill.sh`.) Move `/tmp/r.db` into
   the volume as `cams-admin.db` and delete the old `cams-admin.db-wal` and
   `cams-admin.db-shm`.
3. **From a snapshot** (if the replica is unusable): download the newest
   `snapshots/…/*.sqlite.gz`, `gunzip` it, run the integrity check, and place
   it the same way. Litestream starts a new generation on its next start.
4. **Start the app.** At start it refuses a database newer than its code,
   and writes a `restore-detected` audit entry when the database went back
   in time (the `cams-admin.epoch` file next to it).
5. **After a restore:**
   - Proxies enrolled after the restore point fail `hello` (unknown key).
     The dashboard lists them as refused proxy ids; each needs a new
     enrollment code.
   - Sessions from before the restore may come back: **End all sessions** on
     the dashboard (`sessions-ended`).

## Managed tokens after a restore

A restore takes the token table back to the backup's time. A token revoked
after that backup is active again in cams-admin, and a set sent now would
hand it back to the proxy. So token changes stop by themselves: when a proxy
reports a token revision above cams-admin's (or answers a set as stale at
cams-admin's own revision), its Tokens card shows "the proxy is ahead — was
cams-admin restored from a backup?" and Issue, Retire and Re-apply answer
`409 proxy_ahead`. Revoke still works.

1. Compare each such proxy's Tokens card with the proxy's own audit log
   (its `admin-command` records list the token sets it applied) and revoke
   again what was revoked after the backup. A proxy admin can also block a
   token id locally on the proxy.
2. **Confirm** on the card: cams-admin sends its current set above the
   proxy's revision, and token changes work again.

## The quarterly drill

`AWS_PROFILE=<Klaus's profile> scripts/backup/restore-drill.sh` restores the
production replica into a temporary folder and prints the table counts. It
only reads from the bucket and uses Klaus's credentials, not the app's.

## Versions

Restoring an old S3 object **version** (the bucket is versioned; deletes
leave noncurrent versions for 30 days) is a manual, Klaus-only operation
with his own credentials: the app's IAM user has no version permissions.
