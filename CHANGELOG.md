# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Operations tokens: write-scoped bearer tokens (`cao_…`, scopes `tokens`,
  `routes`, `moves`; 1–90 days, at most 5 live) so a script can revoke proxy
  tokens, set cams routes and cancel moves without a Google sign-in. Issued on
  the Diagnostics page, listed at `/diag/ops-tokens`, documented in
  `docs/diagnostics.md`.

