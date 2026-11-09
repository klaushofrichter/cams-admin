# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Account page: a burst of changes elsewhere in the fleet (each command's progress is one) no longer reloads the page once per change. It reloads at most once a second. The per-change reloads could exceed the session's request limit, and the page then showed "Too many requests" (for example as the result of a power-cycle). The viewer token list reloads only on token or account changes.
