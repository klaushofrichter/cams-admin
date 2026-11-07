# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Proxy contract: the old single-PoE-switch settings and actions are gone. The camera action "Read the PoE switch" (`poe-switch-read`) is no longer offered, the never-remote `camera-poe-on` and the denied settings `poeSwitch` / `cameras.*.poeSwitch` are dropped. PoE switches are managed per account under Switches (since v2026.11.07.1); proxies from v2026.11.07.3 no longer have these settings.

