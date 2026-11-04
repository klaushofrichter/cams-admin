# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Contract v1: the health summary's item ids gain `camsAdmin` (cam-proxy's "cams-admin" item: the proxy's own connection here). A connected proxy reports it as ok; a proxy that has lost the connection can't report it here at all, it shows on the proxy's Status page and display. The lenient schema already took any id; the strict one now lists it.

