# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- **Fleet answer for cams' assistant tools:** new read-only `GET /cams/v1/accounts/:accountId/fleet` for an enrolled cams instance, limited to an account it serves: that account's proxies, viewers and moves, never another account, a token, a key or a fingerprint. Contract cams-v1 gains `fleet-response`.

