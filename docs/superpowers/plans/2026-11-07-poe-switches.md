# PoE Switches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PoE switches become account resources in cams-admin; a camera's power (switch + port) lives on its cams-admin record, is verified by traffic before every power-cycle, can be forced, and is surveyed; cam-proxy operates switches by id on cams-admin's commands.

**Architecture:** cams-admin owns switch records and camera power and orchestrates through the existing signed command channel. The operating proxy runs every switch session (one queue per switch), finds a camera's port by a ping burst and the switch's per-port tx rate, and cycles. The camera's own proxy keeps its reboot state machine, driven by `camera.power.*` messages. Switch passwords stay on the operating proxy.

**Tech Stack:** TypeScript (Node 26), Express, node:sqlite (cams-admin), Svelte 5, vitest, Playwright. Repos: `~/Development/cams-admin`, `~/Development/cam-proxy`, `~/Development/cams` (MCP only).

**Spec:** `cams-admin/docs/superpowers/specs/2026-11-07-poe-switches-design.md`

## Global Constraints

- Switch ids `sw_` + 20 chars (`newId('sw')`); camera ids `cam_…` in cams-admin; proxies name cameras by their proxy camera id (`proxy_camera_id`).
- Camera `power` kinds exactly: `poe`, `data-only`, `adapter`, `unknown`.
- Switch model `sscpoe-web` only; `ports` 1–64 (default 8); `offSeconds` 1–120 (default 10).
- Locate: ping burst `ping -q -s 1400 -i 0.01 -w 5 <host>` (BusyBox ping works unprivileged in the proxy container: checked on een 2026-11-07, uid 1000, `ping_group_range 0 2147483647`). Port = the linked port whose `tx` during the burst is ≥ 5× every other linked port's `tx` and ≥ 5× its own baseline `tx`; otherwise not found (`ambiguous` / `no_traffic`).
- Ports at internal index ≥ `ports` (the uplink, index 9) never count.
- Never cycle without verification unless `force`; `force` only for a `poe` mapping; the switch-level "PoE on and > 0 W" check stays for forced cycles too.
- Switch passwords never pass through cams-admin, never logged, returned, or audited. Stored on the operating proxy in `<dataDir>/admin/switch-passwords.json` (mode 600), shaped like `camera-passwords.json`.
- The camera power record is the one place; switch records hold no camera list.
- Survey daily at `03:30` in cams-admin's configured time zone (the backup scheduler's `tz`), one `switch.survey` command per switch.
- Every change (switch add/edit/move/remove, mapping change, verify result that changes the record, power-cycle, forced power-cycle) is audited in cams-admin; switch-side actions also audited on the operating proxy (`switch-port-cycled`, `switch-port-poe-on`, `switch-password`, `switch-forgotten`).
- Real switches/cameras only in the final live task; tests use `test/helpers/poe-switch-mock.ts` (cam-proxy) and the test-client fake proxy (cams-admin). Never real Google Vision or S3.
- Merge only with all checks green; stage files explicitly; worktrees on `/Volumes/SSD-WDBlack-1T/claude-work`.

## Review Focus

1. A camera whose stream keeps `rx` high on its port must still be located by `tx` only (rx ignored) — test in Task 2.
2. Two cameras' power records pointing at the same switch port: the newer verified one wins, the other goes `unknown`, audited — test in Task 8.
3. cams-admin restart while a power-cycle runs: the proxy still turns PoE on (operator-local); cams-admin shows the command's final state from the command row, not a stuck "cycling" — test in Task 9.
4. A switch removed while a survey or cycle command for it is open: the command answers `switch_unknown` on the proxy if already forgotten; cams-admin refuses DELETE while a command for the switch is open (409 `switch_busy`) — tests in Tasks 4 and 8.
5. Camera without a host in cams-admin: locate/verify/survey answer "camera host unknown in cams-admin" (never "not found") — test in Task 9.

---

### Task 1 (cams-admin): contract for switch commands and power messages

