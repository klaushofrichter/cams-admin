# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- `scripts/token-check` (sysadmin's Mac): checks every credential of an account or a host for consistency and validity, read-only: cams-admin's diagnostics, operations and viewer tokens, each proxy's managed tokens against the proxy's own set, its key, signing-key pin and site CA, its local admin token, env tokens, FTP and camera passwords and PoE switch passwords against their copies on the hosts and the Mac, and each cams instance's key, pins and held tokens. One line per credential or copy (ok, mismatch, expired, expiring, unused, missing, unknown) with a reason, `--json`, and an exit code. It reads secret files only to fingerprint them, where they are; it never prints a value. See `docs/token-check.md`.

### Changed
- Internal cleanup (no change in what you see): shared helpers replace copied code. A browser tab now holds one live-update stream instead of up to three, so several open tabs no longer run into the per-session stream limit; the Proxy page loads its three parts at once; the server writes its epoch file only when something changed instead of every 10 seconds.

### Fixed
- Vision: a proxy whose cam-proxy release can't report Vision use now shows "Proxy too old" instead of looking ready, and Refresh no longer keeps sending it the request. Updating the proxy clears it.
- Move, return and Remove from proxy: a proxy that answers "not implemented" is now told apart as needing a cam-proxy update everywhere (before, the move summary and Remove showed a generic proxy failure, and a return kept retrying).
- PoE switches: deleting a camera, and an import that adds cameras or changes a camera's address, now re-check the account's switches right away (before: only at the daily check).
- Audit log: every change made with an operations token is recorded as "system" (a script), never as a signed-in admin; before, registry edits, adopt, camera delete, moves, routes and token changes made with a token showed as admin.
