# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- The dashboard shows a "long token" badge ("2 long tokens" for two) while a live
  diagnostics or operations token expires more than 90 days from now, or
  never; its tooltip names the tokens and it links to the Diagnostics page.
  The orange marking in the token lists follows the same rule (time left, not
  the validity issued), so a 180-day token is no longer orange 90 days on.

