# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Camera moves: a done move whose cleanup is still pending is resumed at most once every 10 seconds again (each tick used to forget when it last resumed).
- Cameras: a camera user of only spaces is refused (400) instead of being stored as an empty user; an empty one still means no user.
- cams instances: removing a served account also removes the instance's routes to that account's proxies (audited as `route-update`, reason `account-not-served`), as it already did for camera overrides. Serving the account again starts with no routes. Routes left over from earlier removals go the next time the instance's served accounts are saved.
- Audit log: the Action filter lists every action cams-admin records (it missed the move, command, token, switch and other newer ones).
- Camera rename: when other fields were saved but the rename failed, an error such as "TypeError: …" keeps its spelling in the message.
- After a restart, no proxy counts as connected until it says hello again (moves and the move summary could read a stale "connected").
- PoE switches: a power-cycle request from a camera's proxy that is refused at once (power unknown, not PoE) no longer blocks the next request for 60 seconds.
- PoE switches: removing a switch audits a failed `switch.forget` (the operating proxy keeps the password); the removal still completes.
- PoE switches: lowering a switch's port count below a mapped camera's port is refused (409 `ports_in_use`, naming the camera) instead of hiding that camera from the port table.

