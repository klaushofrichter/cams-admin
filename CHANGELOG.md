# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- An operations token with the `registry` scope can rename a cams instance and
  change its address and notes (`PATCH /cams-instances/:instanceId`), so a
  script or an LLM can do it. It cannot change which accounts the instance
  serves: that stays with a sign-in. `/diag/cams-instances` gives the
  `rowVersion` it needs.
- The proxy page shows the proxy's GUI address as a link at the top, with the
  same warning for a loopback or local network address, and its **Registry**
  form can now rename the proxy (short name and display name). A rename is
  safe: everything goes by the proxy id. The dashboard and the account page
  show the address too. A `registry` token can do the same through
  `PATCH /accounts/:accountId/proxies/:proxyId` (see docs/diagnostics.md).
- Fixed: emptying a proxy's name, display name or "runs on" through the API
  answers 400 instead of a server error.
- A rename's audit record says the new name (`renamedTo`). The proxy form sends
  only what changed, so the audit lists what was edited, and a reload keeps
  what you are typing.

