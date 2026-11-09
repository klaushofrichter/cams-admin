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

