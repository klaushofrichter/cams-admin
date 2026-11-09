# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Camera moves: a done move whose cleanup is still pending is resumed at most once every 10 seconds again (each tick used to forget when it last resumed).

