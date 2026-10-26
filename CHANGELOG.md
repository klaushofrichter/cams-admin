# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- Start move shows what the camera holds before the move starts: stills, clips
  and Archive by files and size, events and checks by rows, as the source proxy
  reports them now, and the target's free storage budget with whether it fits.
  It needs cam-proxy 2026.10.26 or later on the source; with an older one the
  form says so in a muted line and still works.
- A move is refused when the target's site CA does not cover the camera's
  address ("een's site CA covers 192.0.2.80/29, not 192.0.2.90"), for targets
  that report their camera subnet (cam-proxy 2026.10.26 or later).
- Contract: the `move.summary` command (read only, entry `move.send`) and the
  heartbeat profile's optional `tls {site, cameraSubnet}`.

