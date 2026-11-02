# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Contract v1: the health summary's item ids gain `moveSync` (cam-proxy's "Move check": the check of a moved camera against its SD card). The lenient schema already took any id; the strict one now lists it.

