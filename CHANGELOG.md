# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added

- Groundwork for removing a camera and decommissioning a proxy from cams-admin: the proxy protocol now describes asking a proxy what it holds for a camera (`camera.remove.preview`), removing a camera with its content kept for retention or deleted now, archived clips only when asked (`camera.remove`), and telling a proxy without cameras to unenroll itself and forget its tokens and command policy (`proxy.unenroll`). Both changes are off by default on every proxy. No visible change yet; the buttons come later.
- Groundwork for admin viewer tokens: each viewer token in the cams snapshot now carries a role (`viewer` or `admin`). Every token is still a viewer token; the choice comes later. All cams viewers fetch a fresh snapshot once (snapshot format 5).
- **Remove from proxy…** on a camera row (Cameras tab). It asks the proxy what it holds for the camera (clips, stills, archived clips). You choose to keep its content until retention ages it out (the default) or delete it now. **Also delete its archived clips (N)** appears only with Delete now and only when there are archived clips, and is off by default. You type the camera's cams id to confirm. When the proxy confirms, the camera's record is deleted and audited as `camera-remove` with the proxy's answer. With the proxy offline or too old, the panel offers **Delete record only**. The proxy must allow `camera.remove.preview` and `camera.remove`.
- **Decommission…** on the proxy page: the proxy unenrolls itself and forgets its tokens and the command policy cams-admin set, and then its record is deleted. The panel lists what goes and what stays. It is disabled while the proxy still reports cameras, and links to them. You type the proxy name to confirm. The decommission is audited as `proxy-unenroll`, followed by `proxy-delete`. With the proxy offline, the panel offers **Delete record only** and says to run `admin-unenroll` on the host. The proxy must allow `proxy.unenroll`.
- Viewer tokens have a **Role**: viewer (the default) or admin. An admin token is shown in orange with a one-line warning, and makes its holder an admin of each of the token's accounts in cams. Role changes are audited (`viewer-token-role`) and reach the viewers with the next snapshot.
- Remove from proxy and Decommission count toward the fleet limit for disruptive actions (one proxy at a time, at most 3 in 10 minutes). The new `LIMIT_FLEET_DISRUPTIVE` setting changes the count (the e2e server raises it).
- A tab left open across a release now says "A new version of cams-admin is available" with a **Reload** button (checked every 5 minutes and when the tab gets focus). It never reloads by itself. Before, an open tab kept running the old screens, and their missing safeguards, until someone reloaded it.
- When a cams viewer can't use an account's configuration (`snapshot_invalid`), the account's Overview and the Dashboard now say so in words, name the camera, and point to the fix. Before, the viewer silently kept the last good configuration.

### Changed

- **Add camera** with a proxy takes the camera's host, protocol and TLS name from what the proxy reports, unless you enter others. When the proxy doesn't report them, the form asks for host and protocol. Before, the camera was saved without them and cams refused the whole account.
- The **Operating proxy** of a new PoE switch no longer defaults to the first proxy in the list, which could be the cluster's simulator proxy. It defaults to the account's only non-cluster proxy, or asks you to choose. Cluster proxies are listed last.

### Fixed

- Switch surveys skip simulated cameras (kind sim). Before, the cluster's simulator showed up as "not found (not_reachable)" on a physical switch. Checking or searching a simulated camera's power is refused, because it is on no switch.
- The enrollment code lifetime (1 h, 24 h, 7 d) is read from the picker when the code is created, so the stored and audited lifetime always matches what the page shows.

