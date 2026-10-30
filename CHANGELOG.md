# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- A new camera can be added to cams-admin by script: an operations token with the new scope `onboard` adopts a camera its proxy reports, the diagnostics API lists those cameras per proxy (`/diag/proxies/:proxyId/unregistered`), and a new runbook (docs/onboarding-a-camera.md) walks through adding a camera from the proxy to the viewers.

