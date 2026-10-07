# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- cams instances (migration phase 4): register the cluster's and the Pi's cams, the accounts each serves, per-proxy routes (a URL, or hidden for that instance), one-time `CAC1` enrollment codes, keys, *Rotate now*, *Block*, *Delete* (API; the pages follow).
- The cams service API `/cams/v1/*` (contract `contract/cams-v1/`): signed requests and answers, a signed configuration snapshot per instance with an ETag, token-hash registration and retirement for cams, status reports kept in memory.
- Import of cams's redacted `export-config` into an account (dry run, idempotent, cross-checked against the live proxies, never deletes) and an Export of a `cameras.json` for cams's file mode; `npm run import` for the local stack.
- Audit actor type `cams`; the audit log's actor filter lists it.

