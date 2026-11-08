# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]


### Changed

- Delete confirmations name what goes and what stays. Deleting a proxy lists its camera moves, proxy tokens and cams routes, which go, and its cameras and command records, which stay without a proxy. Deleting an account lists everything in it. Both say the audit log stays, and both come with counts from the new read-only `GET /accounts/:accountId/proxies/:proxyId/delete-preview` and `GET /accounts/:accountId/delete-preview`. A running move or a PoE switch the proxy operates is named up front, and Delete stays disabled until it is resolved. The cams instance Delete names its routes, camera overrides and account links in the same way. Deleting a camera now asks first.
- New accounts: **Add me as admin** (on by default) adds you as an admin user of the new account (audited `user-create`), so cams lists the account for you. An account without users now says that nobody can open it in cams with a Google sign-in until a user is added.
- The proxy page header says "no GUI address set" when the GUI address (Admin UI URL) is empty. It used to say "no address set" even when the URL was filled in.

### Fixed

- A proxy that was deleted and then added and enrolled again no longer trips the restore guard ("the proxy is ahead — was cams-admin restored from a backup?", `409 proxy_ahead`, `token_proxy_ahead` in cams). The proxy keeps its old token revision. When the new record has never had a token set (no token rows, no `tokens.apply` ever), cams-admin sends its set above that revision at once, audited as `command-create` reason `new-record`. A record that had tokens keeps the guard unchanged.
