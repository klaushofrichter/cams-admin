# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed

- A camera move from a plain-http source without a TLS name (the Raspberry Pi proxy) is no longer refused as `source_registry_incomplete`: the offer names the source's url host instead.

