# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Protocol contract for migration phase 2: signed `command`, `result` and `event` messages (RFC 8785 canonical JSON, Ed25519), the `tokens.apply` command, the heartbeat's optional `commands`/`tokens`/`configRevision` fields, fixtures and vectors; the cam-proxy cross-check now also runs cam-proxy's command check.

