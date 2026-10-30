# The cams-admin proxy protocol, v1: the contract

This folder is the single written source of the wire format between
cam-proxy and cams-admin (spec
`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` §8, §15.4).
Both repositories test against it, so neither can change the payload alone.

| file | what |
|---|---|
| `v1/*.schema.json` | JSON Schema (draft 2020-12), **lenient**: what cams-admin accepts at run time. Unknown fields are ignored; health-summary enums are plain strings |
| `v1/strict/*.schema.json` | the same, **strict**: closed objects, every field required, enums enforced. For tests |
| `v1/commands/*.schema.json` | per-command `args` and `result` schemas (P2: `tokens.apply`; P3: the seven remote-configuration commands), lenient and in `v1/strict/commands/` |
| `v1/remote-settable.json` | P3: the upper bound of the settings any proxy may let cams-admin set (`remote`), the one-way paths (`narrow`) and what is never remote (`denied`) |
| `v1/fixtures/*.json` | `valid-*` (both accept), `invalid-*` (strict refuses; `$expect.runtime` is the receiver's answer), `drift-*` (the receiver accepts, strict refuses: the cases that catch drift), `refused-*` (strict accepts, the receiving proxy refuses with the nack code in `$expect.runtime`) |
| `v1/vectors.json` | fixed Ed25519 test keys, the exact signed strings with their signatures, canonical JSON (`jcs`) cases and signed envelopes (`envelopes`) |
| `build.ts`, `make.ts` | the source of the schemas and fixtures; `npm run contract:make` rewrites `v1/` |

## Rules

- Change `build.ts`, run `npm run contract:make`, commit the result. A test
  fails while the committed files differ from a fresh build.
- A new health-summary field in cam-proxy: add it here first (cams-admin PR),
  then vendor the new `v1/` into cam-proxy `test/contract/cams-admin-v1/`
  (with `SOURCE` = the cams-admin commit). cam-proxy's heartbeat test runs the
  strict schema, so the field can't ship unannounced; cams-admin's
  "every field is shown" test makes the dashboard show it.
- Text fields are at most 200 characters. The server clamps longer ones;
  the proxy must clamp before sending (strict refuses them).
- `seq` starts at 1 per connection and direction and increases by exactly 1.

## Signed strings (see `vectors.json`)

```
enroll:    "cams-admin enroll v1\n" + canonicalCode + "\n" + publicKey
challenge: "cams-admin/v1 challenge\n" + connId + "\n" + nonce + "\n" + serverTime
hello:     "cams-admin/v1 hello\n" + connId + "\n" + nonce + "\n" + proxyId + "\n" + keyId + "\n" + ts
```

`canonicalCode` is `CAE1-XXXX-XXXX-XXXX-XXXX-XXXX` (upper case; input
normalised: spaces and dashes dropped, `O`→`0`, `I`/`L`→`1`). Keys are
Ed25519: public as base64 SPKI DER (44 bytes), private as base64 PKCS#8 DER.
Signatures are base64 (64 bytes), in the envelope's `sig` for `challenge`
and `hello`.

## Commands (P2)

`command` (server → proxy), `result` and `event` (proxy → server) are signed
envelopes:

```
sig = base64(Ed25519(UTF-8(jcs(envelope without sig))))
```

`jcs` is RFC 8785 canonical JSON for what the protocol carries (the same
function is `server/crypto/jcs.ts` here and `src/fleet/jcs.ts` in cam-proxy;
`vectors.json` has the cases both must reproduce). The receiver canonicalises
the parsed message as received, unknown fields included, minus `sig`.
cams-admin's key signs commands; the proxy's enrolled key signs results and
events. Ed25519 is deterministic, so both sides reproduce the vectors'
signatures byte for byte.

Fixtures for the proxy side carry `$expect.receiver: "proxy"` (default:
the server) and a `$context`: `{now, proxyId, connId, serverKeys, allow,
paused, seen}`, what the receiving proxy knows (`now` is cams-admin time,
`seen` the envelope ids already seen on the connection).
`valid-command-tokens-apply` has a `$context` and no `$expect`: the proxy runs it.

The proxy's check order is normative (the plans' section "The P2 contract",
cams-admin `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`):
cmdId readable (else `error bad_message`) → signature (`bad_signature`) →
proxyId/connId (`wrong_target`) → envelope id unseen (`replayed`) → `exp`
(`expired`) → journal (`duplicate`) → paused/env switch (`paused`) → allowed
(`not_allowed`) → rate (`rate_limited`) → `args.v` (`unsupported_version`) and
args (`invalid_args`) → allow entries the args need (`not_allowed`) → busy.

