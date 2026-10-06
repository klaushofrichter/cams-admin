# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Commands to proxies (migration phase 2): signed, one in flight per proxy, re-sent with the same id until the proxy answers, expired after 15 minutes; the proxy's signed result is kept as evidence. Each proxy page has a **Commands** card (what the proxy allows, the command history), and the dashboard shows each P2 proxy's command policy.
- Managed cams↔proxy tokens: **Issue client token** / **Issue admin token** on a proxy's page (shown once, stored only as a hash), **Retire** (1 h–7 d) and **Revoke**, **Re-apply**. A revoke is kept at once and reaches the proxy as a revocation-only set (also while the proxy is paused), shown as "not yet on proxy" until it does; a proxy that missed a set gets it again from its next heartbeat. After a restore, a proxy ahead of cams-admin blocks token changes until an admin confirms.

- Protocol contract for migration phase 2: signed `command`, `result` and `event` messages (RFC 8785 canonical JSON, Ed25519), the `tokens.apply` command, the heartbeat's optional `commands`/`tokens`/`configRevision` fields, fixtures and vectors; the cam-proxy cross-check now also runs cam-proxy's command check.