**Files:**
- Modify: `contract/build.ts` (args map ~L239, results ~L252, `WIRE_COMMANDS` ~L558, the allow list ~L568, `P3_COMMANDS` ~L580, `DISRUPTIVE_ACTIONS`, event kinds next to `MOVE_EVENT_KINDS` ~L511), `contract/make.ts` (fixtures), `contract/README.md`
- Generated: `contract/v1/**` via `npm run contract:make`
- Modify: `server/contract.ts` (`vArgs`, `vResult`, new `validateProxyEvent`), `server/commands/service.ts` (`WireCommand`, `summariseArgs`)
- Test: `test/contract*.test.ts` (existing build/drift tests), new fixtures

**Interfaces — Produces (exact wire shapes, all `v: 1`):**
- `SwitchRef = { id: string /^sw_[A-Za-z0-9]{20}$/, model: 'sscpoe-web', host: string (host or IPv4, ≤253), ports: 1..64, offSeconds: 1..120 }`
- `PortState = { port, poe: boolean, watts: number, link: boolean|null, tx: number, rx: number }`
- `switch.read {v, switch: SwitchRef}` → `{ sn: string|null, firmware: string|null, ports: PortState[] }`
- `LocateResult = { found: boolean, port?: number, poe?: boolean, watts?: number, link?: boolean|null, reason?: 'not_reachable'|'ambiguous'|'no_traffic', ratio?: number }`
- `switch.locate {v, switch, host}` → `LocateResult & { sn }`
- `switch.survey {v, switch, cameras: [{camera: cam_id, host}] (1..16)}` → `{ sn, results: (LocateResult & {camera})[] }`
- `switch.cycle {v, switch, port, host: string|null, force: boolean, camera: cam_id}` → `{ verified: boolean, offAt, onAt, watts }`; failed codes `not_verified`, `no_power`, `switch_busy`, `poe_may_be_off`, `password_unset`, `switch_unknown`
- `switch.poeOn {v, switch, port}` → `PortState & { wasOn: boolean }`
- `switch.forget {v, switchId}` → `{ forgot: boolean }`
- To the camera's own proxy: `camera.power.set {v, camera: proxyCameraId, power: { kind, switchName?: string, port?: number, watts?: number, verifiedAt?: number, notSeen?: boolean }}`, `camera.power.cycling {v, camera, at}`, `camera.power.cycled {v, camera, ok: boolean, message: string ≤200}`, `camera.power.cycle.result {v, camera, requestId: string ≤64, ok, reason?: string ≤200}` — all → `{}`
- Event kind `camera.power.cycle.request {camera: proxyCameraId, requestId}` (no force from proxies)
- Allow entries: `switch.read`, `switch.locate`, `switch.survey`, `switch.cycle` (disruptive), `switch.poeOn`, `switch.forget`, `camera.power.set`, `camera.power.cycling`, `camera.power.cycled`, `camera.power.cycle.result`

- [ ] **Step 1:** Add fixtures in `contract/make.ts`: `valid-command-switch-read`, `valid-command-switch-cycle-force`, `refused-switch-cycle-bad-id` (`switch.id: 'sw_x'`), `valid-event-camera-power-cycle-request`.
- [ ] **Step 2:** `npm test -- contract` → FAIL (unknown command/kind).
- [ ] **Step 3:** Add the schemas and lists in `contract/build.ts`; `npm run contract:make`; wire `server/contract.ts` and `WireCommand`/`summariseArgs` (hosts and messages clamped with `clampValue`).
- [ ] **Step 4:** `npm test` → PASS (including the committed-output check).
- [ ] **Step 5:** Commit `feat(contract): switch commands and camera power messages`. Merge to main before Task 2 (cam-proxy vendors it).

### Task 2 (cam-proxy): rates and locate on the driver and a per-switch controller

**Files:**
- Modify: `src/camera/switch/driver.ts` (`SwitchDetail` gains `tx: number[]`, `rx: number[]`), `src/camera/switch/sscpoe-web.ts` (parse `tx`/`rx` strings → numbers, missing → 0)
- Create: `src/camera/switch/locate.ts` — `pickPort(ports: number, base: SwitchDetail, burst: SwitchDetail, portIndex: (port) => number): LocateResult`; `pingBurst(host: string, run?: Runner): { done: Promise<{ answered: boolean }> }` (spawns `ping -q -s 1400 -i 0.01 -w 5 host`; `answered` = BusyBox summary shows > 0 received)
- Modify: `src/camera/poe-switch.ts` — the class becomes per switch: `new PoeSwitch({ ref: () => SwitchRef, password: () => string|undefined, ... })`; new `locate(host): Promise<LocateResult & { sn }>` (one session: detail → start burst → wait 2500 ms → detail → wait burst end → logout; `not_reachable` when the burst got no reply), `survey(cameras)`, `cycle(port, onOff, { verifyHost: string|null })` (verify inside the same session unless `verifyHost` null = forced)
- Test: `test/switch-driver.test.ts`, `test/poe-locate.test.ts` (new), `test/poe-switch.test.ts`, `test/helpers/poe-switch-mock.ts` (mock gains settable `tx`/`rx` per index)

