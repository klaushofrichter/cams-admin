# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed
- Camera names: the camera holds its name. `cameras.*.name` is no longer remote-settable; a camera record follows the name its proxy reads from the camera (within about 30 s to a minute) and audits it as `camera-name-synced`.
- Release with cam-proxy: names follow only from a cam-proxy whose heartbeat carries `nameSource` (the release containing camera name sync); until a proxy sends it, the names of its mapped cameras stay as they are (edits are 409, nothing syncs). Release cam-proxy together with this.
- Contract v1: the health summary's camera object has an optional `nameSource` (`camera` or `config`).
- All name inputs follow the camera's rules (1 to 31 characters, ASCII letters, digits, space and `- ( ) + = [ ] { }`).
- Editing the name of a proxy-mapped camera is 409 `rename_at_camera` (the message names the rename endpoint). The rename is 409 `proxy_offline` when the proxy is not on the live channel and 409 `not_allowed_on_proxy` when it does not allow `camera.name.set`; renames are no longer queued.
- Adopt and import use the proxy camera id when the reported name breaks the rules; an unmapped camera with an invalid name is refused at the import dry run.

### Added
- Diagnostics: `GET /api/v1/diag/cameras/:cameraId` answers a camera's current name, model, proxy and online state by registry id.

