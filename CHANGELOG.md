# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- A cams instance's last status report is kept across cams-admin restarts (stored when its content changes), so `/diag/cams-instances` and the dashboard no longer show no report until cams reports again.
- Camera moves can be started from cams-admin (`POST /api/v1/moves`, also with an operations token with scope `moves`): it adds the missing cams routes, the proxy's own site and clears a camera's host override first, and can pre-approve the move within bounds (the source proxy approves its own offer when the target's answer fits). `/diag/moves?requestId=` finds a move by its request, and the move-begin audit links the command to it.