- [ ] **Step 1:** Tests in `test/poe-locate.test.ts`:
  - `pickPort` finds port 3 when burst tx = `[1,1,40,1,…]` at port 3's index and baseline all 1 → `{found:true, port:3, ratio:40}`.
  - rx-only spike (camera stream) on port 2 and tx spike on port 3 → port 3 (Review Focus 1).
  - two ports at tx 30 and 20 → `{found:false, reason:'ambiguous'}`.
  - spike only on index 9 (uplink) → `{found:false, reason:'no_traffic'}`.
  - unlinked port ignored.
  - `PoeSwitch.locate` against the mock with a fake `pingBurst` that raises the mock's tx on index 5 → port 3; a burst with `answered:false` → `not_reachable`, and the session logged out.
  - `cycle(port, …, {verifyHost})` when locate finds another port → throws `PoeSwitchError('not_verified')`, PoE never switched (mock records no 103).
- [ ] **Step 2:** `npx vitest run test/poe-locate.test.ts` → FAIL.
- [ ] **Step 3:** Implement; `PoeSwitchErrorCode` gains `not_verified`.
- [ ] **Step 4:** `npm test` → PASS (existing PoE tests adapted to the per-switch constructor).
- [ ] **Step 5:** Commit `feat(poe): rates, locate by ping burst, verified cycle`.

### Task 3 (cam-proxy): switches by id, password store, local PoE on

**Files:**
- Create: `src/camera/switch/registry.ts` — `SwitchRegistry` keyed by switch id: `get(ref: SwitchRef): PoeSwitch` (creates or updates the descriptor), `known(): SwitchRef[]`, `forget(id): boolean`, `stop()`; descriptors persisted to `<dataDir>/switches.json` (no secrets) so local PoE on works without cams-admin.
- Create: `src/config/switch-passwords.ts` — copy of `camera-passwords.ts`'s pattern: `<dataDir>/admin/switch-passwords.json` `{v:1, switches:{<id>:{password}}}`, `switchPasswordStore(dataDir)`.
- Modify: `src/proxy.ts` (~L508: the registry replaces the single `PoeSwitch`; legacy fallback: while `poeSwitch.model !== 'none'` in config, a ref whose `host` equals `poeSwitch.host` without a stored password uses `CAMPROXY_POE_SWITCH_PASSWORD`), stop() calls `registry.stop()`.
- Modify: `src/api/control-api.ts` / `src/api/onboarding-api.ts`: `GET /control/switches` (refs + `passwordSet`, `poeMaybeOff` ports), `PUT /control/switches/:id/password` (`{password}`, audited `switch-password`, never echoed), `POST /control/switches/:id/ports/:port/poe-on` (audited `switch-port-poe-on`).
- Modify: `src/audit/actions.ts` + `docs/audit-log.md` (`switch-password`, `switch-port-poe-on`, `switch-port-cycled`, `switch-forgotten`).
- Create: `web/src/components/PoeSwitchesCard.svelte` on Proxy settings (scope proxy): switches this proxy operates, password set or "Set password", per-port "Turn PoE on" for ports with `poeMaybeOff`.
- Test: `test/switch-registry.test.ts`, `test/switch-passwords.test.ts`, `test/settings-ui.test.ts`

- [ ] **Step 1:** Tests: registry persists refs and restores them on a new instance; `forget` removes the ref and the password; the password file is mode 600 and its content never appears in `GET /control/switches`; the legacy fallback applies only when hosts match; poe-on route turns on the mock's port and audits.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test && npm run build:web` → PASS.
- [ ] **Step 5:** Commit `feat(poe): switches by id, switch passwords, local PoE on`.

