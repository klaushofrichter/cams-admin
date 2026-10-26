# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed

- Litestream checks L0 retention once an hour instead of every 15 s (`l0-retention-check-interval: 1h`), cutting the S3 LIST requests that made up most of the backup's S3 cost. Already live in the cluster via kube-setup.

