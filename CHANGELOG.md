# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Groundwork for removing a camera and decommissioning a proxy from cams-admin: the proxy protocol now describes asking a proxy what it holds for a camera (`camera.remove.preview`), removing a camera with its content kept for retention or deleted now, archived clips only when asked (`camera.remove`), and telling a proxy without cameras to unenroll itself and forget its tokens and command policy (`proxy.unenroll`). Both changes are off by default on every proxy. No visible change yet; the buttons come later.
- Groundwork for admin viewer tokens: each viewer token in the cams snapshot now carries a role (`viewer` or `admin`). Every token is still a viewer token; the choice comes later. All cams viewers fetch a fresh snapshot once (snapshot format 5).

