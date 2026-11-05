# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- `scripts/create-secrets.sh --only viewer-key` keeps an existing viewer-token key: replacing it makes every viewer token uncopyable, so only `--rotate-viewer-key` does that.
### Added

- **Viewer tokens** on an account's Users page: a token signs a person in to the cams viewers as a viewer of one or more accounts, without a Google account, for 1 day, 1 week, 30, 90 or 365 days. Copy it any time, show its sign-in QR code (for cams.skylar.technology), change its validity (longer, shorter, revoke, or valid again with the same token), add or remove accounts, or delete it. Every step is in the audit log, never the token. The viewers start accepting tokens with their next release; until then a token signs nobody in. Needs the new viewer token key on the server (see the design).

