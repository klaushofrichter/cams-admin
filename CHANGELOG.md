# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Changed

- Internal: the move job reads the database less often (one lookup per move
  command, prepared statements reused, one camera lookup when a move starts).
  Nothing changes in what cams-admin shows, sends or records.

