# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- `scripts/token-check` (sysadmin's Mac): checks every credential of an account or a host for consistency and validity, read-only: cams-admin's diagnostics, operations and viewer tokens, each proxy's managed tokens against the proxy's own set, its key, signing-key pin and site CA, its local admin token, env tokens, FTP and camera passwords and PoE switch passwords against their copies on the hosts and the Mac, and each cams instance's key, pins and held tokens. One line per credential or copy (ok, mismatch, expired, expiring, unused, missing, unknown) with a reason, `--json`, and an exit code. It reads secret files only to fingerprint them, where they are; it never prints a value. See `docs/token-check.md`.

### Changed
- Internal cleanup (no change in what you see): shared helpers replace copied code. A browser tab now holds one live-update stream instead of up to three, so several open tabs no longer run into the per-session stream limit; the Proxy page loads its three parts at once; the server writes its epoch file only when something changed instead of every 10 seconds.
