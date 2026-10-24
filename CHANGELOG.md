# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Cancelling a move after the camera has switched over now copies back what the new proxy recorded in the meantime; the Moves page shows the copy back and its progress.
- End transfer waits until the Archive is copied (the button says "End after Archive" meanwhile), then ends the transfer.
- The receiving proxy checks that everything arrived; the Moves page shows the result ("Complete", or what is missing).
- Give up copy back: a sysadmin can stop a copy back that cannot finish; nothing is deleted.
- Ended moves are removed from the Moves list after the proxy's retention (30 days when the proxy reports none).

