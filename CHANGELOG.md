# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Cameras can be onboarded by script end to end: new operations scopes (camera actions, proxy settings, removing a camera), adding ready cameras automatically per account (off by default), a proxy's site-CA pins taken from its own report, and one onboarding status per camera in the diagnostics API and on the camera page, with Set time and FTP setup where the proxy allows them (with cam-proxy's next release).
- Upgrade note: this release changes the database (migrations 17 and 18). An older build refuses the upgraded database (db_newer_than_code), so rolling back needs the backup taken before the upgrade.
