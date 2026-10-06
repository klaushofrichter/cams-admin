# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Phase 1: the fleet registry (accounts, users with roles, proxies, cameras,
  simulated cameras), proxy enrollment with one-time codes and Ed25519 keys,
  the outbound proxy channel (WebSocket, protocol v1) with heartbeats, the
  live dashboard, the audit log, and the S3 backup (daily snapshot +
  Litestream) with a tested restore.
