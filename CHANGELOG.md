# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Fix: the cams configuration revision now includes a snapshot format number, so a server-side change to the configuration (like the previous release's TLS-name fix) reaches every cams at once instead of the old one being kept as unchanged.

