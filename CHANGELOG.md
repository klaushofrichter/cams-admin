# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- **Proxy profile:** a proxy page has a Profile card with what the proxy says
  it can hold: its name, how many cameras it holds of how many, its storage
  budget against the disk and what is used, its hardware with load and
  temperature, warnings in plain words, and the firewall lines its cameras
  need, with a Copy button. A proxy before cam-proxy 2026.10.26 shows "no
  profile reported". The profile is set on the proxy itself; cams-admin only
  reads it.
- The dashboard lists the proxies whose profile is not set yet, with a link
  to the proxy's home page where you set it.
- A camera move onto a proxy that is full (it holds as many cameras as its
  profile allows), or whose FTP port range is too small for one more camera,
  is refused before anything is sent, with the reason, for example "een holds
  3 of 3 cameras". Such a proxy is no longer offered as a move target.
- The Start move form shows the firewall lines the target needs for the
  chosen camera ("Run these on een first"), with a Copy button.
- An opened move names the space it needs against the target's storage
  budget, as it was when the move was requested, and says when it does not
  all fit.
- `GET /api/v1/proxies/:proxyId/profile` (signed in) and
  `/api/v1/diag/proxies/:proxyId/profile` (diagnostics token) return a
  proxy's profile; `/diag/proxies` carries it too.

