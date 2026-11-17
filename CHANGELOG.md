# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- CI (internal): the dependency audit is now two blocking steps. What ships (the production dependencies) has no exceptions. The full audit, development tools included, allows one advisory: picomatch GHSA-fc5q-39xc-vjpf (a slow pattern match, high), which reaches cams-admin only through the build and test tools (vite, vitest) and has no fixed release yet; Klaus approved it on 2026-11-17. The check fails again once a picomatch release or a fix appears, so the exception gets removed.