### Task 4 (cam-proxy): switch command handlers

**Files:**
- Create: `src/fleet/switch-commands.ts` — `switchHandlers(d: { registry: SwitchRegistry; audit; reboot: (camera) => CameraReboot|undefined }): Record<string, Handler>` for `switch.read|locate|survey|cycle|poeOn|forget`
- Modify: `src/fleet/command-args.ts` (validators per command, shapes from Task 1), `src/fleet/policy.ts` (`ALLOW_ENTRIES`, `IMPLEMENTED`, `ENTRY_TEXT`, `entryFor`; `switch.cycle` in `DISRUPTIVE_ACTIONS`), `src/api/cams-admin-api.ts` (`GROUPS`: a "PoE switches" group), `src/proxy.ts` (~L970 register)
- Vendor: `test/contract/cams-admin-v1/` from cams-admin main (Task 1 commit) + `SOURCE`
- Test: `test/fleet-switch-commands.test.ts` (new), `test/fleet-contract.test.ts`

- [ ] **Step 1:** Tests: each command against the mock gives the Task 1 result shape (validated with the vendored result schema); `switch.cycle` force=false with a mismatched port → `failed` `not_verified`; no password → `password_unset`; `switch.forget` then `switch.read` for the same id with no password → `password_unset`, and a `switch.cycle` for a forgotten id while descriptors exist only in args still needs a password → `password_unset` (Review Focus 4: the proxy never acts without its password); `switch.cycle` success audits `switch-port-cycled` with camera and port, `forced: true|false`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (each handler calls `registry.get(args.switch)`). **Step 4:** `npm test` → PASS; `scripts/contract-drift.sh` clean.
- [ ] **Step 5:** Commit `feat(fleet): switch commands`.

### Task 5 (cam-proxy): camera power messages, Maintenance and Camera settings

**Files:**
- Modify: `src/camera/reboot.ts` — `CameraReboot.externalPowerCycle(at: number)` (state `power-cycling` with `offAt`, cooldown, token drop, watch — what `powerCycle` does after the cut) and `externalPowerCycleDone(ok: boolean, message: string)`; audit stays `camera-powercycle` with `via: 'cams-admin'`.
- Create: `src/fleet/power-commands.ts` — handlers `camera.power.set` (stores the display record in memory + `<dataDir>/camera-power.json`), `camera.power.cycling`, `camera.power.cycled`, `camera.power.cycle.result`; `requestPowerCycle(camera): { requestId }` emits event `camera.power.cycle.request` via `emitToAdmin`.
- Modify: `src/api/actions.ts` / `control-api.ts`: `camera-powercycle` with cams-admin enabled → `requestPowerCycle` (202 `{requestId}`); without cams-admin or without a `camera.power` record from it → 409 `power_cycle_needs_cams_admin`. `GET /control/cameras/:cam/power` → the stored record + the last `cycle.result` for that camera.
- Modify: `web/src/pages/Maintenance.svelte` (button text "Power-cycle (through cams-admin)"; shows "asked cams-admin…" until the result), `web/src/components/PoeSwitchCard.svelte` (camera scope: "PoE: <switch>, port N, verified <age>" / "Data only: power adapter" / "Power adapter" / "Unknown"; no settings).
- Modify: `src/fleet/client.ts` (`emitEvent` accepts the new kind)
- Test: `test/fleet-power-commands.test.ts`, `test/camera-powercycle.test.ts`, `test/maintenance-ui.test.ts`, `e2e/maintenance.spec.ts`

- [ ] **Step 1:** Tests: `cycling` then `cycled ok` drives the reboot state like today's power-cycle (cooldown set, token dropped, watch until the camera answers); `cycled ok:false` ends it with the message; the Maintenance action returns 202 with a requestId and emits exactly one event; `cycle.result` shows in `GET …/power`; without cams-admin → 409 code above.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test && npm run build:web && npx playwright test e2e/maintenance.spec.ts` → PASS.
- [ ] **Step 5:** Commit `feat(poe): power-cycles through cams-admin`. Open the cam-proxy PR (Tasks 2–5), merge when green, release (old config still read).

### Task 6 (cams-admin): switch records and camera power in the database

