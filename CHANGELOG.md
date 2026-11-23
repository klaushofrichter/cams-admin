# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed
- Internal cleanup, no visible change: requests made with a diagnostics or operations token, audit entries and a proxy's move events do less database work, and a cams instance page loads its proxies, cameras and overrides at the same time.
