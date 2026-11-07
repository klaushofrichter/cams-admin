# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- Operations-token scope `switches`: a script can add, test, change, move, remove and survey PoE switches, declare, verify and power-cycle (also forced) a camera's power. Audited with the token as actor (actorType `system`).
- Diagnostics reads for PoE switches: `/diag/accounts/:accountId/switches`, `/diag/switches/:switchId`, `/diag/cameras/:cameraId/power`.

