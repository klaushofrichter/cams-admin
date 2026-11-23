# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- CI (internal): the full dependency audit no longer allows the picomatch advisory GHSA-fc5q-39xc-vjpf. GitHub withdrew it on 2026-11-18, so the allowlist is empty and every high advisory blocks again.

