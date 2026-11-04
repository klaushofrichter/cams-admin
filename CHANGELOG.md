# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- A rename's audit record now has both names: `nameFrom`/`nameTo` and `displayNameFrom`/`displayNameTo` for accounts, proxies and cams instances, `nameFrom`/`nameTo` and `camsIdFrom`/`camsIdTo` for cameras, under the name before the change. Earlier records are left as written (`renamedTo`, `renamedFrom`).
