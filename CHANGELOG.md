# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Proxy tokens after a restore from an older backup: when the proxy answers our token set as stale at the same revision number (it holds another set with that number), its next heartbeat no longer confirms that set as ours and clears the "proxy ahead" guard; token changes wait for an admin's confirmation, also after a restart.

