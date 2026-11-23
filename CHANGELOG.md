# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed
- Internal cleanup, no visible change: requests made with a diagnostics or operations token, audit entries, a proxy's move events, a cams viewer's fleet and config requests and the registry's lookups do less database work; a cams instance page and the Viewer tokens tab load their lists at the same time.
