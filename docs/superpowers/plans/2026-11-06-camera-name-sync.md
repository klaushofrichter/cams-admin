# Camera Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One name per camera, held by the camera: cam-proxy audits renames made at the camera, and cams-admin's camera records follow the name cam-proxy reports, with an audit entry, the camera's name rules and a name lookup by `cam_…` id.

**Architecture:** cam-proxy already reads the name every status poll (`StatusPoller` emits `'name'`) and reports `name` + `nameSource` per camera in its summary. cam-proxy adds a source to the name event and audits outside renames. cams-admin extends the existing report hook (`status.onCameras` → `Registry.fillCameraModels`) with a name sync, tightens name rules, routes record renames to the camera, and adds a diag lookup.

**Tech Stack:** TypeScript (Node, Express, better-sqlite3), vitest; cams-admin web UI (Svelte).

**Spec:** cams-admin `docs/superpowers/specs/2026-11-06-camera-name-sync-design.md`

**Repos / worktrees:** Tasks 1–2 in cam-proxy (`~/Development/cam-proxy`, worktree on `/Volumes/SSD-WDBlack-1T/claude-work/`), Tasks 3–6 in cams-admin (worktree `/Volumes/SSD-WDBlack-1T/claude-work/wt-admin-namesync`).

## Global Constraints

- The camera holds the name; every rename path ends at the camera; everything else follows it.
- Camera name rules (cam-proxy `src/camera/name-rules.ts`, the contract): 1 to 31 characters; ASCII letters, digits, space and `- ( ) + = [ ] { }`; no leading or trailing space.
- cam-proxy's `cameras.<id>.name` is only the initial name: the proxy never rewrites it.
- cams-admin syncs only names with `nameSource: 'camera'`.
- Audit: cam-proxy `camera-name` (existing action) for outside renames with user `camera`; cams-admin new action `camera-name-synced` (actor type `proxy`, actor = proxy id, like `fillCameraModels`). No audit when nothing changed. A proxy (re)start's first read is not a rename.
- No queued renames: a rename is a command to the camera, refused or failed while it can't reach the camera.
- Cameras without a proxy (`proxy_id` NULL): record-only name edits, no sync.

## Review Focus

1. A rename through cams arrives at cams-admin twice in quick succession (command result + next report): exactly one `camera-name-synced` entry — test in Task 4.
2. A proxy restarts while a camera is offline: its summary carries the config name with `nameSource: 'config'`; cams-admin keeps the newer record name — test in Task 4.
3. A camera renamed by the proxy itself, then the next poll reads the same name: no "changed at the camera" audit — test in Task 1.
4. A reported name that breaks cams-admin's rules (e.g. a name set on an old firmware with `_`): record untouched, warning logged once per proxy+camera+name, no crash — test in Task 4.
5. Two cams-admin cameras mapped to the same proxy camera (shouldn't exist, but the table doesn't forbid it): both follow, each with its own audit entry — test in Task 4.

---

### Task 1 (cam-proxy): audit renames made at the camera

**Files:**
- Modify: `src/camera/status.ts` (`StatusPoller`: the `'name'` event gets a second argument)
- Modify: `src/cameras/worker.ts` (the `'name'` handler ~line 426 audits)
- Test: `test/camera-status.test.ts` (or the existing StatusPoller test file), `test/worker-name.test.ts` (new, or the existing worker test)

