# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed

- A camera move needs a site CA only on the target proxy; a source without one (the Raspberry Pi proxy) is allowed, and `site_ca` no longer fixes or names the source.
