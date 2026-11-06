# Camera name sync: the camera's own name everywhere

Status: design, 2026-11-06. Agreed with Klaus in chat; marked calls are mine.
Repos: cams-admin (main part), cam-proxy (detection and audit).

## Why

On 2026-11-06 Klaus renamed three cameras in cams ("Backyard right" → "PTZ
Camera", "Backyard middle" → "Backyard Right", "Garage" → "Backyard Middle").
The cameras took the names (audited by cam-proxy), but cams-admin's camera
records and cam-proxy's config kept the old ones. "Backyard middle" in
cams-admin now labels cam4 while the camera called Backyard Middle is cam3:
stale names point at the wrong camera.

Klaus: "We should have consistent names in the Reolink app, the cams-admin,
cams-proxy and cams." The stable key is the cams-admin camera id (`cam_…`);
names are labels that follow the camera.

## Decisions (Klaus)

- One name per camera, the same in the Reolink app, cams-admin, cam-proxy and
  cams.
- The cams-admin id (`cam_…`) is the stable key; a name service in cams-admin
  answers id → current name.
- Sync automatically; a rename made outside our apps (Reolink app) is simply
  followed: "Just handle it. No need to confirm."
- Audit: the rename where it happens, and the sync where a record follows.

## The model

- **The camera holds the name** (Reolink `DevName`; the same value as
  `GetDevInfo.name` and the OSD text). The Reolink app reads and writes it
  directly, so nothing else can be the source of truth.
- Every rename path ends at the camera:
  - cams → cam-proxy `PUT /control/cameras/<id>/name` → `SetDevName`, read back (exists);
  - cams-admin → command `camera.name.set` → cam-proxy → camera (exists);
  - the Reolink app → the camera (outside our apps).
- Everything else follows the camera:
  - cam-proxy reads the name on every status poll (`statusPollS`, 30 s on
    all of een's cameras) and reports it in its summary (exists:
    `summary.cameras[].camera.name`, heartbeat about every 30 s);
  - cams-admin updates its camera record from the report (new);
  - cams gets the record through its snapshot (exists; a changed name changes
    the snapshot revision).

## Changes

### cam-proxy

1. **Outside renames are noticed and audited.** When a status poll reads a
   name different from the last known one, and the change didn't come
   through the proxy's own rename (within the same poll/rename window), it
   writes an audit record `camera-name`, outcome success, user `camera`,
   message `Camera name changed at the camera: "A" → "B"`, details
   `{from, to, source: 'camera'}`. No audit when the poll reads the same
   name. The first read after start sets the baseline without an audit
   (*my call*: a restart is not a rename).
2. **The config's `cameras.<id>.name` is only the initial name** (*my
   call*): it names a camera until the first successful read; the proxy
   never rewrites it (a write would change `configRevision` on every rename
   and make cams-admin re-fetch the config). Wherever the proxy shows a
   camera's name (its UI, health, summary), it shows the live name; the
   config value is labelled "initial name" where it is displayed or edited.
   `cameras.*.name` comes off cams-admin's remote-settable list (contract
   `remote-settable.json`), since setting it from cams-admin would never
   reach the camera.
3. The summary already carries the name; nothing changes there.

### cams-admin

1. **Records follow the reported name.** On each status report, for each
   camera that maps to a cams-admin camera (`proxyId` + `proxyCameraId`)
   and whose summary says `nameSource: 'camera'` (*my call*: a name taken
   from the proxy's config before the first read must never undo a newer
   camera name), compare the reported name with the record's `name`; when they differ
   and the reported name is valid, update the record and write an audit
   entry `camera-name-synced` (system actor) with `{cameraId, proxyId,
   proxyCameraId, from, to}`. No write and no audit when equal; nothing for
   offline cameras whose report keeps the last name (*builder: confirm the
   proxy keeps the last name while offline — `status.ts` says it does*).
2. **Name rules = the camera's rules** for camera names everywhere a name
   is entered (create, edit, rename): 1–31 characters of ASCII letters,
   digits, space and `- ( ) + = [ ] { }`, no leading or trailing space
   (cam-proxy `src/camera/name-rules.ts` is the reference; reuse its
   contract if the shared contract has it). Today cams-admin allows up to
   80 characters.
3. **Editing a camera's name in cams-admin renames the camera**: it sends
   `camera.name.set` (exists) instead of only changing the record; the
   record changes when the camera confirms (the command's result or the next
   report). For a camera whose proxy doesn't allow `camera.name.set`, or
   that is offline, the edit is refused with a clear reason (*my call*:
   no queued renames — a stored name the camera never took is exactly the
   stale state we are removing).
   Cameras without a proxy (`proxyId` null, read directly by cams): a name
   edit stays a record-only edit, and the record does not sync (*my call*:
   cams-admin gets no report for them; all of today's cameras have a proxy).
   Creating or importing a camera that maps to a proxy camera: the typed
   name is a placeholder, and the form says the camera's own name replaces
   it at the first report, which writes a `camera-name-synced` entry (*my
   call*: no command inside create, and the camera stays the one source).
4. **Name service**: `GET /api/v1/cameras/:id` (diag token, ops token and
   signed-in users of the account) answers `{ id, name, model, proxyId,
   proxyCameraId, online }`; the existing diag `/cameras` list already has
   these fields. The cams MCP tools that list cameras use the same names.
5. **One-time catch-up**: the first report after the release fixes today's
   stale records (three on een), each with a `camera-name-synced` audit
   entry. No migration needed.

### cams

No change: cams already shows the name cam-proxy reports
(`server/cameraRegistry.ts` `setReportedName`/`cameraName()`), falling back to
the snapshot's record name.

## Audit, end to end

| Rename via | cam-proxy audit | cams-admin audit |
|---|---|---|
| cams | `camera-name` with the user/token (exists) | `camera-name-synced` |
| cams-admin | `camera-name` (user `cams-admin`, exists) + the command's own audit | `camera-name-synced` |
| Reolink app | `camera-name`, user `camera`, "changed at the camera" (new) | `camera-name-synced` |
| nothing | none | none |

## Timing

No schedule: the existing 30 s status poll and the ~30 s heartbeat carry the
name. A rename through our apps reaches cams-admin within about 30 s; a
Reolink-app rename within about a minute. After an outage, the first report
fixes everything.

## Non-goals

- Names of proxies, accounts, cams instances.
- A rename history UI (the audit holds it).
- Conflict handling beyond "last write at the camera wins".

## Tests the builder needs

- cam-proxy: poll reads a new name → one audit `camera-name` (source camera);
  same name → none; a rename through the API → no second "at the camera"
  record; first read after start → none.
- cams-admin: report with a different name → record updated + one
  `camera-name-synced`; same name → nothing; invalid reported name → no
  update, logged; name edit sends `camera.name.set` and the record changes
  only after the camera confirms; name rules enforced (32 characters, `_`,
  leading space refused); `GET /api/v1/cameras/:id` answers the current name.
- Live: rename one test camera (cam3/cam4/e1) in the Reolink app; within a
  minute cam-proxy and cams-admin show it, with both audit entries.

## Release

cam-proxy and cams-admin releases, either order (each half works alone: the
proxy's outside-rename audit, cams-admin's sync from the existing report).
Post to Slack #cams-application.