**`revocationOnly`** (optional boolean in a `command` body; `tokens.apply`
only; added after the first P2 contract, backward compatible): the set only
removes tokens from the proxy's current managed set: every entry of
`args.tokens` is in the current set with the same `id`, `kind`, `hash`,
`label` and `retireAt`. The proxy verifies the claim at step 10 (a false
claim → `invalid_args`); a true claim skips the pause (step 7, but never the
env kill switch: `paused`), the allow-list (step 8) and the allow entries the
args need (step 11). A proxy that predates it ignores the field and treats
the command as a plain `tokens.apply`. Proxy fixtures carry the proxy's
current set in `$context.tokens` and the env switch in `$context.enabled`
(default true).

Uniqueness of `id` and `hash` inside `tokens.apply`'s `tokens` cannot be said
in JSON Schema: it is checked in code on both sides.

The heartbeat's `proxy` block gains three optional fields (`commands`,
`tokens`, `configRevision`), optional in strict too, so P1 heartbeats stay
valid. A P2 proxy announces `capabilities: ["status", "commands"]`.

## The proxy profile (heartbeat `profile`)

Additive (design: `docs/superpowers/specs/2026-10-25-proxy-profile-design.md`
§2): the heartbeat body gains an optional `profile` object, optional in strict
too, so a heartbeat without one (a proxy before cam-proxy 2026.10.26) stays
valid; `null` means the same as none. **Lenient** takes any object or null: cams-admin reads it with clamps and drops
an unreadable profile, never the heartbeat (`drift-heartbeat-profile-cameras-0`).
**Strict** is the closed shape, every field required:

| field | value |
|---|---|
| `set` | boolean: the person set the profile on the proxy (false: the defaults) |
| `name` | string 1..60, or null |
| `cameras` | integer 1..64: the most cameras the proxy holds |
| `storageGB` | integer 1..100000, or null (the `storage.*` budget applies) |
| `held` | integer 0..64: the cameras it holds now |
| `ftp` | `{enabled, port (1..65535), passive: {from, to} or null}` |
| `storage` | `{budgetBytes, usedBytes, diskBytes, freeBytes}`: integers ≥ 0 or null |
| `hardware` | `{pi: string or null, cpuCores 1..1024, cpuModel: string ≤ 100 or null, memoryBytes ≥ 0, load5 ≥ 0, cpuTempC: number or null}`, as seen by cam-proxy |
| `warnings` | unique items of `profile_ftp_ports`, `profile_cameras_exceeded` (`PROFILE_WARNINGS`) |
| `firewall` | `{tool: ufw or nft (FIREWALL_TOOLS), lines: at most 64 strings of ≤ 200 characters}` |
| `tls` | **optional** (added later; a proxy before it sends none): the proxy's site CA, `{site: string (the site pattern) or null, cameraSubnet: CIDR or null}`, closed in strict, both keys required there. `cameraSubnet` is the camera subnet the site CA issues camera certificates for: an IPv4 CIDR (`a.b.c.d/0..32`) or an IPv6 one (`/0..128`), at most 49 characters (`CIDR_PATTERN`) |

