# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed

- Operations tokens can be issued for up to 180 days (was 90), and both
  operations and diagnostics tokens can now be issued to never expire
  ("Never expires" on the Diagnostics page, or `days: 0`). A token valid for
  more than 90 days, or one that never expires, is shown in orange in the token
  lists, with "never" as its expiry. Existing tokens keep their expiry.

