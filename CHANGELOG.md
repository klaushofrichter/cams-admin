# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Fix: a cams instance that reaches its proxy over a plain-http route (cams on the proxy's own host) no longer gets the proxy's TLS name with it; cams refused that pair and kept an old configuration (seen on the mini PC).
- Diagnostics: `/api/v1/diag/tokens` lists every proxy's managed tokens with their holder and state (no hashes).

