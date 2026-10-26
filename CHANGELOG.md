# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed

- Moves page: deleting a refused move now asks first (Delete / Keep), naming
  the camera and the move; its audit entries stay.
- Moves page: the content list counts events and checks by their entries
  ("654 events") instead of showing them as empty; stills, clips and Archive
  still show files and size. Sizes over 1 GiB show in GiB.
- Start move: a double click no longer starts two moves. The button shows
  Starting… until the answer is in, and cams-admin refuses a second start for
  a camera whose move was just requested or is still open ("a move of cam3
  was just requested").

