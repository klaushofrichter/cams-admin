# cams-admin: migration phase 3 (remote configuration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sysadmin reads each proxy's settings in cams-admin, changes the remote-settable ones through a dry-run diff and an explicit Apply, sees and resolves conflicts with local edits, rolls changes back, and runs the camera actions, camera renames and proxy restarts a proxy allows — all as signed P2 commands, recorded on both sides.

**Architecture:** The contract (`contract/v1`, additive: args/result schemas for the seven P3 commands, `remote-settable.json`, fixtures, vectors) comes first and is shared with cam-proxy ("The P3 contract", identical in both plans). On the server, the P2 `Commands` service carries every P3 command unchanged in its machinery; two new services sit on it: `ProxyConfig` (the last reported view per proxy in `proxy_config`, fetches by `config.get` on change, previews and applies by **preview id**, rollbacks) and `RemoteActions` (camera actions, renames, restarts with confirmation). The test client gains a reference proxy for these commands, so cams-admin's tests and e2e run without cam-proxy; the local stack runs the real cam-proxies.

**Tech Stack:** TypeScript, Express 5, `node:sqlite`, `ws`, ajv (run time lenient; strict in tests), vitest, Svelte 5, Playwright (existing). Node ≥ 26. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (cited **M §n**): §3 (M4, M5), §5 (`proxy_config`), §7.1, §7.6–§7.9, §8 (all), §12.1, §13.1, §13.3, §14.1–§14.3, §15 (P3). Builds on `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md` (rulings R2-10 … R2-15 stay in force; the P2 contract as amended by `revocationOnly`). The companion plan is cam-proxy `docs/superpowers/plans/2026-10-07-migration-p3-cam-proxy.md`: its rulings **R3-1 … R3-14 apply here too** (classification upper bound, narrow-only paths, path refusals as `done` results, whole-revision conflict, path-level rollback, compact `config.get`, the `performAction` core, scrubbed results and the Push-now key fix, journal budgets, restart after the answer, rate windows, early heartbeat, requesters, the "set by cams-admin" marker). **The P4 plans (cams, cams-admin) are written in parallel; this plan depends on none of their code** (see Global Constraints for the shared files).

## Klaus's decisions (recorded as decisions, not defaults)

Klaus pre-approved spec, plan, implementation and deployment, and answered M §16:

1. **Held trust changes (Q1):** cams holds changed connection data until an account admin confirms. *(P4. P3 never changes connection data: those settings are denied on the proxy and absent from `remote-settable.json`.)*
2. **Stale cache (Q2):** cams uses its cached configuration however old. *(P4.)*
3. **Disruptive remote actions (Q3):** camera reboot, power-cycle, proxy restart and FTP/NTP/cert setup may be allowed **per proxy, off by default**. cams-admin offers them only when the proxy reports the entry allowed, groups them as disruptive, and asks for a typed confirmation.

## Rulings made in this plan (where the spec is silent or unclear)

- **R3-15 Apply by preview id.** `POST …/config/apply {previewId}` creates the real write from a **dry-run command row**: same account and proxy, created by the same sysadmin, `state = done` with `status ok`, not older than 10 minutes, its `baseRevision` equal to the stored view's revision, and not applied before. Anything else is 409 `preview_required` / `preview_stale` / `preview_used`. The args are copied from the row (only `dryRun` flips), so the diff the person saw is the change that is sent; the API has no "write without a preview" path. Rollback works the same way (`rollback/preview` → `rollback/apply {previewId}`).
- **R3-16 cams-admin's own pre-check of paths.** The editor and the API accept only paths whose pattern is in `contract/v1/remote-settable.json`'s `remote` list **and** in the proxy's reported `settable` (the intersection); anything else is 400 `not_remote_settable` before a command exists. A narrow path moved the wrong way is 400 `widening_local_only` (same rule as the proxy, `narrowingOk` in `server/config/narrow.ts`). The proxy re-checks everything (R2-15).
- **R3-17 `config.get` triggers** (M §8.1): (a) the heartbeat shows `config.get` allowed and no view is stored; (b) the heartbeat's `configRevision` differs from the stored view's; (c) a `config.set`/`config.unset`/`config.rollback` ended (`done` with a real write, or `conflict`); (d) **Reload** in the UI. At most one open `config.get` per proxy and at most one automatic one per proxy per minute; actor `system` for (a)–(c).
- **R3-18 Camera actions live on the Proxy page.** cams-admin has no Camera page; the actions card lists the proxy's cameras (from its view, else its heartbeat) with the remote actions as buttons; an Account page camera row links to `#/accounts/<a>/proxies/<p>?camera=<id>`. Disruptive actions and `proxy.restart` need `confirm: "<action name>"` in the request (400 `confirm_required`); the UI asks the person to type it.
- **R3-19 No new audit action.** `command-create` (with the summarised args: paths and new values, values clamped to 200 characters; for camera actions the camera and action) and `command-result` (status, code, the changed paths) cover P3; the config view itself is not audited (it is in `proxy_config`).
- **R3-20 Values are shown, never trusted.** A proxy's view and results are validated leniently (`commands/config.get.result`), clamped by `sanitize`, stored ≤ 256 KiB, and rendered as text; a `settable` entry outside `remote-settable.json` is ignored (a hostile or newer proxy can't widen the editor).
- **R3-21 Rollbackable rows:** `config.set`, `config.unset`, `config.rollback` with `dry_run = 0`, `state = done`, and a result with at least one change. Others show no Roll back.

## Global Constraints

