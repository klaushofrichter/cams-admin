# Runbook: removing a cams viewer

A cams instance is a viewer enrolled in cams-admin, one per place cams runs. This
removes one for good. The steps are in order; example host names only.

## Before you start

- **Is it still needed?** Users of that viewer lose it. Its accounts keep working
  through the other viewers.
- **Delete or Block?** **Block** locks it out and keeps its record: use it when a
  viewer may come back. **Delete** removes the record: to bring it back you create and
  enroll a new instance.
- **What else runs on that host?** Stop only the viewer. A cam-proxy next to it is a
  separate compose project with its own record under the account.

## Steps

1. **Stop the viewer on its host,** first, so it can't report in while it goes:
   ```sh
   cd <viewer folder> && docker compose down
   ```
   This removes the container only. Its data stays on disk, and it stays stopped
   after a reboot.
2. **Delete it in cams-admin:** Cams → the instance → **Delete**, then confirm. This
   needs an admin sign-in; ops tokens can't do it. cams-admin revokes the tokens it
   holds on the proxies (each proxy drops them at its next contact) and its signing
   keys, deletes the instance with its routes and camera overrides, and writes
   `cams-instance-delete` to the audit log. Revoked keys stay revoked after a restore.
3. **Check:** the instance is gone from Cams and from the dashboard, and
   `/diag/tokens` shows no live token held by it. The other viewers show their
   cameras as before; the proxies have no problems.
4. **Clean up on the host, when you're sure:** remove the viewer's folder, which holds
   its enrollment key, login token and cached configuration. Remove any firewall rule
   that opened its port.
5. **Your own scripts and notes:** take the host out of anything that updates viewers
   after a release, and correct bookmarks that point at it.

## Afterwards

- Audit records keep the instance's name and id; they aren't edited.
- To bring a viewer back: create an instance, and enroll with a new one-time code.
