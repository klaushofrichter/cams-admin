# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Account page: a burst of changes elsewhere in the fleet (each command's progress is one) no longer reloads the page once per change. It reloads at most once a second. The per-change reloads could exceed the session's request limit, and the page then showed "Too many requests" (for example as the result of a power-cycle). The viewer token list reloads only on token or account changes.
### Changed
- Contract (cam-proxy #364, #240; first step of a phased change, cams-admin sends nothing new yet): a switch survey or locate may answer a camera with `switch_error` and a short `detail` (the switch failed for that camera; the survey goes on with the others); `camera.power.cycled` takes an optional `poeCut` (PoE was cut and is on again although the cycle failed: the proxy keeps watching the camera come back); a proxy's power-cycle request may carry `askedAt`; a move target may accept with a `settingsProposal` (for example a wider `ftp.passive`, with a firewall note) that the source approves in `plan.targetSettings`.
- PoE switches: the Switches tab's survey line says why a camera was not found in words ("no traffic on any port", "the switch answered with an error: …") instead of the reason code.
- PoE switches: a power-cycle request from a proxy that was asked more than 5 minutes ago (the proxy no longer waits for it) is ignored and audited instead of cutting the camera's power late.
- Camera moves: a target that accepts only with a settings change (`settingsProposal`) is shown as its refusal for now, with what it needs ("the target needs ftp.passive set to 30000-30029 first; …"), until sources can approve such a change with the move.
