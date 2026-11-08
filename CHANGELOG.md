# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- Viewer tokens: when more than one viewer can sign a token in (an enrolled cams instance with a base URL that serves one of its accounts), the QR / Copy link window offers a Viewer choice that switches the link and the QR code; the main viewer stays first. The copy's audit names the viewers offered.

### Fixed
- Viewer tokens: the admin-role warning shows only while the new token's role is admin (admin tokens in the list stay orange); the token rows are vertically centred.

