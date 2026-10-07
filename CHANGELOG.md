# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- Per-instance camera overrides: a cams instance can reach a camera at its own host and with its own camera user (the Pi's cams through its proxy, `from-proxy` / `proxy`; the cluster's at the camera's address with `cams`). The instance's snapshot and Export carry its values; the cams-v1 contract is unchanged. The instance page has a "Camera overrides" table (edit, clear; version-checked; audited `camera-override-set` / `camera-override-clear`).
- The account's Cameras tab can edit a camera's registry fields (name as cams shows it, host, protocol, TLS name, camera user, web UI, proxy's camera id), version-checked (#25).

### Fixed

- Importing one cams instance's export no longer overwrites the host and camera user another instance uses: when the camera is already served to another instance with its shared values, the differing values become this instance's override ("override for pi: host … → …"); both instances' second dry runs show "No changes".
- An import never silently changes a camera another cams instance uses: a changed shared field (name, TLS name, web UI, protocol, proxy …) is a "shared-change" mismatch naming that instance, a value the file leaves out is kept (listed as kept), and moving such a camera to a proxy the import would create is refused.
- Camera users refuse control and format characters; a changed camera host is checked (hostname or IP with an optional port, or `from-proxy`); overrides on an account an instance stops serving are dropped (audited); saving an unchanged override writes nothing.
- The Import tab has no default cams instance any more, and a file that looks like another instance's export (a token that instance holds, its route URL, or a URL that would move a route this instance uses) shows a warning and needs its own confirmation before Apply.

