# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- A camera registered without a model now takes the model its proxy reports (once; a model you set is never overwritten). Audited as `camera-update` by the proxy.