Fixtures: `valid-heartbeat-profile` (set, FTP on, firewall lines),
`valid-heartbeat-profile-unset` (the defaults, FTP off), `valid-heartbeat-profile-null`,
`valid-heartbeat-profile-tls` (a site CA covering `192.0.2.0/28`), `valid-heartbeat-profile-tls-none`
(both null), `drift-heartbeat-profile-tls-bad-subnet` (run time reads the subnet as null; strict refuses).
cams-admin's move precheck `ca_covers_camera` (after `site_ca`) refuses a camera whose registry host is an
IPv4 literal outside the target's `tls.cameraSubnet` (reason `ca_does_not_cover_camera`); it passes when
the target reports no subnet or the host is no IPv4 literal. The firewall lines
hold camera LAN addresses: never logged on either side. cams-admin never sets
the profile (it holds the storage budget).

## Move leftovers (heartbeat `moveLeftovers`)

Additive: the heartbeat body gains an optional `moveLeftovers` (also when
truncated; `null` = none): what a proxy could not clean up itself after a camera
moved away (cam-proxy's capabilities design §7). **Strict:** an array of at most
16 (`MOVE_LEFTOVERS_MAX`) closed `{camera, moveId, items}`: `camera` a proxy
camera id, `moveId` an `mv_` id, `items` 1..4 strings (`MOVE_LEFTOVER_ITEMS_MAX`)
of 1..80 characters (`MOVE_LEFTOVER_ITEM_LEN`). **Lenient:** anything; cams-admin
reads it with clamps (16 entries, 4 items, 80 characters) and drops what it
can't read, never the heartbeat. The item forms cam-proxy sends:
`config.json entry`, `env CAMPROXY_CAMERA_PASSWORD_<ID>` and
`env CAMPROXY_CAMERA_PASSWORD_<ID>_FILE`. cams-admin shows them in
`/api/v1/diag/proxies` (`reported.moveLeftovers`) and on the Diagnostics page.

Fixtures: `valid-heartbeat-move-leftovers`, `valid-heartbeat-move-leftovers-null`,
`drift-heartbeat-move-leftovers-long` (five items: run time keeps four; strict refuses).

## Remote configuration (P3)

Additive: the envelope stays v1, the subprotocol `cams-admin.v1`, signatures
and JCS unchanged; no new message type and no new heartbeat field. P3
implements `config.get`, `config.set`, `config.unset`, `config.rollback`,
`camera.action`, `camera.name.set` and `proxy.restart` (all in the strict
`command` enum since P2), each with `commands/<name>.args` and
`commands/<name>.result` schemas. The full text (args, outcomes, results,
path checks) is "The P3 contract" in
`docs/superpowers/plans/2026-10-07-migration-p3-cams-admin.md`; it is binding
for both repositories.

**Every allow entry is off by default.** The disruptive entries are
`proxy.restart` and `camera.action:<a>` for the actions in
`DISRUPTIVE_ACTIONS` (`build.ts`); the UIs group them and ask for a typed
confirmation. `NEVER_REMOTE_ACTIONS` are never run for cams-admin, whatever
the allow-list says.

Changed steps of the check order:

- **Step 8 (allowed):** `camera.action` passes with at least one
  `camera.action:*` entry; every other command needs its own name.
- **Step 9 (rate, in memory):** the totals plus per-command windows:
  `config.set`, `config.unset` and `config.rollback` share one window of 6
  per minute (dry runs count); `camera.action` 12 per minute;
  `camera.name.set` 6 per minute; `tokens.apply` 6 per hour. `config.get`
  counts only toward the totals.
- **Step 11 (entries and budgets):** an action in `NEVER_REMOTE_ACTIONS` →
  `not_allowed`; otherwise `camera.action:<action>` must be allowed →
  else `not_allowed`; a disruptive action or `proxy.restart` must fit the
  **journal budget** (persisted: `proxy.restart` ≤ 2 per hour, disruptive
  `camera.action`s ≤ 6 per hour per proxy, whatever their status) → else
  `rate_limited` with `retryAfterS`.

`done` outcomes (nothing is written on anything but `ok` with
`dryRun: false`):

| command | `ok` | `conflict` | `failed` codes |
|---|---|---|---|
| `config.get` | the view | — | `store_error` |
| `config.set`, `config.unset` | the change list (also for a dry run) | `baseRevision` ≠ the current `configRevision` | `not_remote_settable`, `held_by_env`, `unknown_camera`, `widening_local_only`, `invalid_value`, `store_error` |
| `config.rollback` | the change list | a path the command changed has changed since | `no_backup`, `already_rolled_back`, `not_remote_settable`, `widening_local_only`, `invalid_value`, `store_error` |
| `camera.action` | the action answered 2xx | — | the action's error code |
| `camera.name.set` | the name as read back | — | `invalid_name`, `camera_offline`, `camera_error`, `unknown_camera` |
| `proxy.restart` | `{restartAt}`; the restart follows the result | — | — |

**`remote-settable.json` is the upper bound:** cam-proxy's compiled list
must be a subset of `remote` (a test on each side); a path outside it is
never remote-settable, whatever a proxy reports. `narrow` paths move one way
only from cams-admin: Google Vision spending only down (`less`; 0 = no cap
for `dailyCap` and `perCameraDailyCap`), every retention period and size cap
only up (`more`; an unset size cap = no cap), so cams-admin can never make a
proxy delete data. `storage.*` and `cameras.*.storage.*` are local only.
A `config.rollback` that would lower a raise-only value, raise spending, or
touch a local-only path fails `widening_local_only` (cam-proxy #196: no
longer exempt from `narrow`).

**Local only in P3** (`LOCAL_ONLY` in `build.ts`, listed in `denied`). Ruling:
capture/feature on-off switches (`ftp.enabled`, `stills.enabled`,
`archive.enabled`, events/analytics enable flags and any other `*.enabled`
that turns capture or a listener on/off) and health thresholds
(`health.*`, `host.stats`, `ftp.stalledHours`, `archive.warnPercent`) are
LOCAL ONLY in P3. A compromised cams-admin must not be able to blind a proxy
silently, and `ftp.enabled=true` opens ports (network exposure needs Klaus).
Cost if wrong: these stay local; adding them later is a contract change.
`cameras.*.moved` and `moves` (the moved marker of a camera and the `moves.*`
settings such as `moves.maxCameras`) are also in `denied`: cam-proxy marks them local only, and cams-admin
refuses to set them (`not_remote_settable`) whatever a proxy reports.
`profile` (the proxy profile, every `profile.*` path) is in `denied` too: it is
set on the proxy only.

**Camera names** (`CAMERA_NAME_PATTERN`, a `u` regex, from cam-proxy #196):
1–64 assigned characters (no `Cn`), none of them a control (`Cc`), a format
character (`Cf`: bidi controls, U+061C, zero-width and tag characters), a
surrogate (`Cs`, so no lone one), a private-use character (`Co`) or a line or
paragraph separator (`Zl`, `Zp`). It applies to `camera.name.set` (args
schema) and, on the proxy, to `config.set` of `cameras.*.name`
(`invalid_value`).

**`camera-ftp-off` is never remote** (cam-proxy #196): it is in
`NEVER_REMOTE_ACTIONS`, not in `REMOTE_ACTIONS`, and so not an allow entry or
heartbeat value. Turning the camera's FTP upload off would silently stop clip
capture. The journal budget still counts `camera-ftp-off` entries already
journaled (`JOURNAL_BUDGET_ACTIONS`).

**Secret-shaped names** (`SECRET_KEY_PATTERN`, case-insensitive:
`pem|key|password|passwd|secret|token|cookie`): no remote path matches it.
cams-admin drops matching paths from a stored view and matching keys from an
action's answer, and the proxy scrubs them as well.

Fixtures: a P3 proxy fixture's `$context` may carry `journal`, a list of
`{cmdId, command, at, action?}` the journal budget counts. Result fixtures
name their command in `$command`. The starred refused fixtures (bad path,
object value, 65 paths, no camera, never-remote action) pass the `command`
schema and fail their `commands/<name>.args` schema.

**Cross-check while the repos are out of step:** a command fixture whose
`body.command` cam-proxy `main` does not implement yet, and whose verdict
differs, is reported `pending` (not a failure) by
`scripts/contract/cam-proxy-commands.ts`, but only while cam-proxy implements
**no** P3 command. Once one is in its `IMPLEMENTED`, every P3 fixture must
match (nothing pending).
## Camera moves

Additive: the envelope stays v1, signatures and JCS unchanged. Thirteen commands
(`move.begin`, `move.summary`, `move.targets`, `move.open`, `move.offer`, `move.answer`, `move.start`,
`move.go`, `move.release`, `move.finish`, `move.cancel`, `move.return.open`,
`move.return.start`; all `v:1`, in the strict
`command` enum, each with `commands/<name>.args` and `.result` schemas) and six
`event` kinds without a `cmdId` (`move.targets`, `move.request`,
`move.approve`, `move.cancel`, `move.phase`, `move.progress`; they keep the
`proxyId` and `connId` of `command.done`). The wire shapes are the schemas and the
`valid-command-move-*` / `valid-event-move-*` fixtures; the design is cam-proxy's
`docs/superpowers/specs/2026-10-21-camera-move-design.md`.

**Allow entries** (new in the strict heartbeat enum, both local, off by default):
`move.send` (the source side: `move.begin`, `move.summary`, `move.targets`, `move.open`, `move.answer`,
`move.go`, `move.release`, `move.return.start`, and `move.finish` / `move.cancel` with
`args.role` = `source`) and `move.receive` (the target side: `move.offer`, `move.start`, `move.return.open`, and
`move.finish` / `move.cancel` with `args.role` = `target`).

Changed steps of the check order:

- **Step 8 (allowed):** each move command needs its entry; `move.finish` and
  `move.cancel` pass with either move entry here (their role is not checked yet).
- **Step 9 (rate, in memory):** every `move.*` command counts toward one window of
  60 per minute per proxy (the same as `config.get`); no journal budget.
- **Step 11 (entries):** `move.finish` and `move.cancel` need the entry of
  `args.role` (`source` -> `move.send`, `target` -> `move.receive`) -> else
  `not_allowed` (after the args check, as `tokens.apply.admin`). A `move.finish` with
  `return: true` flips the mapping (see below).

Rulings of the camera-move plan that the schemas carry:

- `move.answer.reason` is the `move.offer` refusal reasons (`moves_not_allowed`,
  `camera_unreachable`, `camera_limit`, `id_taken`, `busy`, `incompatible`,
  `no_site_ca`, `ca_does_not_cover_camera`, `external_cert`) plus the cams-admin-only
  reasons `other_account`, `target_offline`, `not_routed`, `host_overridden`,
  `target_failed`, `offer_expired`, `not_registered` (the requested camera is not in
  cams-admin's registry) and `internal` (the source's `move.open` failed with
  anything else, or ended unknown or expired). They are answered at once so the
  source page does not wait. A proxy that validates the reason against a closed
  list must add `not_registered` and `internal`.
- A refusal may say why in words: the `move.offer` result's refusal branch is
  `{accept: false, reason, detail?}` (closed in strict), and `move.answer` takes
  the same optional `detail` (1–300 characters each). cams-admin keeps the
  target's detail on the move and passes it on in `move.answer`; its own
  refusals carry their own detail (the values that disagree, or the failing
  precheck rule's detail). Both are optional: a proxy from before sends and
  takes none (`valid-result-move-offer-refused`), a newer one may
  (`valid-result-move-offer-refused-detail`, `valid-command-move-answer-refused-detail`).
  cams-admin sends `move.answer.detail` to the source (cam-proxy v2026.10.25.1
  and later take it).
- A `move.request` that repeats a `requestId` which already has a move (also a
  rejected one) is ignored: no second row, no second answer.

- `requestId` is `rq_` + 20 characters like every other id; `camera` (in
  `move.targets`, `move.open`, and `move.request.camera.proxyCameraId`) is the
  proxy's camera id; `target` is a `prx_` id.
- `move.cancel` (command): `copied` (`delete` | `age-out`) is required only when
  `role` is `target`; a source cancel carries `expectedLeaf` instead (optional).
- `move.finish` (command) names the side with `role`; the proxy of that side ends
  its part (a target stops its copier and closes its journal). Its result
  `deleted` has only the five kinds (`stills`, `clips`, `events`, `checks`,
  `archive`) as keys, each `{files, bytes}`; the recordings cache is not content.
- The plaintext `token` is in a non-final `move.offer`'s args only (it is not
  stored once the command is final); `move.open` carries its `tokenHash`.
- `settings` is the camera node of the proxy's config: every leaf optional,
  never null, closed objects. `summary` has all five kinds, times nullable.
- `move.begin` (cams-admin → source, entry `move.send`) starts a move from cams-admin:
  args `{v: 1, camera: <proxy camera id>, target: <proxy id>, bounds: MoveBounds | null}`,
  all required, closed. `MoveBounds` is `{transfer, kinds (unique, at most six: the move kinds),
  space (all | omit | fit | retention), maxBudgetS (integer, 60 to 604800)}`: what
  the source may approve on its own. No password, token or key travels. The result
  is `{requestId}`; the source then emits the usual `move.request` event. A refusal
  is the command's `failed` status with one of `no_site_ca`, `external_cert`,
  `moves_not_allowed`, `busy`, `unknown_camera` (`MOVE_BEGIN_REFUSALS`).
- `move.summary` (cams-admin → source, entry `move.send`, read only: it changes nothing on
  the proxy) asks for a camera's content before any move (the Start move form): args
  `{v: 1, camera: <proxy camera id>}`, closed. The result is `{summary}`, the same
  `summary` shape `move.request` carries (all five kinds, each `{files, bytes, rows,
  oldest, newest}`, times nullable). An unknown camera is the command's `failed` status
  with `unknown_camera`. A proxy that does not implement it answers `not_allowed` (step 8):
  cams-admin then says the proxy needs the cam-proxy update. Fixtures
  `valid-command-move-summary`, `refused-move-summary-not-allowed`, `valid-result-move-summary`;
  `scripts/contract/cam-proxy-commands.ts` reports them `pending` until cam-proxy's
  `IMPLEMENTED` has `move.summary`.
- `move.request` carries `bounds` (`MoveBounds | null`), optional in both schemas:
  a proxy that does not send it is valid and means null.
- `move.request` also carries `actor` `{origin: local | managed, label}`; the
  camera's connection fields come from the source's config, never a password.
- `move.phase` `failed` carries a `code` (for example `token_address`); the target
  step that gives up and a source guard that refuses the bound peer both send it.
- `move.start.done` holds at most 512 chunk ids (the newest ones: the args stay
  under the 16 KiB cap); the target's journal is authoritative for the rest.
- A chunk `state` of `failed` means copied with failures; chunk ids are
  `<kind>:<YYYY-MM-DD>`.
- **Copy back (step 4).** After a cancel past the switch-over the content is copied back
  as its own move (`moveId`) that returns the content of `returnOf` (an `mv_` id), with
  the roles swapped: the proxy that now holds the camera's content sends, the other receives.
  - `move.return.open` (entry `move.receive`; args `{v, moveId, returnOf, tokenHash,
    targetIp}`, all required, closed) -> result `{chunks, bytes}` (integers: what is to
    come back). The receiving side accepts one bearer token (its hash). A repeated
    open with a new `tokenHash` re-keys (cams-admin restarted and holds a fresh token).
  - `move.return.start` (entry `move.send`; args `{v, moveId, returnOf, token, source:
    {proxyId, name, url, caFingerprints, tlsServername}, done: chunkId[<= 512]}`) ->
    result `{}`. Here `source` names the proxy to pull from, as in `move.offer`.
  - `move.finish` gains an optional `return` boolean. With `return: true` the entry
    flips: role `source` needs `move.receive`, role `target` needs `move.send`
    (step 11 of the check order).
  - `move.phase` gains three optional fields: `check` (the completeness check:
    `{complete, missing, recovered, failed, expired}`; `complete` is a boolean, the
    other four are objects with optional keys among the six move kinds, each a count),
    `keepDays` (integer 7 to 3650: how long cams-admin keeps the ended move) and
    `returnPending` (boolean: a cancel past the switch-over left content to copy back).
  - The check counts files; rows that could not be imported count as `failed`.
  - Archive first (Archive items move before the other kinds) is internal to the
    proxies: no wire change.
- `site` (`move.targets`, and cams-v1 `proxies[].site`) is null or
  `^[a-z0-9][a-z0-9-]{0,30}$`, cam-proxy's `tls.site`.
- **PTZ positions (`ptz`).** A camera's PTZ positions travel with it (cam-proxy's
  capabilities design §7). The move kinds are split:
  - the five **file kinds** (`FILE_KINDS`: `stills`, `clips`, `events`, `checks`,
    `archive`) are the only keys of `summary` (`move.request`, `move.offer`, the
    `move.summary` result; still all five, closed), `space.perKind` and the
    `move.finish` result's `deleted`; the copy back's plan names them too;
  - all six **move kinds** (`MOVE_KINDS`: the five and `ptz`) are allowed in
    `plan.kinds` and `bounds.kinds` (unique, at most six), chunk ids
    (`ptz:<YYYY-MM-DD>`), the `move.phase` check counts and `kinds`.
  - `kinds` (optional, unique `MOVE_KINDS`, at most six): the target lists the kinds
    it accepts in the `move.offer` accept branch (`{accept: true, space, probeBps,
    kinds?}`), and cams-admin passes it on in `move.answer`. Absent means the five
    file kinds (a proxy before `ptz`). cams-admin relays it only to a source whose
    last hello listed the capability `move-ptz`: an older source's closed
    `move.answer` check would refuse the whole answer.
  - Positions travel also with `transfer: false` (a plan of `kinds: ['ptz']`); a
    `ptz` chunk has no files and no summary entry. `bounds.kinds` may name `ptz`,
    but cam-proxy ignores it there (positions are not a choice).
  - Fixtures: `valid-result-move-offer-kinds`, `valid-command-move-answer-kinds`
    (`$context.feature: 'move-ptz'`: the cross-check reports it `pending` until
    cam-proxy's `src/moves/types.ts` names `'ptz'`), `valid-event-move-approve-ptz`,
    `valid-event-move-approve-ptz-only`, `valid-event-move-progress-ptz`,
    `valid-event-move-phase-check-ptz`, `drift-event-move-request-summary-ptz` (a
    sixth summary key: lenient takes it, strict refuses).

## cams-v1 (P4: the cams service API)

`cams-v1/` is a second contract, between a cams instance and cams-admin
(`/cams/v1/*`: enrollment, signed requests and answers, the signed
configuration snapshot, token-hash registration, status reports). Its source
is `cams-build.ts` (written by the same `npm run contract:make`); its rules,
check order and signed texts are in `cams-v1/README.md`. cams vendors the
folder with a `SOURCE` file, like cam-proxy vendors `v1/`.
