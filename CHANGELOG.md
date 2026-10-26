# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- Operations tokens: a `registry` scope edits a proxy or a camera (`PATCH`, e.g. TLS site, CA pins, host, TLS name), so scripts can make the registry changes that needed a sign-in. `/diag/proxies` and `/diag/cameras` show each row's `rowVersion` for that PATCH.

### Changed

- Contract: cam-proxy's new `ftp.sourceSubnet` is on the remote-settable deny list (it widens who may log in over FTP).
- Litestream checks L0 retention once an hour instead of every 15 s (`l0-retention-check-interval: 1h`), cutting the S3 LIST requests that made up most of the backup's S3 cost. Already live in the cluster via kube-setup.