**Files:**
- Modify: `server/db/migrations.ts` — append #22: `CREATE TABLE switches (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, model TEXT NOT NULL CHECK (model IN ('sscpoe-web')), host TEXT NOT NULL, ports INTEGER NOT NULL, off_seconds INTEGER NOT NULL, proxy_id TEXT NOT NULL REFERENCES proxies(id), state TEXT NOT NULL CHECK (state IN ('pending','active')), sn TEXT, firmware TEXT, read_at INTEGER, survey INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id, name)) STRICT;` and #23: `ALTER TABLE cameras ADD COLUMN power TEXT CHECK (power IS NULL OR json_valid(power));`
- Modify: `server/ids.ts` (`'sw'`), `server/audit.ts` (`switch-create`, `switch-update`, `switch-move`, `switch-delete`, `switch-test`, `camera-power-set`, `camera-power-verify`, `camera-power-cycle`, `camera-power-cycle-forced`, `switch-survey`)
- Create: `server/switches/store.ts` — `Switch` type; `createSwitch`, `getSwitch(accountId, id)`, `listSwitches(accountId)`, `updateSwitch`, `deleteSwitch`, `findBySerial(sn)`; `CameraPower` type (`{kind:'poe', switchId, port, watts, verifiedAt, notSeen?} | {kind:'data-only', switchId, port, verifiedAt, notSeen?} | {kind:'adapter'} | {kind:'unknown'}`); `setPower(cameraId, power, actor, why)` (enforces one camera per port: an older record on the same switch+port → `unknown`, both audited), `camerasOnSwitch(switchId)`
- Modify: `server/registry.ts` (`Camera.power`, `toCamera`, column map)
- Test: `test/switches-store.test.ts`

- [ ] **Step 1:** Tests: create/list/update/delete round trip; duplicate name → error; `setPower` on a taken port moves the older camera to `unknown` and writes two audit entries (Review Focus 2); `camerasOnSwitch` returns only that switch's `poe`/`data-only` cameras; account delete cascades switches.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS. **Step 5:** Commit `feat(switches): switch records and camera power`.

### Task 7 (cams-admin): switch commands service and lifecycle API

**Files:**
- Create: `server/switches/service.ts` — `SwitchService` with `add(actor, accountId, input)` (state `pending`), `test(actor, id)` (`switch.read` through the operator; sn already on another switch of any account → 409 `switch_taken`; success → `active`, sn/firmware/read_at stored, a survey queued), `update(actor, id, patch)` (address change: test first, sn must match, else nothing changes), `move(actor, id, {proxyId, host?})` (test through the new operator, flip, `switch.forget` to the old one, survey; audited `switch-move`), `remove(actor, id)` (refused 409 `switch_busy` while a command for it is open; `switch.poeOn` for every mapped `poe` port, `switch.forget`, mapped cameras → `unknown`, delete), `read(id)` (live `switch.read` + mapped cameras per port). Commands via `commands.create(..., meta {actorType})`; results via `commands.onFinal` keyed by command id (never `waitFinal` for writes).
- Modify: `server/api/router.ts`: `GET/POST /accounts/:accountId/switches`, `GET/PATCH/DELETE /switches/:switchId`, `POST /switches/:switchId/test`, `POST /switches/:switchId/move`; `server/ops/scopes.ts` (writes for ops tokens: none — sysadmin only, my call); `server/validate.ts` (`switchInput`: name ≤ 60, host via `checkCameraHost`, ports, offSeconds, proxyId of the same account)
- Test: `test/api-switches.test.ts` (real server, fake clock, test-client proxy with the switch commands in its allow list and canned results — extend `test-client/commands.ts`)

