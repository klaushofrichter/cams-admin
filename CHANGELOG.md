# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- Contract v1 (additive): the health summary's camera may carry `sd` (the camera's SD card and recording settings: mounted, formatted, capacity and free MB, overwrite, recording on, when read, the newest SD recording, stalled; null before the first read), items may have the id `sd` and `warning: true` (needs a look, not a problem; never counted in `problemCount`). For cam-proxy #199; fixture `valid-heartbeat-1cam-sd`.

