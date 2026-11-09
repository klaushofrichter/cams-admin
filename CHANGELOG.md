# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- Camera moves: a target that needs a setting changed to take the camera (today a too narrow FTP passive port range) can now propose it. cams-admin passes the proposal on to a source proxy that supports it; the source's page shows it and waits for a person to approve. The move detail in cams-admin shows the settings and the firewall note. The approved plan must carry the proposed settings, or the approval is refused.
- PoE power-cycle: when a cycle failed after PoE was cut and turned on again, cams-admin tells the camera's proxy (`poeCut`), so the proxy keeps watching the camera reboot. Needs a cam-proxy that reports this case (`cut_on_again`) and announces `power-poe-cut`.

### Fixed
- Camera moves: when cams-admin refuses a target's settings proposal for an older source proxy, the target now gets a cancel too. Before, it kept the offer and answered "busy" to other moves for about 35 minutes.