**Interfaces:**
- Produces: `StatusPoller` emits `'name'` with `(name: string, source: 'first' | 'camera' | 'write')`: `'first'` for the first successful read after start, `'camera'` when a poll reads a different name than the current one, `'write'` from `noteName()` (the proxy's own rename).
- Behaviour: the worker writes `audit.write({ action: 'camera-name', category: ['configuration'], type: ['change'], outcome: 'success', user: 'camera', message: \`Camera name changed at the camera: "\${from}" → "\${to}"\`, details: { from, to, source: 'camera' } })` only for `'camera'`; `this.nameRead` and `announcer.seen()` keep working as today for all three.

- [ ] **Step 1: Write the failing tests:**
  - `first read after start emits source 'first'` and the worker writes no audit.
  - `a poll reading a new name emits 'camera'` and the worker writes exactly one `camera-name` record with `user: 'camera'`, `details.from`/`to` and the message text above.
  - `noteName() emits 'write'`; a following poll reading the same name emits nothing and writes no audit (Review Focus 3).
  - `a poll that started before a write` (existing nameEpoch case) still reports no rename.
- [ ] **Step 2: Run** `npx vitest run <those files>` — Expected: FAIL.
- [ ] **Step 3: Implement** the event source in `status.ts` and the audit in `worker.ts` (the worker already has `this.audit` with the camera label).
- [ ] **Step 4: Run** the tests, then `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Camera names: audit a rename made at the camera"`

### Task 2 (cam-proxy): the config name is the initial name

**Files:**
- Modify: wherever the proxy's admin UI or docs show `cameras.<id>.name` as the camera's name (find with `grep -rn "name" web/ src/config/schema*` and the README's config table)
- Modify: `README.md`, `CHANGELOG.md`
- Test: the UI test that covers the camera config form, if any; otherwise none beyond `npm test` and the build.

**Interfaces:** none new.

- [ ] **Step 1:** Label the config value "Initial name" (help text: "Used until the camera's own name is read. Rename the camera in cams or cams-admin."). Wherever a camera's name is displayed as the current name, show the live name (`worker.name()`/summary `name`), not the config value — check the proxy UI's camera list and the summary.
- [ ] **Step 2:** README: document that the camera holds the name, the outside-rename audit (Task 1), and that `cameras.<id>.name` is the initial name. CHANGELOG Unreleased entry for Tasks 1–2.
- [ ] **Step 3: Run** `npm run build && npx vitest run` — Expected: PASS.
- [ ] **Step 4: Commit** `git commit -m "Config: cameras.<id>.name is the initial name; docs"`

### Task 3 (cams-admin): cameras.*.name is no longer remote-settable

**Files:**
- Modify: `contract/make.ts` (remove `'cameras.*.name'` from the remote-settable list), regenerate the contract outputs with the repo's contract build command (see `contract/README.md`), `contract/README.md` line ~325 text
- Modify: `server/config/service.ts` and the web config editor if they special-case `cameras.*.name`
- Test: the contract tests and `test/config*.test.ts`

**Interfaces:** Produces: `REMOTE_SETTABLE` without `cameras.*.name`; `config.set` of it from cams-admin is refused like any non-settable path.

- [ ] **Step 1: Write the failing test** `config.set refuses cameras.*.name` (400 with the existing not-settable error).
- [ ] **Step 2: Run** it — Expected: FAIL.
- [ ] **Step 3: Implement**: contract change + regenerate; drop any UI affordance for editing it in the config editor.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (update vectors/fixtures the regeneration changes).
- [ ] **Step 5: Commit** `git commit -m "Contract: cameras.*.name is not remote-settable (the camera holds the name)"`

### Task 4 (cams-admin): records follow the reported name

**Files:**
- Modify: `server/status/derive.ts` (`ReportedCamera` gains `nameSource?: 'camera' | 'config'`), `server/status/store.ts` (~line 190: pass `nameSource` through)
- Modify: `server/registry.ts` (new `syncCameraNames`), `server/server.ts` (~line 85: call it in `status.onCameras` next to `fillCameraModels`, publish changed cameras), `server/audit.ts` (`AUDIT_ACTIONS` gains `'camera-name-synced'`)
- Test: `test/registry-names.test.ts` (new), `test/status*.test.ts` (nameSource passes through)

**Interfaces:**
- Produces: `Registry.syncCameraNames(proxyId: string, reported: { ref: string; name?: string; nameSource?: 'camera' | 'config' }[]): Camera[]` — returns the cameras it changed.
- Behaviour: for reported cameras with `nameSource === 'camera'` and a `name` that passes the camera rules (Task 5's `cameraNameProblem` copy; until Task 5 lands use cam-proxy's regex from Global Constraints), every row `WHERE proxy_id = ? AND proxy_camera_id = ref AND name <> reported` is updated (`name`, `updated_at`, `version + 1`) in one transaction, each with `audit.write({ actorType: 'proxy', actor: proxyId, action: 'camera-name-synced', accountId, targetType: 'camera', targetId: id, targetLabel: cams_id, outcome: 'ok', detail: { from, to, proxyCameraId: ref } })`. Invalid names: no update; `log.warn` once per proxy+ref+name.

- [ ] **Step 1: Write the failing tests:**
  - `a reported camera name replaces the record name, with one audit entry` (from/to in detail).
  - `the same name again changes nothing and writes no audit` (Review Focus 1: call twice).
  - `a config-sourced name is ignored` (Review Focus 2).
  - `a name that breaks the camera rules is ignored and warned once` (Review Focus 4).
  - `two records mapped to the same proxy camera both follow` (Review Focus 5).
  - `cameras without a proxy are never touched`.
  - store test: `nameSource from the summary reaches onCameras`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; the snapshot revision changes because `cameras.name` changed (check `SNAPSHOT_FORMAT` needs no bump: content shape is unchanged).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Camera records follow the name the camera reports (camera-name-synced)"`

### Task 5 (cams-admin): camera name rules; renames go to the camera

**Files:**
- Create: `server/cameraName.ts` — a copy of cam-proxy's `name-rules.ts` (`CAMERA_NAME_MAX`, `CAMERA_NAME_RE`, `cameraNameProblem`), header naming its source
- Modify: `server/validate.ts` (`cameraInput` name: `cameraNameProblem` instead of `max: 80`), `server/registry.ts` (`updateCamera`), `server/import/importer.ts` (~line 394), the web UI camera form
- Test: `test/validate*.test.ts`, `test/registry*.test.ts`, the web e2e/unit test for the camera form if one exists

**Interfaces:**
- Produces: `cameraNameProblem(name: unknown): string | null` in `server/cameraName.ts` (Task 4 switches to it if it used the regex).
- Behaviour:
  - Create/update with a name that breaks the rules → 400 `invalid` with the reason (e.g. "too long: 32 characters, at most 31").
  - `PATCH` of a camera with a proxy mapping (`proxy_id` and `proxy_camera_id` set) that changes `name` → 409 `rename_at_camera`, detail: the rename endpoint `POST /accounts/:accountId/proxies/:proxyId/cameras/:camera/name`. Other fields in the same PATCH are not applied (all or nothing).
  - Create with a mapping: the name is a placeholder (allowed); the form shows "The camera's own name replaces this when its proxy reports it."
  - Importer: for mapped cameras it leaves `name` out of the patch.
  - Web UI: the camera edit form's name field, for a mapped camera, sends the rename endpoint (existing `actions.rename`) and shows the command's outcome (failed while offline: "The camera is offline; try again when it is online."). Record-only for cameras without a proxy.

- [ ] **Step 1: Write the failing tests:** rule refusals (32 chars, `_`, leading space) on create and update; `PATCH name of a mapped camera answers 409 rename_at_camera and changes nothing`; `PATCH name of an unmapped camera works`; importer leaves mapped names alone.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces, including the web form.
- [ ] **Step 4: Run** `npm test` and the web build/e2e for the camera form — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Camera names: the camera's rules; renames go to the camera"`

### Task 6 (cams-admin): name lookup by id; docs

**Files:**
- Modify: `server/diag/router.ts` (route `GET /diag/cameras/:cameraId` for a `cam_…` id; add to `ROUTES`), `server/diag/views.ts`
- Modify: `docs/diagnostics.md` (or the diag doc), `README.md`, `CHANGELOG.md`
- Test: `test/diag*.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/diag/cameras/:cameraId` → `{ id, name, model, proxyId, proxyCameraId, camsId, online }` (online from the proxy's last report, `null` without a proxy); 404 `not_found` for an unknown id; the existing `GET /diag/cameras/:camsId/onboarding` keeps working (different depth). Signed-in users already have `GET /accounts/:accountId/cameras/:cameraId`.
- Ruling vs spec path (`GET /api/v1/cameras/:id`): the lookup lives under `/diag` because the diag token is the read credential for agents and tools, and users have the account route; ops tokens read diag like today.

- [ ] **Step 1: Write the failing test** `diag camera lookup answers the current name` (after a sync from Task 4) and `unknown id answers 404`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; document the sync (timing, audit entries), the rules, the 409, and the lookup in README/diagnostics; CHANGELOG Unreleased.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Diag: camera lookup by id; docs for camera name sync"`

### Task 7: release and live check (controller)

- [ ] Release cam-proxy and cams-admin as usual; update the hosts (cam-proxy: een, Pi, mini PC via `upd-all.sh`).
- [ ] Within a minute, cams-admin's diag shows cam3 "Backyard Middle", cam4 "Backyard Right", e1 "PTZ Camera", with three `camera-name-synced` audit entries.
- [ ] Outside rename: rename the simulator cam2 through its own camera API (as the Reolink app would), check cam-proxy's `camera-name` audit with user `camera` and cams-admin's sync, then rename it back.
- [ ] Slack post.