- [ ] **Step 1:** Tests: add → `pending`; test with fake result `{sn:'GPS208X'}` → `active`; a second switch (any account) answering the same sn → 409 `switch_taken`; address change with a different sn → 409 `switch_mismatch`, record unchanged; move sends `switch.read` to the new proxy then `switch.forget` to the old; delete with an open command → 409 `switch_busy` (Review Focus 4); delete sends `switch.poeOn` per mapped `poe` port and leaves cameras `unknown`; proxy without `switch.read` in its allow list → 409 `not_allowed_on_proxy`; every write audited (`api-audit-completeness`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS. **Step 5:** Commit `feat(switches): lifecycle API`.

### Task 8 (cams-admin): camera power — verify, search, cycle, force, survey

**Files:**
- Create: `server/switches/power.ts` — `PowerService`:
  - `get(accountId, cameraId)`; `declare(actor, cameraId, {kind:'adapter'} | {kind:'auto'})` (`auto` → `unknown` + locate search)
  - `propose(actor, cameraId, {switchId, port})` → verify, saved only when the camera's traffic is on that port
  - `verify(actor, cameraId)` → `switch.locate` on the mapped switch; not there → search
  - `search(actor, cameraId)` → `switch.locate` on each active switch of the account, one after another; first found wins; `poe` vs `data-only` by watts > 0
  - `cycle(actor, cameraId, {force})`: unforced → `switch.cycle {force:false, host}` on the mapped switch (verify happens on the operator in the same session); `not_verified` → search, then retry once on the found switch; `data-only`/`adapter`/`unknown` → 409 `not_poe` / `power_unknown`; forced → only `poe`, `switch.cycle {force:true, host:null}`, audited `camera-power-cycle-forced`
  - around a cycle: `camera.power.cycling` / `cycled` to the camera's own proxy (skip silently if the camera's proxy lacks them in its allow list)
  - `survey(actor, switchId)` → one `switch.survey` with every non-`adapter` camera of the account that has a host (≤ 16 per command, more → several commands); results: found → `setPower`, not found → keep the record, set `notSeen: true`; `not_reachable` reported in the survey result, never mapped
  - after each change, `camera.power.set` to the camera's proxy
  - Missing camera host → `{ok:false, reason:'camera host unknown in cams-admin'}` everywhere (Review Focus 5)
- Create: `server/switches/schedule.ts` — daily survey at `03:30` with `nextRunAt(now, '03:30', tz)` from `server/backup/scheduler.ts`; also triggered on camera create/host change (hook in `registry.createCamera`/`updateCamera` callers in `server/server.ts`), switch `active`, switch move.
- Modify: `server/api/router.ts`: `GET/PUT /cameras/:cameraId/power`, `POST /cameras/:cameraId/power/verify`, `POST /cameras/:cameraId/power/cycle` (`{force?: boolean}`; 202 with the command id), `POST /switches/:switchId/survey`, `POST /accounts/:accountId/switches/survey`
- Test: `test/power.test.ts`

- [ ] **Step 1:** Tests with canned proxy results:
  - verify OK updates `verifiedAt`/`watts`;
  - verify finds the camera on switch B port 2 → record moves, audited, `camera.power.set` sent;
  - locate with watts 0 → `data-only`, cycle → 409 `not_poe`;
  - forced cycle of `data-only` → 409 `not_poe`; forced of `poe` → `switch.cycle` with `force:true, host:null`, audit `camera-power-cycle-forced`;
  - unforced cycle answered `not_verified` → search → cycle on the found port, once (no loop);
  - survey: not found keeps the mapping with `notSeen: true`; 20 cameras → 2 commands;
  - camera without host → reason text above;
  - daily schedule fires at 03:30 with the fake clock.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS. **Step 5:** Commit `feat(switches): camera power, verified and forced power-cycles, survey`.

### Task 9 (cams-admin): proxy events for power-cycle requests

