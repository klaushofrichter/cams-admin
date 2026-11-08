# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Add camera: the name is optional when a proxy is chosen; an empty name becomes the name the proxy reports for that camera, else the cams id, until the camera's own name arrives (form and API agree). Without a proxy it stays required.

