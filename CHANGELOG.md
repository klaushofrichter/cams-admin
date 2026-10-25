# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- A refused camera move now says who refused it (the target proxy by name, or
  cams-admin), the reason in plain words, and the detail of the refusal (for
  example "registry host 192.0.2.10, source reports 192.0.2.11"). The detail is
  also passed on to the source proxy.
- Moves that cams-admin itself refuses (the camera's address or protocol
  differs from the registry, a proxy is busy, a precheck rule fails) now show
  on the Moves page too, not only in the audit log.
- A refused move has a Delete button (no confirm: it holds no content). Scripts
  can use `DELETE /api/v1/moves/:moveId` with an operations token (scope
  `moves`).
- An opened move shows a checklist of its content (clips, stills, events,
  checks, archive): included or left out, its size, and how far it is copied.

### Changed

- The menu entry for cams instances reads "Cams", like the other menu entries.

### Fixed

- The Moves page shows a rejected move at once; before, it appeared only after
  a page reload. Every change of a move now updates open pages.

