# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed

- Backup: `lastReplicationAt` (on `/health` and the Backup page) is now the
  time of the newest Litestream object in S3, read from the bucket at
  startup and every 5 minutes. It used to follow Litestream's local sync
  counter, which kept advancing while nothing reached S3, and was empty
  after every restart.
- Backup: an idle database writes once an hour so that Litestream keeps
  uploading and a healthy backup never looks stale.

### Added

- Backup: `/health` and the Backup page report a failing S3 check and
  Litestream's sync and replica error counters, with dashboard alerts.