**Files:**
- Modify: `server/channel/connection.ts` (~L158: proxy events whose kind isn't a move kind go to `onProxyPowerEvent`), `server/channel/hub.ts` (type), `server/server.ts` (~L78 wire to `PowerService.requestFromProxy`)
- Modify: `server/switches/power.ts` — `requestFromProxy(proxyId, {camera, requestId})`: maps the proxy camera id to the record (same account), runs an unforced `cycle` as actor `proxy:<id>` (`actorType: 'proxy'`), answers `camera.power.cycle.result` with ok/reason when the cycle command is final (via `onFinal`); after a cams-admin restart, an open cycle command's final state still produces the result (the listener is keyed by command id from the command rows, restored on start)
- Test: `test/power-events.test.ts`

- [ ] **Step 1:** Tests: a signed event from the test-client → `switch.cycle` to the switch's operator, then `camera.power.cycle.result {ok:true}` to the camera's proxy; unknown camera → result `ok:false, reason:'camera not in cams-admin'`; restart cams-admin between create and final (Review Focus 3) → the result is still sent once.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS. **Step 5:** Commit `feat(switches): power-cycle requests from proxies`.

### Task 10 (cams-admin): Switches tab and camera power UI

**Files:**
- Create: `web/src/components/SwitchesTab.svelte` — list (name, model, address, operating proxy, state, sn, last read); Add (name, address, model, ports, offSeconds, proxy select) → shows "Set the password on <proxy>'s Proxy settings → PoE switches, then Test"; per switch: Test, Edit, Move (proxy select + optional address), Remove (confirm text names the cameras that become unknown), Survey now; port table from `GET /switches/:id` (port, camera name, PoE, watts, link).
- Create: `web/src/components/CameraPower.svelte` — in the Cameras tab row: "PoE: <switch> port N · verified <age>" / "Data only (adapter)" / "Power adapter" / "Unknown" + actions Verify, Find, Declare adapter, Power-cycle, Force power-cycle (confirm dialog text exactly: `Cut power on <switch> port <N> without verification?`).
- Modify: `web/src/pages/Account.svelte` (`TABS` gains `'switches'`), `web/src/lib/api.ts` (`errorText` for `switch_taken`, `switch_mismatch`, `switch_busy`, `not_poe`, `power_unknown`, `not_verified`, `password_unset`)
- Test: `e2e/switches.spec.ts` (fake proxy with canned switch results), web unit tests if the repo has them for tabs

- [ ] **Step 1:** e2e: add a switch → pending → Test → active with sn shown; Survey now → the port table shows a camera on port 3; camera row shows "PoE: <name> port 3"; Force power-cycle shows the exact confirm text and sends `force:true`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test && npx playwright test e2e/switches.spec.ts` → PASS.
- [ ] **Step 5:** Commit `feat(web): Switches tab and camera power`. cams-admin PR (Tasks 6–10), merge when green, release.

### Task 11 (cams): MCP read tools

**Files:** the cams MCP fleet tools (find with `grep -rn "proxy_list\|fleet" src/mcp` in `~/Development/cams`): add `switch_list` (account switches with state and port count) and `camera_power` (a camera's power record), read-only, admin role, same pattern and tests as the existing fleet tools; cams-admin side: the read endpoints they call (`GET /accounts/:id/switches`, `GET /cameras/:id/power`) already exist from Tasks 7–8 — add them to the token scope the cams MCP uses (`server/ops/scopes.ts` or the cams token routes).

- [ ] **Step 1:** Test: each tool returns the fake cams-admin answer; non-admin → refused. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS. **Step 5:** Commit, PR, merge when green, release.

### Task 12 (controller): migration, live check, remove the old config

- [ ] **Step 1:** Both releases live on een, the Pi, the mini PC and the cluster (verify the served features, not only versions).
- [ ] **Step 2:** cams-admin: add een's switch (`192.168.60.2`, operator een's proxy, name "een PoE switch"); Test (legacy password fallback) → `active`; then set the password into the per-switch store on een (Klaus, or copied on een without printing: a one-off `docker exec` that reads the env var inside the container and calls `PUT /control/switches/:id/password` over loopback).
- [ ] **Step 3:** Survey → expect cam4 port 1 `poe`, e1 port 2 `data-only`, cam3 port 3 `poe`, cam1 port 4 `poe`. Verify one camera; power-cycle one camera unforced (any camera allowed, Klaus 2026-11-07) and watch it come back; forced cycle once on another; check audits on both sides.
- [ ] **Step 4 (cam-proxy):** remove `poeSwitch.*` (host and camera) from schema/defaults/cameras/legacy (legacy reader maps old keys to nothing and logs `poe_switch_config_ignored`), the env password fallback, README rows (~L192, 217, 245–252, 1215–1216), `docs/poe-switch.md` rewritten for switches by id; remote-settable drops `poeSwitch` and `cameras.*.poeSwitch` (cams-admin contract change + vendor). PR, merge when green, release; remove the keys from een's config.
- [ ] **Step 5:** CHANGELOG heading PRs (cam-proxy, cams-admin); Slack post per release; update memory (`poe-switch-api`).