- **Contract first** (P2 rule): wire changes go into `contract/build.ts`/`make.ts`/`make-vectors.ts`, `npm run contract:make`, commit; cam-proxy vendors the same day. `scripts/contract/cam-proxy-check.sh` stays green against cam-proxy `main`, reporting P3 fixtures `pending` (not failed) until cam-proxy implements them.
- **Commands are off by default on every proxy.** cams-admin never assumes an entry; it shows what the heartbeat's `commands.allow` reports and refuses to queue (409 `not_allowed_on_proxy`) otherwise (R2-15).
- **cams-admin never talks to a camera** and has no generic "set" or "run" command: the seven P3 commands with their closed args only.
- **No secret in the registry, a command, a result, the audit log, a log line or the SSE stream** (M1, M §13.3): the P1/P2 secret-marker guard extends to `proxy_config`, P3 args and results. Settings carry no secrets; the guard proves it with a marker in the fake proxy's environment.
- **Database writes only on meaningful changes:** a command's state change, a stored view (only when its revision or content differs), nothing per heartbeat. `test/write-budget.test.ts` gains a P3 case.
- **Rate limits never key on the client address.** The P2 limit (60 commands/min/proxy) and the session write limit apply; previews count.
- **Public repository:** RFC 5737 / 2606 values only (`192.0.2.123` for an NTP server in tests); no real ids.
- **P4 runs in parallel:** this plan adds **one** migration, numbered **the next free number at implementation time** (5 if P4's has not landed, else the one after); `server/server.ts`, `server/api/router.ts`, `server/audit.ts` and `web/src/pages/Proxy.svelte` may need a rebase onto P4's changes — never take P4 code into this plan's work.
- **e2e lock** (CLAUDE.md): take the coordinator's lock before Playwright in a shared scratchpad; stop only PIDs you started.
- **Never** the real camera, the Pi, the cluster or the real S3 from tests or the Mac.

## Review Focus

1. **Apply without the matching preview** — a direct API call with made-up args, a preview by another sysadmin, a preview made before a local edit changed the stored revision, or the same preview applied twice — must be refused (409) and create no command. Task 4.
2. **A local edit on the proxy while the editor is open** must surface: the heartbeat's new `configRevision` triggers a re-read, the editor shows "changed on the proxy", a preview made earlier becomes stale, and an Apply that still reaches the proxy answers `conflict`, which the UI shows as "on the proxy now" next to "your change" per path. Tasks 4, 7.
3. **A hostile or newer proxy's `config.get`** (10 000 paths, 1 MiB strings, `__proto__` keys, HTML in values, a `settable` entry for `camsAdmin.url` or `cameras.*.host`) must be clamped, stored within 256 KiB, rendered as text, and never make a denied path editable. Task 4 (service) and Task 7 (UI).
4. **A disruptive action clicked twice, or by two sysadmins** must create one command per confirmed request, and the proxy's `rate_limited` with `retryAfterS` (journal budget) must show as "try again in …", not as a failure of cams-admin. Task 5.
5. **Rolling back a row that isn't a real write** (a dry run, a conflict, a failed or refused command, a `config.get`, another proxy's command, another account's) must be refused, and a rollback the proxy answers `conflict` must show which paths changed since. Task 4.

---

## The P3 contract (identical in both plans; binding)

Additive to "The P2 contract" (cams-admin `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`, as amended by `revocationOnly`, cams-admin `contract/README.md`). The envelope stays **v1**, the subprotocol `cams-admin.v1`, signatures and JCS unchanged. Everything new is in cams-admin `contract/v1/` (made by `contract/build.ts` / `contract/make.ts` / `scripts/contract/make-vectors.ts`); cam-proxy vendors it into `test/contract/cams-admin-v1/`.

**Commands P3 implements:** `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart` (all already in the strict `command` enum since P2). No new wire command, no new message type, no new heartbeat field.

**Allow entries** (unchanged list since P2): `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.name.set`, `proxy.restart`, `camera.action:<a>` per remote action. **Every entry is off by default.** The **disruptive** entries are `proxy.restart` and `camera.action:<a>` for `a` in `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push` (Klaus's decision 3: allowed per proxy, off by default; the UIs group and warn).

**Action lists** (compiled on both sides, exported from `contract/build.ts`):
- `REMOTE_ACTIONS` (unchanged): `camera-test`, `onvif-resubscribe`, `camera-ftp-test`, `poe-switch-read`, `inventory`, `inventory-cancel`, `retention-run`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`.
- `NEVER_REMOTE_ACTIONS` (new export): `find-camera`, `camera-address`, `camera-trust-clear`, `tls-ca-rotate`, `tls-ca-drop-previous`, `archive-clear`, `inventory-repair`, `camera-poe-on`, `restart-proxy`.
- `DISRUPTIVE_ACTIONS` (new export): `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`.

**Check order** (normative; the P2 steps 1–12 with these changes, each step's refusal wins over later ones):

- **Step 8 (allowed):** for `camera.action`, the command passes step 8 when the allow-list holds **at least one** `camera.action:*` entry; every other command needs its own name in the allow-list. (`implemented` as before.)
- **Step 9 (rate, in memory):** the totals (30/min, 300/day) plus per-command windows: `config.set`, `config.unset` and `config.rollback` share **one** window of 6 per minute (dry runs count); `camera.action` 12 per minute; `camera.name.set` 6 per minute; `tokens.apply` 6 per hour. `config.get` counts only toward the totals.
- **Step 10 (args):** the args validators below (`unsupported_version` for `args.v` ≠ 1, `invalid_args` otherwise).
- **Step 11 (entries and budgets the args need):** `camera.action`: an `args.action` in `NEVER_REMOTE_ACTIONS` → `not_allowed` (always, whatever the allow-list says); otherwise `camera.action:<args.action>` must be in the allow-list → else `not_allowed`; a disruptive action, or `proxy.restart`, must fit the **journal budget** → else `rate_limited` with `retryAfterS`. The journal budget counts the command journal's entries (persisted, so a restart never resets it): `proxy.restart` at most 2 per hour; disruptive `camera.action`s at most 6 per hour per proxy. Journal entries count whatever their status.
- Steps 1–7 and 12 unchanged.

**Args v1** (strict; closed objects; checked in code on the proxy, by `commands/<name>.args.schema.json` in tests):

| command | args |
|---|---|
| `config.get` | `{ "v": 1 }` |
| `config.set` | `{ "v": 1, "dryRun": bool, "baseRevision": "sha256:<64 lower hex>", "set": { "<path>": <value>, … } }` — 1–64 entries; `<value>` is a boolean, a safe integer, or a string of at most 512 characters (never null, an array or an object) |
| `config.unset` | `{ "v": 1, "dryRun": bool, "baseRevision": "sha256:<64 lower hex>", "paths": ["<path>", …] }` — 1–64 unique paths |
| `config.rollback` | `{ "v": 1, "dryRun": bool, "cmdId": "cmd_<ULID20>" }` — the `config.set`/`config.unset`/`config.rollback` command to undo |
| `camera.action` | `{ "v": 1, "camera": "<camera id>" \| null, "action": "<name>", "input"?: object }` — `action` is in `REMOTE_ACTIONS` ∪ `NEVER_REMOTE_ACTIONS` (else `invalid_args`); `camera` is null **only** for `retention-run` (required otherwise); `input` only for `inventory`: `{ "kind": string 1–32, "camera"?: bool }` |
| `camera.name.set` | `{ "v": 1, "camera": "<camera id>", "name": string 1–64 without control characters }` |
| `proxy.restart` | `{ "v": 1 }` |

`<path>`: `^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$` (dotted, as `GET /control/config` names settings; no `_`, so never `__proto__`). `<camera id>`: `^[a-z0-9][a-z0-9-]{0,31}$`. `retention-run` always runs as a **dry run** on the proxy, whatever is asked.

**`done` outcomes** (the handler's; journaled; nothing is written on anything but `ok` with `dryRun: false`):

| command | `status: "ok"` | `status: "conflict"` | `status: "failed"`, `code` |
|---|---|---|---|
| `config.get` | the view | — | `store_error` |
| `config.set`, `config.unset` | the change list (also for a dry run) | `baseRevision` ≠ the proxy's current `configRevision` | `not_remote_settable`, `held_by_env`, `unknown_camera`, `widening_local_only`, `invalid_value`, `store_error` |
| `config.rollback` | the change list | a path the command changed has changed since | `no_backup`, `already_rolled_back`, `not_remote_settable`, `invalid_value`, `store_error` |
| `camera.action` | the action answered 2xx | — | the action's error code (`camera_error`, `camera_offline`, `camera_restarting`, `not_configured`, `too_soon`, `switch_busy`, `no_power`, `switch_auth`, `switch_unreachable`, `switch_error`, `inventory_busy`, `stopping`, `camera_mismatch`, `invalid`, `unknown_camera`, `internal`) |
| `camera.name.set` | the name as read back | — | `invalid_name`, `camera_offline`, `camera_error`, `unknown_camera` |
| `proxy.restart` | `{ "restartAt": ms }`; the proxy restarts **after** the result is sent | — | — |

**Results v1** (`commands/<name>.result.schema.json`; `jcs(result)` ≤ 65536 bytes as in P2):

- `config.get`: `{ "revision": "sha256:…", "schema": int, "cameras": [id…], "omittedCameras": [id…], "paths": { "<path>": { "v"?: value, "s": "default"|"file"|"override"|"env", "r"?: "restart"|"process", "p"?: true, "n"?: value, "by"?: { "cmdId", "actor", "at" } } }, "settable": { "<pattern>": { "type": "integer"|"boolean"|"string", "min"?, "max"?, "oneOf"?, "enum"?, "pattern"?, "optional"?, "dir"?: "less"|"more" } } }`. `v` absent = unset; `r` = needs a restart (`process` = a new process); `p` = changed, waiting for that restart, `n` the next value; `by` = the override's current value was set by that cams-admin command. `settable` lists the remote-settable leaves (`cameras.*.<leaf>` once for every camera) with the proxy's own bounds; `dir` marks a narrow-only path. At most 24 cameras' paths; the rest are named in `omittedCameras`.
- `config.set` / `config.unset` / `config.rollback` `ok`: `{ "dryRun": bool, "baseRevision": "sha256:…", "revision": "sha256:…", "changes": [ { "path", "from"?: value, "to"?: value, "sourceFrom", "sourceTo", "restart"?: "restart"|"process" } ], "unchanged": [path…] }` (+ `"of": "cmd_…"` for a rollback). `revision` is the revision **after** (equal to `baseRevision` for a dry run). `from`/`to` absent = unset. A path set to the value Reset would restore drops the override (`sourceTo` is then `file` or `default`).
- `failed` (config): `{ "paths": [ { "path", "code", "detail"? } ] }` (`detail` ≤ 200).
- `conflict` (config): `{ "revision": "sha256:…", "current": { "<path>": { "v"?: value, "s": … } } }` — the proxy's current revision and the current values of the paths the command names (for a rollback: the paths that changed since).
- `camera.action`: `{ "action", "camera": id|null, "httpStatus": int, "answer": object|null, "verified"?: bool, "mismatch"?: [key…] }`. `answer` is the action's JSON answer, **scrubbed**: every key matching `/pem|key|password|passwd|secret|token|cookie/i` removed at any depth, then clamped to 16 KiB (`answer: null`, `"clamped": true` when larger). `verified`/`mismatch` for the camera writes (`camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`): the proxy's whole-object Set re-read and compared.
- `camera.name.set`: `{ "camera", "requested", "name", "verified": bool }`.
- `proxy.restart`: `{ "restartAt": ms }`.

**Remote-settable paths:** `contract/v1/remote-settable.json`:

```json
{ "v": 1,
  "remote": [ "<exact leaf path, cameras.*.<leaf> for a camera leaf>", … ],
  "narrow": { "<path>": "less" | "more" },
  "denied": [ "<prefix>", … ] }
```

`remote` is the **upper bound**: cam-proxy's compiled list must be a subset of it (a test on each side); a path not in `remote` is never remote-settable, whatever a proxy says. `narrow`: cams-admin may only move the value in that direction (`less` spending, `more` evidence): `analytics.googleVision.enabled` (`less`: only to false), `analytics.googleVision.monthlyLimit`, `.dailyCap`, `.checksPerDay`, `.perCameraDailyCap` (`less`; for `dailyCap` and `perCameraDailyCap`, 0 means **no cap**, so 0 counts as infinitely high), `retention.auditDays` (`more`). A widening `config.set`/`config.unset` fails `widening_local_only`; a `config.rollback` is exempt (it restores a value the path had before cams-admin's own change). `denied` documents M §8.2's right column (and `retention.auditDays` is not in it: it is narrow). The `remote` list:

```
stills.enabled stills.stream stills.intervalS stills.size stills.quality stills.maxGB
previews.tileSize previews.grid previews.quality previews.maxGB
events.onvif.subscribeMin events.onvif.pullTimeoutS events.poll.enabled events.poll.intervalS events.poll.afterOnvifDownS events.maxOpenMin
retention.stillsDays retention.previewsDays retention.clipsDays retention.eventsDays retention.auditDays retention.streamLogDays retention.intervalMin
storage.maxPercent storage.maxBytes storage.minFreeBytes storage.keepHours.stills storage.keepHours.clips storage.keepHours.previews
composition.concurrent sse.maxClients sse.queuePerClient sse.pingS recordings.cacheMB
health.diskPercent health.tempC host.stats
ftp.enabled ftp.stream ftp.stalledHours ftp.maxGB
archive.enabled archive.warnPercent
analytics.kinds.person analytics.kinds.vehicle analytics.kinds.pet
analytics.googleVision.enabled analytics.googleVision.monthlyLimit analytics.googleVision.dailyCap analytics.googleVision.checksPerDay analytics.googleVision.perCameraDailyCap
cameras.*.name cameras.*.statusPollS cameras.*.stills.enabled cameras.*.stills.stream cameras.*.stills.intervalS
cameras.*.ftp.enabled cameras.*.ftp.stream cameras.*.storage.sharePercent
cameras.*.analytics.kinds.person cameras.*.analytics.kinds.vehicle cameras.*.analytics.kinds.pet cameras.*.events.poll.enabled
```

`denied`: `server`, `go2rtc`, `ftp.port`, `ftp.passive`, `ftp.tls`, `ftp.publicHost`, `ftp.certFile`, `ftp.keyFile`, `tls`, `composition.font`, `ntp.server`, `poeSwitch`, `camsAdmin`, `cameras.*.id`, `cameras.*.host`, `cameras.*.protocol`, `cameras.*.tlsName`, `cameras.*.user`, `cameras.*.onvifPort`, `cameras.*.rtspPort`, `cameras.*.baichuanPort`, `cameras.*.poeSwitch`, `cameras.*.ftp.user`, `cameras.*.webUiUrl`.

**Path checks on the proxy** (`config.set`/`config.unset`, in this order, every path; any failure fails the whole command, nothing written): (1) a camera path `cameras.<id>.…` whose `<id>` is not a configured camera → `unknown_camera` (adding or removing a camera is never remote); (2) not in the proxy's compiled remote list (deny wins over everything) → `not_remote_settable`; (3) `sources[path] === 'env'` → `held_by_env` (also on a dry run); (4) `baseRevision` ≠ current → `conflict` (also on a dry run); (5) a narrow path moved the wrong way → `widening_local_only`; (6) the result fails the proxy's own validation (`applyOverrides` rules, cross-checks) → `invalid_value` with the proxy's message as `detail`.

**`configRevision`** (P2, unchanged): `sha256:` + hex SHA-256 of `jcs(overrides)`. P3 adds behaviour only: a change of it makes an early heartbeat (the 10 s floor applies), so cams-admin learns about a local edit within seconds.

**Fixtures** (added to `contract/v1/fixtures/`; `$context` as in P2, plus `journal` = a list of `{cmdId, command, at, action?}` for the journal budget; unless the table names an allow-list, a fixture's `$context.allow` holds exactly the entries its command needs, so it reaches the step it tests):

| fixture | strict | runtime (proxy) |
|---|---|---|
| `valid-command-config-get`, `valid-command-config-set` (dry run, `sse.pingS`), `valid-command-config-unset`, `valid-command-config-rollback`, `valid-command-camera-action` (`camera-test`, allow `camera.action:camera-test`), `valid-command-camera-name-set`, `valid-command-proxy-restart` | valid | run |
| `valid-result-config-get`, `valid-result-config-set-ok`, `valid-result-config-set-conflict`, `valid-result-config-set-failed`, `valid-result-camera-action-verified` | valid | accepted (server) |
| `refused-config-set-not-allowed` (allow `["config.get"]`) | valid | `not_allowed` |
| `refused-camera-action-entry-missing` (`camera-reboot`, allow `["camera.action:camera-test"]`) | valid | `not_allowed` |
| `refused-camera-action-never-remote` (`find-camera`, every allow entry) | valid* | `not_allowed` |
| `refused-camera-action-no-camera` (`camera-reboot`, `camera: null`) | valid* | `invalid_args` |
| `refused-config-set-bad-path` (`"Sse.pingS"`) | valid* | `invalid_args` |
| `refused-config-set-object-value` (`{"sse": {"pingS": 5}}` as one entry) | valid* | `invalid_args` |
| `refused-config-set-65-paths` | valid* | `invalid_args` |
| `refused-config-set-args-v2` | valid | `unsupported_version` |
| `refused-proxy-restart-budget` (allow `["proxy.restart"]`, `$context.journal` two `proxy.restart` within the hour) | valid | `rate_limited` |
| `refused-camera-action-budget` (allow `["camera.action:camera-reboot"]`, journal six disruptive actions within the hour) | valid | `rate_limited` |
| `refused-proxy-restart-paused` | valid | `paused` |

\* the `command` schema checks only that `args` is an object; strict refuses the fixture's args against `commands/<name>.args.schema.json` (a test says so for each).

`vectors.json` gains two `envelopes` entries: a signed `config.set` command and its signed `done` result (`status: ok`, a one-change list), so both sides reproduce the bytes.

**Cross-check rule while the repos are out of step:** a command fixture whose `body.command` is not in the checking proxy's `IMPLEMENTED` set is reported `pending` (not a failure) by cams-admin `scripts/contract/cam-proxy-commands.ts` and skipped by cam-proxy's vendored-fixture test; once cam-proxy implements P3, neither may report `pending` (cam-proxy's last task asserts it).

---

## File map

| file | responsibility |
|---|---|
| `contract/build.ts`, `contract/make.ts`, `scripts/contract/make-vectors.ts`, `contract/v1/**`, `contract/README.md` | the P3 contract: args/result schemas, `remote-settable.json`, fixtures, vectors, `NEVER_REMOTE_ACTIONS`, `DISRUPTIVE_ACTIONS`, `REMOTE_SETTABLE` |
| `server/contract.ts` | `validateCommandArgs` and `validateResultPayload` for every wire command |
| `server/config/narrow.ts` (new) | `patternOf`, `isRemoteSettable(path, settable)`, `narrowingOk` (the contract's rules, for the pre-check) |
| `test-client/commands.ts` | the reference check, P3 steps 8/9/11 and args |
| `test-client/config.ts` (new) | a reference proxy for the P3 handlers (in-memory settings, revision, backups, actions) |
| `test-client/client.ts` | `commands.config` option wires `test-client/config.ts` |
| `scripts/contract/cam-proxy-commands.ts` | `pending` for fixtures cam-proxy `main` doesn't implement |
| `server/db/migrations.ts` | migration N: `proxy_config` |
| `server/commands/service.ts` | `WireCommand` = every wire command; `requiredEntries`/`summariseArgs` for P3; `dryRun` column; `hasOpen(proxyId, command)` |
| `server/config/service.ts` (new) | `ProxyConfig`: view, refresh, preview/apply, rollback preview/apply, heartbeat trigger |
| `server/actions/service.ts` (new) | `RemoteActions`: camera action, rename, proxy restart |
| `server/status/store.ts` | heartbeat `configRevision` → `ProxyConfig.onHeartbeat` |
| `server/api/router.ts`, `server/server.ts` | routes and wiring |
| `web/src/lib/config.ts` (new), `web/src/components/ProxySettings.svelte`, `ProxyCameraActions.svelte`, `DiffTable.svelte` (new), `ProxyCommands.svelte`, `web/src/pages/Proxy.svelte`, `web/src/pages/Account.svelte` | UI |
| `e2e/remote-config.spec.ts` (new), `e2e/server.ts` | Playwright against the test client's reference proxy |
| `scripts/localstack/start.sh`, `setup.ts`, `lib.sh`, `p3-check.ts` (new), `docs/localstack.md` | real `admin-enroll`; the two-proxy P3 check with the cam-sim round trip |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md` | docs |

---

### Task 1: The P3 contract (schemas, remote-settable list, fixtures, vectors)

**Files:**
- Modify: `contract/build.ts`, `contract/make.ts`, `scripts/contract/make-vectors.ts`, `contract/README.md`, `contract/v1/**` (regenerated), `server/contract.ts`, `test/contract.test.ts`, `test/jcs.test.ts` (the new envelopes)
- Create: `contract/v1/remote-settable.json` (written by `make.ts` from `build.ts`)

**Interfaces:**
- Produces (from `contract/build.ts`): `NEVER_REMOTE_ACTIONS`, `DISRUPTIVE_ACTIONS`, `REMOTE_SETTABLE: { v: 1; remote: string[]; narrow: Record<string, 'less' | 'more'>; denied: string[] }` (exactly the contract text), `PATH_PATTERN` (the `<path>` regex source), `P3_COMMANDS = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'] as const`.
- Schemas (lenient + strict): `commands/<name>.args` and `commands/<name>.result` for the seven commands.
- `server/contract.ts`: `validateCommandArgs(command: WireCommand, args: unknown)` for all eight wire commands (strict args schema + the code checks JSON Schema can't say: unique `paths`, the 16 KiB bound); `validateResultPayload(command, result)` lenient per command.

- [ ] **Step 1: Failing tests** in `test/contract.test.ts`:

```ts
it('every P3 command has strict args and result schemas; the valid fixtures pass them', () => {
  for (const c of P3_COMMANDS) {
    expect(existsSync(join(V1, 'strict/commands', `${c}.args.schema.json`)), c).toBe(true);
    expect(existsSync(join(V1, 'strict/commands', `${c}.result.schema.json`)), c).toBe(true);
  }
  for (const n of ['valid-command-config-get', 'valid-command-config-set', 'valid-command-config-unset', 'valid-command-config-rollback', 'valid-command-camera-action', 'valid-command-camera-name-set', 'valid-command-proxy-restart']) {
    const m = fixture(n).message;
    expect(strictValidator(`commands/${m.body.command}.args`)(m.body.args), n).toBe(true);
  }
});
it('the starred refused fixtures fail their strict args schema (the contract table)', () => {
  for (const n of ['refused-camera-action-never-remote', 'refused-camera-action-no-camera', 'refused-config-set-bad-path', 'refused-config-set-object-value', 'refused-config-set-65-paths']) {
    const m = fixture(n).message;
    expect(strictValidator(`commands/${m.body.command}.args`)(m.body.args), n).toBe(false);
  }
});
it('remote-settable.json is the contract text; no remote path is denied; narrow ⊂ remote', () => {
  const r = JSON.parse(readFileSync(join(V1, 'remote-settable.json'), 'utf8'));
  expect(r).toEqual(REMOTE_SETTABLE);
  const under = (p: string, d: string) => p === d || p.startsWith(`${d}.`);
  for (const p of r.remote) expect(r.denied.some((d: string) => under(p, d)), p).toBe(false);
  for (const p of Object.keys(r.narrow)) expect(r.remote, p).toContain(p);
  for (const p of r.remote) expect(p).toMatch(new RegExp(PATH_PATTERN.replace('[a-z0-9][A-Za-z0-9-]', '(\\*|[a-z0-9][A-Za-z0-9-])')));
});
it('results: the P3 result fixtures pass strict; a config.get result with a denied settable entry still passes lenient (the server filters it)', () => {});
it('validateCommandArgs: what cams-admin sends for every P3 command', () => {
  expect(validateCommandArgs('config.set', { v: 1, dryRun: true, baseRevision: `sha256:${'a'.repeat(64)}`, set: { 'sse.pingS': 5 } })).toEqual({ ok: true });
  expect(validateCommandArgs('config.unset', { v: 1, dryRun: true, baseRevision: `sha256:${'a'.repeat(64)}`, paths: ['sse.pingS', 'sse.pingS'] })).toMatchObject({ ok: false });
  expect(validateCommandArgs('camera.action', { v: 1, camera: 'cam1', action: 'find-camera' })).toMatchObject({ ok: false }); // never sent
  expect(validateCommandArgs('camera.action', { v: 1, camera: null, action: 'retention-run' })).toEqual({ ok: true });
});
it('the new signed envelopes reproduce byte for byte (config.set command, its done result)', () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/contract.test.ts test/jcs.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `contract/build.ts` (inside `buildSchemas`, with its helpers):

```ts
  // --- P3: remote configuration (migration spec §8; "The P3 contract") ---------
  const rev: S = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const path: S = { type: 'string', pattern: PATH_PATTERN };
  const camId: S = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' };
  const leafValue: S = { anyOf: [bool, { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 }, { type: 'string', maxLength: 512 }] };
  const anyValue: S = { anyOf: [bool, num, { type: 'string', maxLength: 4096 }, { type: 'null' }] };
  const source = en(['default', 'file', 'override', 'env']);
  const restart = en(['restart', 'process']);
  const change = obj({ path, from: anyValue, to: anyValue, sourceFrom: source, sourceTo: source, restart }, ['path', 'sourceFrom', 'sourceTo'], ['from', 'to', 'restart']);
  const writeOk = (extra: Record<string, S> = {}, req: string[] = []) => obj({ dryRun: bool, baseRevision: rev, revision: rev, changes: arr(change, 128), unchanged: arr(path, 64), ...extra }, ['dryRun', 'baseRevision', 'revision', 'changes'], ['unchanged', ...Object.keys(extra).filter((k) => !req.includes(k))]);
  const pathState = obj({ v: anyValue, s: source }, ['s'], ['v']);
  const configFailed = obj({ paths: arr(obj({ path: str(200), code: str(64), detail: str() }, ['path', 'code'], ['detail']), 128) }, ['paths']);
  const configConflict = obj({ revision: rev, current: { type: 'object', propertyNames: { pattern: PATH_PATTERN }, additionalProperties: pathState, maxProperties: 128 } }, ['revision', 'current']);
  const settable = obj({ type: en(['integer', 'boolean', 'string']), min: num, max: num, oneOf: arr(int(), 64), enum: arr(str(64), 64), pattern: str(400), optional: bool, dir: en(['less', 'more']) }, ['type'], ['min', 'max', 'oneOf', 'enum', 'pattern', 'optional', 'dir']);
  const viewPath = obj({ v: anyValue, s: source, r: restart, p: bool, n: anyValue, by: obj({ cmdId, actor: str(), at: int() }, ['cmdId', 'actor', 'at']) }, ['s'], ['v', 'r', 'p', 'n', 'by']);
  const args = {
    'config.get': obj({ v: { const: 1 } }, ['v']),
    'config.set': obj({ v: { const: 1 }, dryRun: bool, baseRevision: rev, set: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: { pattern: PATH_PATTERN }, additionalProperties: leafValue } }, ['v', 'dryRun', 'baseRevision', 'set']),
    'config.unset': obj({ v: { const: 1 }, dryRun: bool, baseRevision: rev, paths: arr(path, 64, { minItems: 1, uniqueItems: true }) }, ['v', 'dryRun', 'baseRevision', 'paths']),
    'config.rollback': obj({ v: { const: 1 }, dryRun: bool, cmdId }, ['v', 'dryRun', 'cmdId']),
    'camera.action': {
      ...obj({ v: { const: 1 }, camera: nullable(camId), action: strict ? { type: 'string', enum: [...REMOTE_ACTIONS] } : str(32), input: obj({ kind: str(32, { minLength: 1 }), camera: bool }, ['kind'], ['camera']) }, ['v', 'camera', 'action'], ['input']),
      if: { properties: { action: { const: 'retention-run' } }, required: ['action'] }, then: { properties: { camera: { type: 'null' } } }, else: { properties: { camera: camId } },
    },
    'camera.name.set': obj({ v: { const: 1 }, camera: camId, name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } }, ['v', 'camera', 'name']),
    'proxy.restart': obj({ v: { const: 1 } }, ['v']),
  };
  const results = {
    'config.get': obj({ revision: rev, schema: int(), cameras: arr(camId, 256), omittedCameras: arr(camId, 256),
      paths: { type: 'object', propertyNames: { pattern: PATH_PATTERN }, additionalProperties: viewPath, maxProperties: 4096 },
      settable: { type: 'object', additionalProperties: settable, maxProperties: 512 } }, ['revision', 'paths', 'settable'], ['schema', 'cameras', 'omittedCameras']),
    'config.set': { anyOf: [writeOk(), configFailed, configConflict] },
    'config.unset': { anyOf: [writeOk(), configFailed, configConflict] },
    'config.rollback': { anyOf: [writeOk({ of: cmdId }, ['of']), configFailed, configConflict] },
    'camera.action': obj({ action: str(32), camera: nullable(camId), httpStatus: int(100), answer: nullable({ type: 'object' }), clamped: bool, verified: bool, mismatch: arr(str(64), 32) }, ['action', 'camera', 'httpStatus', 'answer'], ['clamped', 'verified', 'mismatch']),
    'camera.name.set': obj({ camera: camId, requested: str(64), name: str(64), verified: bool }, ['camera', 'requested', 'name', 'verified']),
    'proxy.restart': obj({ restartAt: int() }, ['restartAt']),
  };
```

and register `commands/<name>.args` / `commands/<name>.result` for each (as `tokens.apply`'s). Exports outside `buildSchemas`: `NEVER_REMOTE_ACTIONS`, `DISRUPTIVE_ACTIONS`, `P3_COMMANDS`, `PATH_PATTERN = '^[a-z][A-Za-z0-9]{0,31}(\\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$'`, `REMOTE_SETTABLE` (the contract's lists verbatim). `make.ts`: write `v1/remote-settable.json` = `REMOTE_SETTABLE`; add the fixtures of the contract table with the P2 helpers (`command(seq, name, args)`, `ctx({...})`, `refused(...)`, `signed(...)`) — e.g.

```ts
const REV = `sha256:${'a'.repeat(64)}`;
const journal = (n: number, command: string, action?: string) => Array.from({ length: n }, (_, i) => ({ cmdId: `cmd_${String(i).padStart(20, '0')}`, command, at: NOW - (i + 1) * 60_000, ...(action ? { action } : {}) }));
'valid-command-config-set': { $note: 'a dry run of one setting', schema: 'command', $context: ctx({ allow: ['config.set'] }), message: command(3, 'config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': 5 } }) },
'refused-proxy-restart-budget': refused('command', 'rate_limited', command(3, 'proxy.restart', { v: 1 }), ctx({ allow: ['proxy.restart'], journal: journal(2, 'proxy.restart') }), 'two restarts within the hour (the journal budget)'),
'refused-camera-action-budget': refused('command', 'rate_limited', command(3, 'camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' }), ctx({ allow: ['camera.action:camera-reboot'], journal: journal(6, 'camera.action', 'camera-reboot') }), 'six disruptive actions within the hour'),
'refused-camera-action-never-remote': refused('command', 'not_allowed', command(3, 'camera.action', { v: 1, camera: 'cam1', action: 'find-camera' }), ctx({ allow: [...ALLOW_ENTRIES] }), 'never remote, whatever the allow-list'),
```

(`$expect.strict: 'invalid'` is **not** used for the starred ones: the `command` envelope schema passes; their args fail `commands/<name>.args`, which the test above pins.) The result fixtures are signed with `PROXY` as in P2. `make-vectors.ts`: append two `envelopes` entries (`kind: 'command'`, a `config.set`; `kind: 'result'`, its `done` with `{dryRun: false, baseRevision, revision, changes: [{path: 'sse.pingS', from: 30, to: 5, sourceFrom: 'default', sourceTo: 'override'}], unchanged: []}`); `git diff contract/v1/vectors.json` shows only the two added entries. `server/contract.ts`: compile every `strict/commands/<name>.args` once; `validateCommandArgs` = schema + (for `config.unset`) uniqueness is in the schema, (for all) `Buffer.byteLength(jcs(args)) ≤ 16384`, (for `camera.action`) `action ∉ NEVER_REMOTE_ACTIONS`; `validateResultPayload` compiles the lenient `commands/<name>.result`. `contract/README.md`: a "Remote configuration (P3)" section: the changed steps 8, 9, 11; the outcomes table; `remote-settable.json` as the upper bound; `$context.journal`; the `pending` rule.
- [ ] **Step 4: Run** `npm run contract:make && npx vitest run test/contract.test.ts test/jcs.test.ts test/conformance.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add contract server/contract.ts scripts/contract/make-vectors.ts test/contract.test.ts test/jcs.test.ts
git commit -m "feat(contract): P3 commands' args and results, remote-settable upper bound, fixtures, vectors"
```

---

### Task 2: The reference proxy and the cross-check

**Files:**
- Modify: `test-client/commands.ts`, `test-client/client.ts`, `scripts/contract/cam-proxy-commands.ts`, `test/contract-commands.test.ts`, `test/test-client.test.ts`
- Create: `test-client/config.ts`

**Interfaces:**
- Produces:
  - `refCheck` gains P3: `CheckContext.journal?: { cmdId: string; command: string; at: number; action?: string }[]` used for step 11 (the reference implements step 11's journal budget; step 9 stays cam-proxy's), `IMPLEMENTED` = P2's + `P3_COMMANDS`.
  - `test-client/config.ts`: `class RefProxyConfig { constructor(o?: { cameras?: string[]; settings?: Record<string, unknown>; envHeld?: string[] }); revision(): string; handle(command: string, args: any, cmd: { cmdId: string; actor: string }): { status: 'ok' | 'failed' | 'conflict'; code?: string; result?: object }; localEdit(set: Record<string, unknown>): void; current(path: string): unknown; actions: { calls: { action: string; camera: string | null }[] } }` — written from the contract text: the remote list from `REMOTE_SETTABLE`, path checks in the contract's order, `jcs`-based revision of its overrides, backups by `cmdId`, path-level rollback, narrow rules, `camera.action` answering `{httpStatus: 200, answer: {ok: true}}` (with `verified: true` for the camera writes), `camera.name.set` echoing, `proxy.restart` answering `restartAt`. Default settings: `sse.pingS: 30`, `sse.maxClients: 20`, `stills.quality: 5`, `retention.auditDays: 90`, `analytics.googleVision.monthlyLimit: 1000`, `cameras.<id>.name`, plus the denied `cameras.<id>.host: '192.0.2.10'` and `camsAdmin.url`, and an env-held `ftp.publicHost`.
  - `ProxyClient` option `commands.config?: RefProxyConfig`: answers P3 commands through it (and reports `configRevision` in its heartbeat from it); without it a P3 command is answered `failed not_implemented` (an old proxy).
  - `scripts/contract/cam-proxy-commands.ts`: a fixture whose `body.command` is not in cam-proxy's `IMPLEMENTED` prints `pending <name>` and does not fail; it passes `journalBudget: journalBudgetOf(...)` when cam-proxy exports it (`require(file('src/fleet/command-check.ts')).journalBudgetOf`), and the P3 `$context.journal`.

- [ ] **Step 1: Failing tests:** `test/contract-commands.test.ts` already loops over every proxy fixture (the new ones included) → the P3 ones fail until the reference knows them; add `test/test-client.test.ts` cases for `RefProxyConfig`: dry run writes nothing; apply bumps the revision; a stale `baseRevision` → `conflict` with `current`; `cameras.cam1.host` → `failed not_remote_settable`; `cameras.nosuch.name` → `unknown_camera`; `ftp.publicHost` (env-held, but denied first) → `not_remote_settable`; `monthlyLimit` up → `widening_local_only`; rollback restores; after `localEdit` of the same path → `conflict`; second rollback → `already_rolled_back`.
- [ ] **Step 2: Run** `npx vitest run test/contract-commands.test.ts test/test-client.test.ts` → FAIL.
- [ ] **Step 3: Implement** (no cam-proxy code imported; `server/crypto/jcs` and `contract/build` only).
- [ ] **Step 4: Run** → PASS; `scripts/contract/cam-proxy-check.sh` → passes, listing the P3 fixtures as `pending` against cam-proxy `main`.
- [ ] **Step 5: Commit**

```bash
git add test-client scripts/contract/cam-proxy-commands.ts test/contract-commands.test.ts test/test-client.test.ts
git commit -m "test(contract): reference proxy for the P3 commands; cross-check reports pending fixtures"
```

**→ PR A ends here** ("contract: remote configuration"). Merge; cam-proxy plan Task 1 (vendor) the same day.

---

### Task 3: Migration N (`proxy_config`) and the Commands service for every wire command

**Files:**
- Modify: `server/db/migrations.ts`, `server/commands/service.ts`, `server/commands/envelope.ts` (none if it passes args through), `test/db.test.ts`, `test/commands.test.ts`, `server/backup/snapshot.ts` / `scripts/backup/restore-check.ts` (if they list tables)

**Interfaces:**
- Produces:
  - Migration **N** (the next free number, R: Global Constraints):

```ts
  // N: phase 3, the last reported configuration per proxy (migration spec §5, §8.1).
  (db) => db.exec(`
CREATE TABLE proxy_config (
  proxy_id TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  revision TEXT NOT NULL CHECK (revision GLOB 'sha256:*' AND length(revision) = 71),
  view TEXT NOT NULL CHECK (length(view) <= 262144),
  cmd_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
) STRICT;
-- R3-15: a real write names the dry run it was made from; each dry run is used once.
ALTER TABLE commands ADD COLUMN preview_of TEXT;
CREATE UNIQUE INDEX commands_preview_of ON commands(preview_of) WHERE preview_of IS NOT NULL;
`),
```

  - `export type WireCommand = 'tokens.apply' | 'config.get' | 'config.set' | 'config.unset' | 'config.rollback' | 'camera.action' | 'camera.name.set' | 'proxy.restart';`
  - `requiredEntries('camera.action', args)` = `[\`camera.action:${args.action}\`]`; others `[command]` (tokens.apply unchanged).
  - `summariseArgs`: `config.set` → `{v, dryRun, baseRevision: first 15 chars, set: {path: clamp(value, 200)}}`; `config.unset` → `{v, dryRun, paths}`; `config.rollback` → `{v, dryRun, cmdId}`; `camera.action` → `{v, camera, action, input?}`; `camera.name.set` → `{v, camera, name}`; `proxy.restart` → `{v}`.
  - `Commands.create(actor, accountId, proxyId, command, args, meta?: { reason?: string; revocationOnly?: boolean; previewOf?: string })` sets `dry_run = 1` when `args.dryRun === true` and `preview_of` from `meta.previewOf` (a unique-index violation → 409 `preview_used`); `CommandRow.dryRun: boolean`, `CommandRow.previewOf: string | null`; `Commands.hasOpen(proxyId: string, command: WireCommand): boolean`; `Commands.getRaw(accountId, proxyId, cmdId): CommandRow & { rawArgs: Record<string, unknown> }` (for the preview copy; never served); `Commands.usedPreview(previewId): boolean`.
  - **A `conflict` result keeps its name:** `onMessage` stores `outcome_code = b.code ?? (b.status === 'conflict' ? 'conflict' : null)` (state `failed` as R2-13 says), so the UI and `ProxyConfig` tell a conflict from a failure.

- [ ] **Step 1: Failing tests:** `test/db.test.ts`: fresh db has `proxy_config`; a db at version N−1 migrates; deleting a proxy deletes its row; a view over 256 KiB is refused by the CHECK. `test/commands.test.ts` (test client with `commands: { allow: ['config.get', 'config.set', 'camera.action:camera-test'], config: new RefProxyConfig() }`): `create('config.get')` ends `done` with the view in `result`; `camera.action` with `camera-reboot` → 409 `not_allowed_on_proxy` (entry missing), with `camera-test` → done; `config.set` dry run row has `dryRun: true`; the args summary never holds more than 200 characters per value; the P2 tests stay green.
- [ ] **Step 2: Run** `npx vitest run test/db.test.ts test/commands.test.ts` → FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `npx vitest run test/db.test.ts test/commands.test.ts test/tokens.test.ts test/write-budget.test.ts test/backup.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/db/migrations.ts server/commands test/db.test.ts test/commands.test.ts
git commit -m "feat(db, commands): proxy_config; every wire command through the Commands service"
```

---

### Task 4: `ProxyConfig` — views, previews, apply by preview id, rollback

**Files:**
- Create: `server/config/service.ts`, `server/config/narrow.ts`, `test/proxy-config.test.ts`
- Modify: `server/status/store.ts` (hook), `server/server.ts` (wiring)

**Interfaces:**
- Consumes: `Commands.create/onFinal/hasOpen/getRaw` (Task 3), `StatusStore.row(proxyId)?.reported` (`capabilities`, `commands`, `configRevision`), `validateResultPayload`, `sanitize`, `REMOTE_SETTABLE`.
- Produces:

```ts
export interface ConfigPath { v?: unknown; s: 'default' | 'file' | 'override' | 'env'; r?: 'restart' | 'process'; p?: true; n?: unknown; by?: { cmdId: string; actor: string; at: number } }
export interface Settable { type: 'integer' | 'boolean' | 'string'; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }
export interface ConfigView { revision: string; schema: number | null; cameras: string[]; omittedCameras: string[]; paths: Record<string, ConfigPath>; settable: Record<string, Settable>; fetchedAt: number; cmdId: string }
export interface ConfigState { view: ConfigView | null; reportedRevision: string | null; changedOnProxy: boolean; fetching: string | null; allow: string[] }
export type ConfigInput = { set: Record<string, boolean | number | string> } | { unset: string[] };

export class ProxyConfig {
  constructor(d: { db: Db; clock: Clock; registry: Registry; commands: Commands; status: StatusStore; live: LiveHub; log: Logger });
  state(accountId: string, proxyId: string): ConfigState;
  refresh(actor: string, accountId: string, proxyId: string): { commandId: string };                       // 409 already_fetching
  preview(actor: string, accountId: string, proxyId: string, input: unknown): { commandId: string };       // dry-run config.set / config.unset
  apply(actor: string, accountId: string, proxyId: string, previewId: unknown): { commandId: string };     // R3-15
  rollbackPreview(actor: string, accountId: string, proxyId: string, cmdId: string): { commandId: string };
  rollbackApply(actor: string, accountId: string, proxyId: string, previewId: unknown): { commandId: string };
  onHeartbeat(proxyId: string): void;   // R3-17 (a), (b); never writes by itself
  tick(): void;                          // retries a deferred automatic refresh
}
```

`server/config/narrow.ts`: `patternOf(path)`, `isRemoteSettable(path: string, settable: Record<string, Settable>): boolean` (pattern ∈ `REMOTE_SETTABLE.remote` ∩ `Object.keys(settable)`), `narrowingOk(path, from, to)` (the contract rule; 0 = no cap for the two caps).

- [ ] **Step 1: Failing tests** (`test/proxy-config.test.ts`, server + test client with `RefProxyConfig`, `allow: ['config.get', 'config.set', 'config.unset', 'config.rollback']`, fake clock where noted):

```ts
it('a proxy that allows config.get is read once; the view is stored; a second heartbeat with the same revision writes nothing', async () => {
  await until(() => s.config.state(acc, prx).view !== null);
  const writes = countWrites(() => heartbeats(5));
  expect(writes).toBe(0);
});
it('a local edit (new configRevision in the heartbeat) → one automatic config.get within the minute cap; changedOnProxy meanwhile', async () => {
  ref.localEdit({ 'sse.pingS': 9 });
  await until(() => s.config.state(acc, prx).changedOnProxy);
  await until(() => s.config.state(acc, prx).view?.paths['sse.pingS'].v === 9);
});
it('preview → done dry run with the diff; apply(previewId) → the proxy changed; a re-read follows', async () => {
  const p = s.config.preview(ACTOR, acc, prx, { set: { 'sse.pingS': 7 } });
  const done = await final(p.commandId);
  expect(done).toMatchObject({ state: 'done', dryRun: true, result: { changes: [{ path: 'sse.pingS', from: 30, to: 7 }] } });
  const a = s.config.apply(ACTOR, acc, prx, p.commandId);
  await final(a.commandId);
  expect(ref.current('sse.pingS')).toBe(7);
  await until(() => s.config.state(acc, prx).view?.paths['sse.pingS'].v === 7);
});
it('Review Focus 1: apply without a matching preview is refused and creates no command', () => {
  expect(() => s.config.apply(ACTOR, acc, prx, 'cmd_0123456789ABCDEFGHJK')).toThrow(/preview_required/);
  // a preview by another sysadmin → preview_required; a preview older than 10 min (fake clock) → preview_stale;
  // a preview whose baseRevision is no longer the stored view's (after a local edit and re-read) → preview_stale;
  // the same preview twice → preview_used; a failed or conflict dry run → preview_required
});
it('R3-16: a path outside remote-settable ∩ settable is 400 not_remote_settable before any command; a narrow path widened is 400 widening_local_only', () => {
  for (const set of [{ 'cameras.cam1.host': '192.0.2.9' }, { 'camsAdmin.url': 'https://x.example' }, { 'server.port': 1 }, { 'nosuch.x': 1 }])
    expect(() => s.config.preview(ACTOR, acc, prx, { set }), JSON.stringify(set)).toThrow(/not_remote_settable/);
  expect(() => s.config.preview(ACTOR, acc, prx, { set: { 'analytics.googleVision.monthlyLimit': 5000 } })).toThrow(/widening_local_only/);
  expect(countCommands()).toBe(before);
});
it('Review Focus 2: a local edit between preview and apply → preview_stale once re-read; if the apply already went out → conflict, the view re-read, the local value kept', async () => {});
it('Review Focus 3: a hostile view (10 000 paths, 1 MiB strings, __proto__, a settable entry for camsAdmin.url) is clamped, ≤ 256 KiB, and camsAdmin.url is not editable', async () => {
  client.overrideConfigGetResult = hostileView();
  await s.config.refresh(ACTOR, acc, prx) && until(() => s.config.state(acc, prx).view !== null);
  const st = s.config.state(acc, prx);
  expect(Buffer.byteLength(JSON.stringify(st.view))).toBeLessThanOrEqual(262144);
  expect(Object.keys(st.view!.settable)).not.toContain('camsAdmin.url');
  expect(Object.getPrototypeOf(st.view!.paths)).toBe(Object.prototype);
});
it('Review Focus 5: rollback only of a real write of this proxy; a conflict answer names the paths changed since', async () => {
  // a dry-run row, a conflict row, a failed row, a config.get row, another proxy's and another account's row → 409 not_rollbackable / 404
  // rollbackPreview → dry run diff; rollbackApply(previewId) → restored; after ref.localEdit of the same path → the proxy answers conflict, shown with current
});
it('no config.get is queued for a proxy that doesn\'t allow it, or while one is open; automatic ones at most once a minute (fake clock)', () => {});
it('write budget: 20 proxies heartbeating an hour with a stable revision → zero writes from ProxyConfig', () => {});
it('secret guard: a marker in the fake proxy\'s environment never reaches proxy_config, commands or the audit log', () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/proxy-config.test.ts` → FAIL.
- [ ] **Step 3: Implement** `server/config/service.ts`. The core pieces:

```ts
const PREVIEW_MAX_AGE_MS = 10 * 60_000;
const AUTO_EVERY_MS = 60_000;
const MAX_VIEW_BYTES = 262_144;

  preview(actor: string, accountId: string, proxyId: string, input: unknown): { commandId: string } {
    const st = this.state(accountId, proxyId);
    if (!st.view) throw new ApiError(409, 'no_view');
    const parsed = parseInput(input); // 400 invalid: {set: {path: leaf}} (1–64) or {unset: [path]} (1–64, unique)
    const paths = 'set' in parsed ? Object.keys(parsed.set) : parsed.unset;
    for (const p of paths) if (!PATH_RE.test(p) || !isRemoteSettable(p, st.view.settable)) throw new ApiError(400, 'not_remote_settable', p);
    if ('set' in parsed) for (const [p, v] of Object.entries(parsed.set)) if (!narrowingOk(patternOf(p), st.view.paths[p]?.v, v)) throw new ApiError(400, 'widening_local_only', p);
    const base = { v: 1, dryRun: true, baseRevision: st.view.revision };
    const row = 'set' in parsed
      ? this.d.commands.create(actor, accountId, proxyId, 'config.set', { ...base, set: parsed.set })
      : this.d.commands.create(actor, accountId, proxyId, 'config.unset', { ...base, paths: parsed.unset });
    return { commandId: row.id };
  }

  apply(actor: string, accountId: string, proxyId: string, previewId: unknown): { commandId: string } {
    if (typeof previewId !== 'string') throw new ApiError(400, 'invalid', 'previewId');
    const pv = this.d.commands.getRaw(accountId, proxyId, previewId); // 404 for another proxy's or account's
    if (!['config.set', 'config.unset'].includes(pv.command) || !pv.dryRun || pv.state !== 'done' || pv.actor !== actor) throw new ApiError(409, 'preview_required');
    if (this.d.clock.now() - (pv.finishedAt ?? 0) > PREVIEW_MAX_AGE_MS || pv.rawArgs.baseRevision !== this.state(accountId, proxyId).view?.revision) throw new ApiError(409, 'preview_stale');
    if (this.d.commands.usedPreview(previewId)) throw new ApiError(409, 'preview_used');
    const row = this.d.commands.create(actor, accountId, proxyId, pv.command as WireCommand, { ...pv.rawArgs, dryRun: false }, { reason: `apply ${previewId}`, previewOf: previewId });
    return { commandId: row.id };
  }
```

Single use rests on the database: the real write is created with `meta.previewOf = previewId`, and the unique index `commands_preview_of` refuses a second one (409 `preview_used`, also across restarts and two sysadmins racing). `rollbackPreview(cmdId)`: the target row must be R3-21 rollbackable (409 `not_rollbackable` otherwise) → `config.rollback {v: 1, dryRun: true, cmdId}`; `rollbackApply(previewId)` = the `apply` rules for a `config.rollback` dry run (no `baseRevision` check: rollback is path-level, R3-5). `onFinal`: `config.get` `done` → `storeView` (lenient `validateResultPayload`, `sanitize`, drop `paths` keys failing `PATH_RE` and `settable` keys outside `REMOTE_SETTABLE.remote`, build with `Object.create(null)`-free plain objects via `Object.fromEntries`, cap `paths` at 4096 entries, refuse to store when the JSON exceeds 256 KiB (log `config_view_too_large`, keep the old view), write only when `revision` or the JSON differs, `publishRegistry('proxy', id)`); a final `config.set`/`unset`/`rollback` with `dryRun: false` (`done`) or `conflict` → `autoRefresh(proxyId)`. `onHeartbeat(proxyId)`: when the reported `commands.allow` includes `config.get`, the proxy is live with `commands`, and (no view **or** `reported.configRevision !== view.revision`) → `autoRefresh`. `autoRefresh`: skip while `hasOpen(proxyId, 'config.get')`, or within `AUTO_EVERY_MS` of the last automatic one (then `tick()` retries), else `create('system', …, 'config.get', {v: 1})` (a 409 from the pre-checks is logged at debug and dropped). `state().changedOnProxy` = `view && reported.configRevision && reported.configRevision !== view.revision`.
- [ ] **Step 4: Run** `npx vitest run test/proxy-config.test.ts test/commands.test.ts test/write-budget.test.ts test/status.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/config server/status/store.ts server/server.ts test/proxy-config.test.ts test/write-budget.test.ts
git commit -m "feat(config): proxy settings views, previews, apply by preview id, rollback"
```

---

### Task 5: `RemoteActions` — camera actions, rename, proxy restart

**Files:**
- Create: `server/actions/service.ts`, `test/remote-actions.test.ts`
- Modify: `server/server.ts`

**Interfaces:**
- Produces:

```ts
export class RemoteActions {
  constructor(d: { registry: Registry; commands: Commands; status: StatusStore; clock: Clock });
  cameraAction(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string };   // {camera, action, input?, confirm?}
  rename(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string };         // {camera, name}
  restart(actor: string, accountId: string, proxyId: string, body: unknown): { commandId: string };        // {confirm: 'proxy.restart'}
  available(accountId: string, proxyId: string): { actions: { action: string; disruptive: boolean; allowed: boolean }[]; rename: boolean; restart: boolean; cameras: string[] };
}
```

- Body rules: `action` ∈ `REMOTE_ACTIONS` (400 `invalid`, `field: 'action'`; a never-remote name is 400 too — cams-admin never sends one); `camera` a camera id, `null` only for `retention-run`; `input` only for `inventory`; disruptive actions need `confirm === action`, `restart` needs `confirm === 'proxy.restart'` (400 `confirm_required`); the pre-checks of `Commands.create` (capability, pause, entry) apply; a double click is two requests and two commands (the proxy's budgets bound them; the UI disables the button while one is open — `hasOpen(proxyId, 'camera.action')` → 409 `busy` for the **same** camera and action within 10 s, tracked in memory).
- [ ] **Step 1: Failing tests** (`test/remote-actions.test.ts`, test client with `RefProxyConfig`): `camera-test` with the entry → done, result shown; `camera-reboot` without `confirm` → 400 `confirm_required`, with it and the entry → done; without the entry → 409 `not_allowed_on_proxy`; `find-camera` → 400; `restart` with `camera: null` → 400; a proxy answering `rate_limited` with `retryAfterS: 3000` → the row is `refused`, `retryAfterS` 3000 (Review Focus 4); `rename` → done with `verified`; `restart` → done; `available()` marks disruptive ones and reflects the reported allow-list; another account's proxy → 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run test/remote-actions.test.ts test/commands.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/actions server/server.ts test/remote-actions.test.ts
git commit -m "feat(actions): camera actions, rename and proxy restart as confirmed commands"
```

---

### Task 6: API routes

**Files:**
- Modify: `server/api/router.ts`, `test/api-audit-completeness.test.ts`, `test/api.test.ts`
- Create: `test/api-config.test.ts`

**Interfaces:**
- Produces (sysadmin session, CSRF, write limiter, as every write route):
  - `GET  /accounts/:a/proxies/:p/config` → `ConfigState`
  - `POST /accounts/:a/proxies/:p/config/refresh` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/config/preview` `{set} | {unset}` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/config/apply` `{previewId}` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/config/rollback/preview` `{cmdId}` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/config/rollback/apply` `{previewId}` → 202 `{commandId}`
  - `GET  /accounts/:a/proxies/:p/actions` → `RemoteActions.available()`
  - `POST /accounts/:a/proxies/:p/actions` `{camera, action, input?, confirm?}` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/cameras/:camera/name` `{name}` → 202 `{commandId}`
  - `POST /accounts/:a/proxies/:p/restart` `{confirm}` → 202 `{commandId}`
  - Errors: 400 `invalid` / `not_remote_settable` / `widening_local_only` / `confirm_required`; 404; 409 `no_view` / `already_fetching` / `preview_required` / `preview_stale` / `preview_used` / `not_rollbackable` / `busy` / the P2 pre-check codes; 429.
- [ ] **Step 1: Failing tests** (`test/api-config.test.ts`): every route's happy path and its error codes; no route accepts a GET-with-body or query args as input; the completeness table gains the six write routes with `action: ['command-create']`; the SSE stream and `/audit` never carry more than 200 characters of a setting value; another account's proxy id in the URL → 404 on every route.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** next to the P2 command routes, with `res.locals.status = 202` (the `h()` helper honours it). **Step 4: Run** `npx vitest run test/api-config.test.ts test/api.test.ts test/api-audit-completeness.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/api/router.ts test/api-config.test.ts test/api.test.ts test/api-audit-completeness.test.ts
git commit -m "feat(api): proxy settings, previews, apply, rollback, camera actions and restart routes"
```

---

### Task 7: Web UI — Settings, Commands with diff and Roll back, camera actions

**Files:**
- Create: `web/src/lib/config.ts`, `web/src/lib/config.test.ts`, `web/src/components/ProxySettings.svelte`, `web/src/components/ProxyCameraActions.svelte`, `web/src/components/DiffTable.svelte`, `e2e/remote-config.spec.ts`
- Modify: `web/src/pages/Proxy.svelte` (tabs: Overview, Settings, Commands), `web/src/components/ProxyCommands.svelte`, `web/src/pages/Account.svelte` (camera row link), `web/src/lib/api.ts` (types), `e2e/server.ts` (a test-client proxy with `RefProxyConfig`)

**Interfaces:**
- Produces (`web/src/lib/config.ts`, pure, unit-tested):
  - `groupPaths(view: ConfigView): { group: string; camera?: string; rows: { path: string; label: string; p: ConfigPath; editable: boolean; why?: string }[] }[]` — groups as the proxy's Settings page (top-level key; cameras one group each); `editable` = `isRemoteSettable` and `s !== 'env'`; `why` = "set in the proxy's environment", "never remote (addresses, ports, files, trust, users)", "only lower from cams-admin", "only higher from cams-admin".
  - `parseValue(s: Settable, text: string): { ok: true; value: boolean | number | string } | { ok: false; error: string }` (bounds, `oneOf`, `enum`, `pattern`).
  - `dataLossHint(change): string | null` — "deletes older data at the proxy's next storage run" for a lower `retention.*Days` (except `auditDays`), a lower `storage.maxPercent`/`maxBytes`/`*maxGB`, or `keepHours` lowered; `null` otherwise.
  - `stateLine(row)`: `received` "sent, waiting for the proxy", `done` "applied", `conflict` "changed on the proxy since you loaded it", `refused rate_limited` "the proxy's limit: try again in N min".
- **Settings tab:** the policy line (P2 `commandsText`); if `config.get` isn't allowed: "Allow config.get on the proxy's own Status card to see its settings here." and nothing else; otherwise the grouped table (value, source chip, restart chip, "set by cams-admin" with actor), editable fields as typed inputs, a pending-changes bar (**Review changes** → preview → `DiffTable` with restart marks, data-loss hints and narrow notes → **Apply** / **Discard**), a "changed on the proxy" banner with **Reload** when `changedOnProxy`, and on a `conflict` result a per-path table "on the proxy now" | "your change" with **Use mine** (re-preview against the new view) / **Keep the proxy's** (discard).
- **Commands tab:** the P2 history plus, per P3 row: the args summary (paths → values, or camera + action), the result (`DiffTable` for config writes; `verified`/`mismatch` for camera writes), and **Roll back** on rollbackable rows (R3-21) → rollback preview diff → **Apply rollback**.
- **Overview tab:** today's content plus `ProxyCameraActions`: per camera (from `available().cameras`), the non-disruptive actions as buttons, then a "Disruptive" row (reboot, power-cycle, worker restart, FTP setup/off, NTP set, cert push) — each disabled with "not allowed on the proxy" unless allowed; a disruptive click opens `Confirm.svelte` with the effect sentence and a text field that must equal the action name; a **Rename** field (`camera.name.set`); **Restart proxy** in the proxy header under the same confirmation. Results appear inline (verified ✓ / mismatch keys / the proxy's code).
- [ ] **Step 1: Failing tests:** `web/src/lib/config.test.ts` (grouping, editability reasons, `parseValue` bounds, `dataLossHint` cases incl. `auditDays` never hinted); `e2e/remote-config.spec.ts` (Playwright, the e2e lock): open the proxy → Settings → change `sse.pingS` → Review shows `30 → 7` → Apply → row shows 7 and "set by cams-admin"; Commands → Roll back → diff `7 → 30` → Apply rollback → 30; a local edit on the reference proxy → "changed on the proxy" banner → Reload; a preview, then a local edit, then Apply → conflict table, **Use mine** re-previews; Overview → Camera actions: `camera-test` runs; `camera-reboot` is disabled until allowed, then asks for the typed confirmation; a 10 KiB string with `<script>` in a view value is rendered as text (no dialog, `page.content()` escapes it).
- [ ] **Step 2: Run** `npx vitest run web/src/lib/config.test.ts && npm run test:e2e -- e2e/remote-config.spec.ts` → FAIL.
- [ ] **Step 3: Implement** (Svelte 5 runes; existing `Confirm.svelte`, `StateChip.svelte`, `Ago.svelte`; live refresh on the registry/status SSE events for this proxy; command rows polled through the existing SSE `registry` event).
- [ ] **Step 4: Run** → PASS; `npm run check && npm run check:svelte`.
- [ ] **Step 5: Commit**

```bash
git add web/src e2e/remote-config.spec.ts e2e/server.ts
git commit -m "feat(ui): proxy settings with dry-run diff, conflicts, rollback; camera actions with confirmation"
```

**→ PR B ends here** (Tasks 3–7 and 9). Release cams-admin.

---

### Task 8: The local stack with real enrollment, and the two-proxy P3 check

Runs after cam-proxy PR B is on cam-proxy `main` (rollout step 5). The P2 plan's Task 10 (real `admin-enroll` instead of the bridge) has not shipped (`scripts/localstack/start.sh` still bridges); this task does it.

**Files:**
- Modify: `scripts/localstack/start.sh`, `scripts/localstack/setup.ts`, `scripts/localstack/lib.sh`, `docs/localstack.md`
- Create: `scripts/localstack/p3-check.ts`

**Interfaces:**
- Consumes: cams-admin API (session from `npm run dev:session`); cam-proxy's `admin-enroll` CLI (code on stdin), control API (`/control/admin/commands`, `/control/config`, `/control/admin/changes`), its audit API; cam-sim's control API (to read the camera's name and NTP server back).
- Produces: `start.sh` enrolls each proxy with the real `admin-enroll` when the cam-proxy worktree has `src/fleet/commands.ts` (else the bridge, `LOCALSTACK_BRIDGE=1` forces it); `beta-2`'s `config.json` gets `ntp: { server: '192.0.2.123' }`; each proxy's local admin token is in the run's secrets folder (mode 600, never printed). `npx tsx scripts/localstack/p3-check.ts` prints one line per check, exits non-zero on the first failure, and 2 when cam-proxy `main` has no P3 (`config.get` not in its implemented list).

- [ ] **Step 1: Write `p3-check.ts`** (127.0.0.1 only; `alpha-1` :29100 one camera, `beta-2` :29300 three cameras):

```ts
// The P3 two-proxy check (plan Task 8). Never anything but 127.0.0.1.
const checks: [string, () => Promise<void>][] = [
  ['both proxies report commands, no P3 entry allowed; the Settings API says so', async () => {
    for (const px of [A, B]) expect((await api('GET', cfgUrl(px))).allow).not.toContain('config.get');
    expect((await api('POST', `${cfgUrl(A)}/refresh`, {})).status).toBe(409);
  }],
  ['allow config.get on both with their LOCAL admin tokens → views arrive and equal the proxies\' own /control/config', async () => {
    for (const px of [A, B]) await proxyApi(px, 'PUT', '/control/admin/commands', { allow: ['config.get'] }, px.adminToken);
    for (const px of [A, B]) {
      await waitFor(async () => (await api('GET', cfgUrl(px))).view !== null);
      const mine = (await api('GET', cfgUrl(px))).view.paths;
      const theirs = await (await proxyApi(px, 'GET', '/control/config', undefined, px.adminToken)).json();
      for (const [p, e] of Object.entries<any>(theirs)) if (mine[p]) expect([mine[p].v, mine[p].s], p).toEqual([e.value, e.source]);
    }
  }],
  ['config.set on alpha-1: preview, apply, visible on the proxy with the marker, audited on both sides with the same cmdId', async () => {
    await proxyApi(A, 'PUT', '/control/admin/commands', { allow: ['config.get', 'config.set', 'config.rollback'] }, A.adminToken);
    const pv = await preview(A, { set: { 'sse.pingS': 7 } });
    expect(pv.result.changes).toEqual([expect.objectContaining({ path: 'sse.pingS', to: 7 })]);
    const ap = await applyPreview(A, pv.id);
    const cfg = await (await proxyApi(A, 'GET', '/control/config', undefined, A.adminToken)).json();
    expect(cfg['sse.pingS']).toMatchObject({ value: 7, source: 'override', by: { cmdId: ap.id } });
    expect((await proxyAudit(A, 'config-change')).some((x) => x.details?.cmdId === ap.id && x.user === 'cams-admin')).toBe(true);
    expect((await adminAudit('command-result')).some((x) => x.detail.cmdId === ap.id)).toBe(true);
    state.applied = ap.id;
  }],
  ['a local edit between preview and apply → preview_stale or conflict; the local value stays', async () => {
    const pv = await preview(A, { set: { 'sse.pingS': 8 } });
    await proxyApi(A, 'PUT', '/control/config', { sse: { pingS: 9 } }, A.adminToken);
    const r = await api('POST', `${cfgUrl(A)}/apply`, { previewId: pv.id });
    if (r.status === 202) expect(await finalOf(A, (await r.json()).commandId)).toMatchObject({ state: 'failed', outcomeCode: 'conflict' });
    else expect((await r.json()).error).toBe('preview_stale');
    expect((await (await proxyApi(A, 'GET', '/control/config', undefined, A.adminToken)).json())['sse.pingS'].value).toBe(9);
  }],
  ['rollback of the first change: the path changed locally since → conflict naming sse.pingS; after the local value is reset, rollback works; again → already_rolled_back', async () => {}],
  ['a denied path is refused by cams-admin before any command (400 not_remote_settable)', async () => {
    expect((await api('POST', `${cfgUrl(A)}/preview`, { set: { 'cameras.cam1.host': '192.0.2.9' } })).status).toBe(400);
  }],
  ['beta-2 (three cameras) still refuses config.set (not allowed there): 409 not_allowed_on_proxy', async () => {}],
  ['camera round trip on beta-2 against cam-sim: camera.name.set verified and read back from the cam-sim; set back', async () => {
    await proxyApi(B, 'PUT', '/control/admin/commands', { allow: ['config.get', 'camera.name.set', 'camera.action:camera-ntp-set'] }, B.adminToken);
    const cam = B.cameras[1];
    const r = await finalOf(B, (await (await api('POST', `${pxUrl(B)}/cameras/${cam.id}/name`, { name: 'p3 check' })).json()).commandId);
    expect(r).toMatchObject({ state: 'done', result: { verified: true, name: 'p3 check' } });
    expect(await camSimName(cam)).toBe('p3 check');
    await finalOf(B, (await (await api('POST', `${pxUrl(B)}/cameras/${cam.id}/name`, { name: cam.originalName })).json()).commandId);
  }],
  ['camera-ntp-set on beta-2 (disruptive: typed confirmation) → verified; the cam-sim\'s NTP server is 192.0.2.123', async () => {}],
  ['proxy.restart on beta-2: refused without confirm; with it → done before the process exits; the harness restarts it; a third restart within the hour is rate_limited', async () => {}],
  ['pause on alpha-1 (local) → preview 409 paused_on_proxy; resume (local)', async () => {}],
  ['CAMPROXY_TOKENS and the managed tokens still work on both proxies throughout', async () => {}],
];
```

`proxy.restart`: the harness watches the PID it recorded for `beta-2`; when it exits with code 0 it starts it again with the same command line (`restartProxy`, P2 helper), and the check waits for `/health`. Never `pkill`, never a name pattern.
- [ ] **Step 2:** `scripts/localstack/start.sh && npx tsx scripts/localstack/p3-check.ts` → every line `ok` (about 3 minutes).
- [ ] **Step 3:** `docs/localstack.md`: "The bridge" paragraph → "Enrollment" (real `admin-enroll`; `LOCALSTACK_BRIDGE=1`); a "The P3 check" section: what it proves, its runtime, and that it changes only local cam-sims and local proxies.
- [ ] **Step 4: Commit**

```bash
git add scripts/localstack docs/localstack.md
git commit -m "test(localstack): real cam-proxy enrollment; the two-proxy remote-configuration check with a cam-sim round trip"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md` (`## [Unreleased]`), `CLAUDE.md`, `contract/README.md` (if not done in Task 1)
- Create: none (no kube-setup request: P3 needs no cluster change)

- [ ] **Step 1:** `README.md`: "Remote configuration" section — what cams-admin can do to a proxy in P3, that every entry is allowed **on the proxy** (off by default), the remote-settable list's link, dry run → apply, conflicts, rollback, camera actions with confirmation, and the threat-model summary (a compromised cams-admin can change only remote-settable settings and allowed actions, never addresses/trust/users/`camsAdmin.*`, never raise Google Vision spending or shorten the audit log; every change is in the proxy's audit log and on its card with Undo; a local pause stops it). `CLAUDE.md`: "P3: settings changes go through preview → apply by preview id; never add a route that writes proxy settings without a preview" and "a new remote-settable setting goes into `contract/v1/remote-settable.json` first". `CHANGELOG.md`: the user-visible changes.
- [ ] **Step 2:** Full checks: `npm run lint:types && npm test && npm run build && npm run check && npm run check:svelte && scripts/contract/cam-proxy-check.sh && npm run test:e2e && npm audit --audit-level=high && scripts/backup/restore-test.sh` → green.
- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md contract/README.md
git commit -m "docs: remote configuration (P3)"
```

---

## Release and rollout order (both repos)

Each step is its own PR to `main`; merge only when every check passes; every step leaves the Pi and the cluster proxy working.

1. **cams-admin PR A — P3 contract** (Tasks 1–2). cam-proxy's `contract-drift` fails on cam-proxy PRs until step 2: same day. The cross-check lists the P3 fixtures `pending`.
2. **cam-proxy PR A — vendor** (cam-proxy plan Task 1). No behaviour change; no release.
3. **cams-admin PR B — remote configuration** (Tasks 3–7, 9). Release cams-admin (`main` → `production`). Safe: P2 proxies report no P3 entry, so every P3 control is disabled with "not allowed on the proxy"; migration N only adds a table.
4. **cam-proxy PR B** (cam-proxy plan Tasks 2–12). Release cam-proxy; the cluster proxy updates itself; the Pi is updated by the release owner. Nothing new runs until an entry is allowed locally. The cross-check now runs every P3 fixture against cam-proxy `main` (no `pending`).
5. **cams-admin PR C — local stack** (Task 8) against cam-proxy `main`, on the Mac.
6. **Cut-over steps 3–4** (M §11.4), with Klaus, cluster proxy first, then the Pi: allow `config.get` on the proxy's own card with its local admin token; compare the Settings tab with the proxy's Settings page; then allow `config.set`, `config.unset`, `config.rollback`; change `sse.pingS` (preview, apply), check both audit logs, roll it back. **Disruptive entries stay off on both production proxies until Klaus allows one locally.** Rollback of any step: pause on the card, or remove the entries. **P3 done** (M §15) when both proxies passed step 4, the classification test covers every setting (cam-proxy), and one camera action's re-read result was shown in cams-admin (the local stack's `camera.name.set`, or on a production proxy once Klaus allows a camera entry).

## kube-setup

No request. P3 uses the existing proxy channel and adds one table to the existing database; no new host, port, NetworkPolicy, Secret, env variable or volume.

## Self-review

- **Spec coverage:** M §5 `proxy_config` (Task 3); §7.1 contract (Task 1); §7.6 P3 commands on the wire (Tasks 1, 3); §7.8 server limit unchanged + previews count (Global Constraints); §7.9 audit on cams-admin's side (Tasks 3, 6, R3-19); §8.1 reading and its triggers (Task 4, R3-17); §8.2 the editor shows only remote-settable paths (Tasks 1, 4, 7, R3-16, R3-20); §8.3 no camera talk, re-read results shown (Tasks 5, 7); §8.4 dry run first, Apply, conflict shown with the local change (Tasks 4, 7, R3-15); §8.5 rollback from the Commands tab (Tasks 4, 7, R3-21); §8.6 remote actions, disruptive ones separate and confirmed (Tasks 5, 7, R3-18, Klaus's decision 3); §8.7 UI (Task 7); §12.1 (all files); §13.1 compromised cams-admin bounded by the proxy (cam-proxy plan) and here by the preview rule and the pre-checks; §13.3 secret guard (Task 4); §14.1 tests (Tasks 2–7); §14.2 contract and cross-check (Tasks 1–2); §14.3 two-proxy stack with a camera round trip (Task 8); §15 P3 (rollout step 6).
- **Placeholder scan:** test bodies left as one-line `it(...)` names in Tasks 4–6 and 8 state the exact assertion in their name next to fully written neighbours. The dashboard needs nothing new (the P2 policy chip stays; `changedOnProxy` shows on the Proxy page).
- **Type consistency:** `ProxyConfig.state/refresh/preview/apply/rollbackPreview/rollbackApply/onHeartbeat/tick`, `RemoteActions.cameraAction/rename/restart/available`, `Commands.hasOpen/getRaw`, `WireCommand`, `ConfigView/ConfigPath/Settable/ConfigState`, `RefProxyConfig.handle/localEdit/current/revision`, `isRemoteSettable/narrowingOk/patternOf` are used with the same names in Tasks 2–8.
