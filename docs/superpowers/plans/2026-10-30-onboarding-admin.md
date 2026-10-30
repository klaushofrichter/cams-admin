# Automated camera onboarding, part B (cams-admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A script (an operations token) or a person can drive and verify every cams-admin step of onboarding a camera: the contract part A needs, ops scopes `actions`, `config`, `offboard`, per-account auto-adopt of `ready` cameras, site-CA pins from the proxy's report, and one onboarding view (diag API and camera page) combining the proxy's onboarding status, the registry row and every viewer's state.

**Architecture:** The contract (`contract/build.ts` → `npm run contract:make`) gains an optional heartbeat field `onboarding`, one command kind `camera.onboarding.get` and one camera action `camera-time-set` (FTP setup stays the existing action `camera-ftp-setup`; ruling 2026-10-30, aligned with cam-proxy plan A Prerequisites 1); Task 1 is merged to `main` on its own, first, so cam-proxy part A can vendor it, and no later task touches `contract/`. The heartbeat's `onboarding` is read with clamps (like `moveLeftovers`) into the proxy's reported state; a new `server/onboarding/` module holds the auto-adopt and pins hooks (run after each heartbeat) and the combined view. Ops scopes extend `OPS_ROUTES`; new command routes go through `RemoteActions`.

**Tech Stack:** TypeScript, Express, node:sqlite, vitest, Svelte 5, JSON Schema 2020-12 (ajv), Playwright.

**Spec:** cam-proxy `docs/superpowers/specs/2026-10-30-camera-onboarding-design.md` (on cam-proxy `main`; also in the worktree `/Volumes/SSD-WDBlack-1T/claude-work/cp-onb-a/docs/superpowers/specs/`), §5 and the contract parts of §4.5–§4.7; decisions §10 are binding. Inventory: `onboarding-inventory.md` of 2026-10-30 (cams-admin 32de987).

**Release order:** Task 1 → its own PR, merged and released first (cam-proxy's drift check requires its vendored contract to equal cams-admin `main`). Tasks 2–8 → a second PR, released after; every new heartbeat field and command is optional or off by default, so cam-proxy before part A keeps working against both releases.

## Global Constraints

- **Public repository:** fixtures use ids like `cam1`/`cam4` and the existing id helpers, RFC 5737/2606 values only; no addresses, tokens or passwords in fixtures, tests or docs.
- **Tokens are stored as SHA-256 hashes only;** tests issue throwaway tokens through `a.ops.issue`/`a.diag.issue`; never log, audit or test with a real token. Actor of a token request: `ops-token:<8 hex>` (as today).
- **Camera passwords never pass through cams-admin:** no new route, command arg, result or view carries one; the secret guard tests (`test/diag.test.ts`) cover every new answer.
- **Contract frozen after Task 1:** Tasks 2–8 do not change `contract/` (`npm run contract:make` leaves no diff).
- `ONBOARDING_STEPS = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile']` (spec §4.5 order); `ONBOARDING_REQUIRED = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events']`; `ONBOARDING_CAMERAS_MAX = 64`; `ONBOARDING_STEP_LEN = 32`.
- Heartbeat `onboarding` (optional in both modes, also when truncated; `null` = none; older proxies omit it): strict `{<camera id>: {ready: boolean, missing: [step…]}}`, at most 64 keys, `missing` unique `ONBOARDING_STEPS`, and `ready: true` never with a required step in `missing`. Lenient: anything; read with clamps, never a reason to refuse the heartbeat.
- New command `camera.onboarding.get` (read; allow entry of the same name, on by default on cam-proxy). Time set is the new camera action `camera.action:camera-time-set` (disruptive: off by default per proxy, typed confirm, fleet gate, journal budget); FTP setup is the existing `camera.action:camera-ftp-setup`. No `camera.ftp.setup` or `camera.time.set` command kinds (ruling 2026-10-30). `time.zone` is local only (contract `denied`).
- Auto-adopt: per account, **off by default**; adopts only a reported, unregistered camera whose reported onboarding is `ready: true`; host `from-proxy`, model and name from the report; audit `camera-adopt`, `actorType: 'system'`, actor `system:auto-adopt`.
- **Enrollment stays a signed-in step** (no `enroll` scope, §10.4). Pins and certificate trust of cameras are never a cams-admin command (§10.2).
- Live status stays in memory: a heartbeat with an unchanged `onboarding` writes nothing (`test/write-budget.test.ts` stays green).
- `npm test`, `npm run lint:types`, `npm run check`, `npm run check:svelte` pass at every commit.

## Decisions beyond the spec

- **Camera actions, not kinds (ruling 2026-10-30, superseding "dedicated kinds"):** FTP setup and time set go through the existing `camera.action` path (`RemoteActions.cameraAction`, actions `camera-ftp-setup` and `camera-time-set`); the button is disabled when the proxy does not allow the entry.
- **`camera.onboarding.get`** (cam-proxy plan A): args `{v: 1, camera: <id> | null}` (null = every camera); result `{cameras: {<id>: {camera, ready, checkedAt, steps: {<step>: {ok: boolean|null, detail, action?}}, trust: {mode, fingerprint, served}, time: {clockOffsetMs, zone, cameraStdOffsetMinutes, cameraDst}}}, clamped?}`. The full status is fetched on demand (`POST …/cameras/:camera/onboarding/refresh`, scope `actions`); the views show the newest `done` result with its age. A GET never sends a command (diag stays read-only).
- **`missing`** lists every step whose `ok` is `false` (required or optional), plus the required steps whose `ok` is `null` (cam-proxy plan A `compactOf`), in `ONBOARDING_STEPS` order; run time reads `ready: true` with a required step in `missing` as `ready: false`. Unknown step names (a newer proxy) are kept by the parser (clamped), refused by strict.
- **Ready flips are status events** (`onboarding-ready` / `onboarding-not-ready`, camera ref), only on a change from a known previous value (like `camera-online`).
- **Auto-adopt never re-adopts what left:** a camera deleted from the registry or moved off a proxy writes an adopt block for `(proxyId, proxyCameraId)` (new table `adopt_blocks`); auto-adopt skips blocked refs and every proxy that is source or target of an open move. A manual adopt (session or `onboard` token) lifts the block. A failed auto-adopt (cams id taken, invalid name) is audited `camera-adopt` `outcome: 'refused'` once per `(proxy, ref)` and process run, until the camera stops being reported or ready.
- **Auto-adopt is set only with a sign-in** (`PATCH /accounts/:accountId` `{autoAdopt}` stays session-only).
- **Pins:** a proxy whose registry row has **no** CA pins takes the enrolled proxy's reported fingerprints automatically on its next heartbeat (audit `proxy-update`, `actorType: 'system'`, actor `system:proxy-report`). A **change** of existing pins is never automatic: the proxy page shows "Use the reported pins" (session, or ops `registry`: `POST …/proxies/:proxyId/pins/from-report`); the viewers then hold the changed proxy until confirmed, as today.
- **Ops scope `actions`** also covers the three new camera routes; `restart` stays in `actions` (spec §5). `config` covers the five config POST routes, `offboard` the camera DELETE.
- **The diag route** `GET /api/v1/diag/cameras/:camsId/onboarding` takes a cams id or a registry id (`cam_…`); a cams id found in several accounts answers 409 `ambiguous` unless `?accountId=` names one. The camera page is the proxy page's camera focus (`#/accounts/:a/proxies/:p?camera=<ref>`), served by the session route `GET /accounts/:accountId/proxies/:proxyId/cameras/:camera/onboarding` (works before the camera is adopted: `registry: null`).
- **Overall `ready`** in the view: proxy online, its onboarding `ready`, the camera registered, and every viewer serving the account (enrolled, route not hidden) reporting the current revision with nothing held or kept old for this camera or its proxy. A proxy that sends no `onboarding` gives `ready: false`, `missing: ['proxy:onboarding-unreported']`.

## Review Focus

1. **A camera in a move is reported by the target before the registry switches** (or still by the source after): auto-adopt must not create a second camera. Test in Task 6 (`auto-adopt skips a proxy with an open move`, `a moved camera is blocked on its old proxy`).
2. **Offboarding in cams-admin before the proxy dropped the camera:** the proxy keeps reporting it `ready`, and auto-adopt must not bring it back. Test in Task 6 (`a deleted camera is not re-adopted; a manual adopt lifts the block`).
3. **A proxy that lies or is newer:** `onboarding` with 200 cameras, a step name of 500 characters, `ready: true` with `login` missing, `missing` as a string. Heartbeat taken, values clamped, `ready` false where a required step is missing. Test in Task 2 (`parseOnboarding clamps and drops`).
4. **A failing auto-adopt on every heartbeat** (cams id taken in the account): one refusal audit, no write per heartbeat. Test in Task 6 (`a refused auto-adopt is audited once`).
5. **A malformed or foreign reported CA fingerprint** (`'abc'`, three entries, lower case): no pin is written, nothing thrown in the heartbeat path. Test in Task 5 (`unreadable reported pins are never taken`).

---

### Task 1: The contract: heartbeat `onboarding`, `camera.onboarding.get`, `camera-time-set`

> Rewritten after the coordinator's ruling of 2026-10-30 (aligned with cam-proxy plan A, Prerequisites 1): no `camera.ftp.setup` or `camera.time.set` kinds; time set is the camera action `camera-time-set`; `camera.onboarding.get` takes plan A's shapes; `time.zone` denied.

**Files:**
- Modify: `contract/build.ts` (constants; heartbeat body gains optional `onboarding`; `camera.onboarding.get` args/result schemas; `WIRE_COMMANDS`, `ALLOW_ENTRIES`; `REMOTE_ACTIONS` and `DISRUPTIVE_ACTIONS` gain `camera-time-set`; `REMOTE_SETTABLE.denied` gains `time.zone`)
- Modify: `contract/make.ts` (fixtures), `contract/README.md` (new section "Onboarding (heartbeat `onboarding`, camera commands)" after "Move leftovers")
- Modify: `server/contract.ts` (import the two new schema files), `server/commands/service.ts` (`WireCommand` gains `camera.onboarding.get`)
- Modify: `test-client/commands.ts` (`IMPLEMENTED` gains `ONBOARDING_COMMANDS`; args `{v: 1, camera: id | null}` closed; the budget counts `camera-time-set` through `DISRUPTIVE_ACTIONS`)
- Modify: `web/src/lib/config.ts` (`EFFECT['camera-time-set']`: the server already lists every remote action, so the new disruptive one needs its confirm text)
- Modify: `scripts/contract/cam-proxy-commands.ts` (feature `onboarding`: `ONBOARDING_STARTED = implemented('camera.onboarding.get')`, added to `FEATURE_STARTED`)
- Regenerate: `contract/v1/**`
- Test: `test/contract.test.ts`, `test/contract-commands.test.ts`, `web/src/lib/config.test.ts`

**Interfaces:**
- Produces (`contract/build.ts`):

```ts
export const ONBOARDING_STEPS = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile'] as const;
export const ONBOARDING_REQUIRED = ['reachable', 'login', 'trust', 'capabilities', 'stream', 'events'] as const;
export const ONBOARDING_CAMERAS_MAX = 64;
export const ONBOARDING_STEP_LEN = 32;
export const ONBOARDING_COMMANDS = ['camera.onboarding.get'] as const;
// REMOTE_ACTIONS and DISRUPTIVE_ACTIONS gain 'camera-time-set' (so ALLOW_ENTRIES gains camera.action:camera-time-set).
```
- Heartbeat body: `onboarding` optional (strict: ≤ 64 cameras, closed `{ready, missing}`, `missing` unique known steps, `ready: true` never with a required step missing; lenient `{}`).
- `camera.onboarding.get` args `{v: 1, camera: camId | null}`; result `{cameras: {<camId>: status} (≤ 64), clamped?}`, status `{camera, ready, checkedAt, steps: {<all 11>: {ok: bool|null, detail: str(200), action?: str(32)}}, trust: {mode: site-ca|pinned|public|none, fingerprint: fp|null, served: fp|null}, time: {clockOffsetMs: int|null, zone: str(64)|null, cameraStdOffsetMinutes: int|null, cameraDst: bool|null}}`.
- Fixtures: `valid-heartbeat-onboarding`, `valid-heartbeat-onboarding-null`, `drift-heartbeat-onboarding-unknown-step`, `drift-heartbeat-onboarding-ready-missing-login`, `valid-command-onboarding-get`, `valid-result-onboarding-get`, `valid-command-camera-time-set` (a `camera.action`), `refused-camera-action-time-set-not-allowed`, `valid-result-camera-time-set-verified`; the command fixtures carry `$context.feature: 'onboarding'`.

- [x] Steps as before (tests first, make, README, cross-check, full suite); see the ledger and the commit.

---

### Task 2: The heartbeat's `onboarding` in the reported state

**Files:**
- Create: `server/status/onboarding.ts`
- Modify: `server/status/derive.ts` (`Reported.onboarding?: Record<string, CameraOnboarding> | null`), `server/status/store.ts` (`HeartbeatBody.onboarding?: unknown`; heartbeat reads it; ready-flip events; a generic `onHeartbeat?: (proxyId: string) => void` hook called after the existing hooks), `server/diag/views.ts` (`diagProxies` item `reported.onboarding`), `test-client/client.ts` (option `onboarding?: () => unknown`, sent like `profile`)
- Test: `test/status-onboarding.test.ts`, `test/diag.test.ts`, `test/write-budget.test.ts`

**Interfaces:**
- Consumes: Task 1's `ONBOARDING_STEPS`, `ONBOARDING_REQUIRED`, `ONBOARDING_CAMERAS_MAX`, `ONBOARDING_STEP_LEN`, `CAMERA_ID_PATTERN`.
- Produces:

```ts
// server/status/onboarding.ts
export interface CameraOnboarding { ready: boolean; missing: string[] }
// null for undefined/null/non-object (the proxy sends none); {} for an object with nothing readable.
export function parseOnboarding(x: unknown): Record<string, CameraOnboarding> | null;
```
  Keys matching `CAMERA_ID_PATTERN`, at most 64 (first kept); values objects with boolean `ready` (else the camera is dropped); `missing`: strings only, each `^[a-z][A-Za-z0-9-]*$` cut to 32 characters, unique, at most 16 (a non-array → `[]`); `ready` becomes `false` when `missing` holds an `ONBOARDING_REQUIRED` step.
- Store: `reported.onboarding = parseOnboarding(body.onboarding)`; for each camera whose previous `ready` is known and differs: `ev(ready ? 'onboarding-ready' : 'onboarding-not-ready', ref, { missing })`.
- `/api/v1/diag/proxies`: `reported.onboarding` (null when the proxy sends none).

- [ ] **Step 1: Write the failing tests**
  - `status-onboarding.test.ts`: `parseOnboarding reads a valid map`; `parseOnboarding returns null for none` (`undefined`, `null`, `'x'`, `[]`); `it.each('parseOnboarding clamps and drops: %s')` — 200 cameras → 64; key `Cam 1` dropped; `{ready: 'yes'}` dropped; a step of 500 characters → 32; `missing` `'login'` (a string) → `[]`; duplicate steps once; 20 steps → 16; `ready: true` with `missing: ['login']` → `ready: false`; an unknown step `lens` kept; `the heartbeat keeps onboarding; a later one without it clears it to null`; `a ready flip writes one status event; the first report and an unchanged one write none`.
  - `diag.test.ts`: `diag proxies show onboarding` (heartbeat with `{cam1: {ready: true, missing: []}}` → `reported.onboarding` equal).
  - `write-budget.test.ts`: `20 proxies heartbeating an unchanged onboarding for an hour stay within the budget` (the first test's budget, with `onboarding` in each heartbeat).
- [ ] **Step 2: Run** `npx vitest run test/status-onboarding.test.ts test/diag.test.ts test/write-budget.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block and the test-client option.
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/status server/diag/views.ts test-client/client.ts test/status-onboarding.test.ts test/diag.test.ts test/write-budget.test.ts && git commit -m "feat: read each camera's onboarding status from the heartbeat"`

---

### Task 3: Ops scopes `actions`, `config`, `offboard`

**Files:**
- Modify: `server/ops/tokens.ts` (`OPS_SCOPES` gains `'actions', 'config', 'offboard'`), `server/ops/scopes.ts` (routes below), `web/src/pages/Diagnostics.svelte` (scope texts), `docs/diagnostics.md` (scope table rows and one curl example per scope)
- Test: `test/ops-auth.test.ts`

**Interfaces:**
- Produces (`OPS_ROUTES` additions; `proxyBase = '/accounts/:accountId/proxies/:proxyId'`):
  - `actions`: `POST ${proxyBase}/actions`, `POST ${proxyBase}/cameras/:camera/name`, `POST ${proxyBase}/restart`
  - `config`: `POST ${proxyBase}/config/refresh`, `/config/preview`, `/config/apply`, `/config/rollback/preview`, `/config/rollback/apply`
  - `offboard`: `DELETE /accounts/:accountId/cameras/:cameraId`
- Scope texts: `actions` "Run camera actions, rename cameras, restart proxies (as each proxy allows)"; `config` "Preview and apply proxy settings (the allowed ones)"; `offboard` "Remove a camera from its account".
- The existing comment "as does deleting a camera" in `scopes.ts` goes.

- [ ] **Step 1: Write the failing tests** (`ops-auth.test.ts`, next to `an onboard token adopts…`):
  - `an actions token runs a camera action, renames and restarts; a config token may not` (the action route answers 202 with a `commandId` against a proxy whose heartbeat allows `camera.action:camera-test` and `camera.name.set`; the audit `command-create` actor is `ops-token:<prefix>`; with scope `config` 403 `scope`, nothing written).
  - `a config token previews and applies; an actions token may not`.
  - `an offboard token deletes a camera (audit camera-delete, token actor); a registry token may not`.
  - The coverage test and `every other table route reaches its handler with a token in scope` stay green with the new rows.
- [ ] **Step 2: Run** `npx vitest run test/ops-auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block; the docs rows.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check:svelte` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/ops web/src/pages/Diagnostics.svelte docs/diagnostics.md test/ops-auth.test.ts && git commit -m "feat: ops scopes actions, config and offboard"`

---

### Task 4: The onboarding commands in cams-admin

> Changed by the ruling of 2026-10-30: FTP setup and time set are camera actions (`camera-ftp-setup`, `camera-time-set`) and go through the existing `RemoteActions.cameraAction` (typed confirm = the action name, fleet gate, busy rule, `DISRUPTIVE_SQL` already counts disruptive `camera.action` rows); `EFFECT['camera-time-set']` landed in Task 1. Only the onboarding refresh is new here.

**Files:**
- Modify: `server/actions/service.ts` (`onboardingRefresh`; `available()` gains `onboarding`), `server/commands/service.ts` (`summariseArgs` for `camera.onboarding.get`: `{v, camera}`; `latest()`), `server/api/router.ts` (one route), `server/ops/scopes.ts` (the route, scope `actions`), `test-client/commands.ts` + `test-client/client.ts` (answer `camera.onboarding.get` from the client's `onboarding` option per camera; `test-client/config.ts` `CAMERA_WRITES` gains `camera-time-set`)
- Test: `test/remote-actions.test.ts`, `test/ops-auth.test.ts`

**Interfaces:**
- Consumes: Task 1's `ONBOARDING_COMMANDS`, `REMOTE_ACTIONS`/`DISRUPTIVE_ACTIONS` with `camera-time-set`; Task 3's `actions` scope.
- Produces:

```ts
// RemoteActions (server/actions/service.ts)
onboardingRefresh(actor: string, accountId: string, proxyId: string, camera: string): { commandId: string };          // camera.onboarding.get {v: 1, camera}
// Available gains:
onboarding: { get: boolean; ftpSetup: boolean; timeSet: boolean };   // entries camera.onboarding.get, camera.action:camera-ftp-setup, camera.action:camera-time-set present on the proxy
// Commands (server/commands/service.ts): the newest row of that command for that camera, any state; null when none.
latest(proxyId: string, command: string, camera: string): CommandRow | null;
```
  Camera checked with `CAM_RE` (400 `invalid` `camera`); the same 10-s busy rule as `cameraAction` (key `proxy|camera|command`).
- Route (202 `{commandId}` via `accepted`): `POST ${proxyBase}/cameras/:camera/onboarding/refresh`, in `OPS_ROUTES` with scope `actions`. Time set and FTP setup: the existing `POST ${proxyBase}/actions` with `{camera, action: 'camera-time-set' | 'camera-ftp-setup', confirm: <action>}`.

- [ ] **Step 1: Write the failing tests**
  - `remote-actions.test.ts`: `onboarding refresh sends camera.onboarding.get {v:1, camera}`; `camera-time-set without the typed confirm is 400 confirm_required, nothing queued`; `camera-time-set is refused with 409 not_allowed_on_proxy until the proxy allows camera.action:camera-time-set`; `camera-time-set counts against the fleet gate` (a queued `camera-ftp-setup` on another proxy → 409 `fleet_busy`; three in ten minutes → 429 `fleet_limit`); `a double click within 10 s is busy`; `available() reports the onboarding entries`; `latest() returns the newest row for that camera only`.
  - `ops-auth.test.ts`: `an actions token refreshes onboarding and sets the time; an offboard token may not`.
- [ ] **Step 2: Run** `npx vitest run test/remote-actions.test.ts test/ops-auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block and the test-client answers.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/actions server/commands server/api/router.ts server/ops/scopes.ts test-client test/remote-actions.test.ts test/ops-auth.test.ts && git commit -m "feat: onboarding refresh; time set as a camera action"`

---

### Task 5: Site-CA pins from the proxy's report

**Files:**
- Create: `server/onboarding/pins.ts`
- Modify: `server/registry.ts` (`setProxyPins`), `server/api/router.ts` (`POST ${proxyBase}/pins/from-report`), `server/ops/scopes.ts` (that route, scope `registry`), `server/server.ts` (wire into `status.onHeartbeat`), `web/src/pages/Proxy.svelte` (Reconciliation: "Use the reported pins" button when `pin` is `mismatch` or `hint` and the report has fingerprints; the Registry field's label says the pins fill themselves on the first heartbeat)
- Test: `test/onboarding-pins.test.ts`, `test/ops-auth.test.ts`

**Interfaces:**
- Consumes: Task 2's `onHeartbeat` hook; `normaliseFingerprint` (`server/validate.ts`).
- Produces:

```ts
// server/registry.ts: validates each with normaliseFingerprint, 1..2 entries (400 invalid caFingerprints otherwise);
// version-free (no row version), one audit `proxy-update` {fields: ['caFingerprints'], from: 'proxy-report', auto}.
setProxyPins(actor: string, actorType: 'sysadmin' | 'system', accountId: string, proxyId: string, fps: string[], auto: boolean): Proxy;
// server/onboarding/pins.ts
export class ReportedPins {
  constructor(d: { registry: Registry; status: StatusStore; live: LiveHub });
  onHeartbeat(proxyId: string): void;                                 // auto: only when the registry row has no pins
  take(actor: string, accountId: string, proxyId: string): { proxy: Proxy; changed: boolean };   // the route
}
```
  `onHeartbeat`: proxy `state === 'enrolled'`, registry `caFingerprints` empty, reported `caFingerprint` 1..2 entries all valid → `setProxyPins('system:proxy-report', 'system', …, auto: true)`, publish `registry` `proxy`; never throws (an unreadable report is skipped). `take`: 409 `no_reported_pins` when the report has none or an unreadable one; equal to the registry → `changed: false`, no write, no audit.

- [ ] **Step 1: Write the failing tests** (`onboarding-pins.test.ts`)
  - `a proxy without pins takes the reported ones on its heartbeat (audit system:proxy-report, auto true)`.
  - `pins that differ are not changed by a heartbeat; take() changes them (audit with the session actor)`.
  - `take() with equal pins writes nothing`.
  - `unreadable reported pins are never taken` (`['abc']`, three entries, lower-case hex: no write, no throw; `take` → 409 `no_reported_pins`).
  - `a pending or revoked proxy takes nothing`.
  - `ops-auth.test.ts`: `a registry token takes the reported pins; an onboard token may not`.
- [ ] **Step 2: Run** `npx vitest run test/onboarding-pins.test.ts test/ops-auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block, the route, the wiring and the button.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check:svelte` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/onboarding/pins.ts server/registry.ts server/api/router.ts server/ops/scopes.ts server/server.ts web/src/pages/Proxy.svelte test/onboarding-pins.test.ts test/ops-auth.test.ts && git commit -m "feat: take a proxy's site-CA pins from its report"`

---

### Task 6: Auto-adopt per account

**Files:**
- Create: `server/onboarding/autoAdopt.ts`
- Modify: `server/db/migrations.ts` (migration 17), `server/validate.ts` (`accountInput` gains `autoAdopt: bool(b, 'autoAdopt')`, default `false`), `server/registry.ts` (`Account.autoAdopt`; `COLUMNS.autoAdopt = 'auto_adopt'`, `dbValue` as `disabled`; `createCamera` optional `actorType`; `deleteCamera` and `moveCamera` write an adopt block for the old `(proxyId, proxyCameraId)`; `isAdoptBlocked`, `liftAdoptBlock`; `camera-delete` audit detail gains `{proxyId, proxyCameraId}`), `server/api/router.ts` (the adopt route lifts the block), `server/server.ts` (wiring), `web/src/pages/Account.svelte` (overview: checkbox "Add cameras automatically when their proxy reports them ready", saved with the account)
- Test: `test/auto-adopt.test.ts`, `test/db.test.ts` (the migration count/latest version assertion), `test/registry.test.ts`

**Interfaces:**
- Consumes: Task 2's `reported.onboarding` and `onHeartbeat`; `reconcile` (`server/status/derive.ts`).
- Produces:
  - Migration 17: `ALTER TABLE accounts ADD COLUMN auto_adopt INTEGER NOT NULL DEFAULT 0 CHECK (auto_adopt IN (0, 1)); CREATE TABLE adopt_blocks (proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE, proxy_camera_id TEXT NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('deleted', 'moved')), blocked_at INTEGER NOT NULL, PRIMARY KEY (proxy_id, proxy_camera_id));`

```ts
// server/registry.ts
createCamera(actor: string, accountId: string, input: unknown, action?: 'camera-create' | 'camera-adopt', actorType?: 'sysadmin' | 'system'): Camera;
isAdoptBlocked(proxyId: string, proxyCameraId: string): boolean;
liftAdoptBlock(proxyId: string, proxyCameraId: string): void;
// server/onboarding/autoAdopt.ts
export const AUTO_ADOPT_ACTOR = 'system:auto-adopt';
export class AutoAdopt {
  constructor(d: { db: Db; registry: Registry; status: StatusStore; audit: Audit; live: LiveHub });
  onHeartbeat(proxyId: string): Camera[];   // the cameras it adopted
}
```
  `onHeartbeat`: proxy enrolled, its account `autoAdopt`, no open move with this proxy as source or target; for each `reconcile(...).reportedNotRegistered` ref with `reported.onboarding[ref]?.ready === true`, not blocked, not tried: `createCamera(AUTO_ADOPT_ACTOR, accountId, {camsId: proposedCamsId, name: reported name ?? ref, kind: 'camera', proxyId, proxyCameraId: ref, model, host: 'from-proxy'}, 'camera-adopt', 'system')`, publish `registry` `camera`. On an `ApiError`/`FieldError`: one audit `camera-adopt` `outcome: 'refused'` `{proxyId, proxyCameraId, reason: <code or field>}` and the `(proxy, ref)` pair is remembered in memory; the memory entry goes when the ref is no longer reported or no longer ready. Never throws into the heartbeat.

- [ ] **Step 1: Write the failing tests** (`auto-adopt.test.ts`; heartbeats through `StatusStore` as in `status-leftovers.test.ts`)
  - `off by default: a ready camera is not adopted`.
  - `on: a ready camera is adopted (host from-proxy, model and name from the report, audit camera-adopt actorType system, actor system:auto-adopt)`.
  - `a camera that is not ready, or a proxy that sends no onboarding, is not adopted`.
  - `auto-adopt skips a proxy with an open move` (source and target).
  - `a moved camera is blocked on its old proxy` (after `moveCamera`, the old proxy reporting the ref ready adopts nothing).
  - `a deleted camera is not re-adopted; a manual adopt lifts the block` (then a later delete blocks again).
  - `a refused auto-adopt is audited once` (cams id taken in the account; ten heartbeats → one refusal row, no camera; the camera reported not-ready and ready again → a second attempt).
  - `registry.test.ts`: `autoAdopt defaults to false and is set by PATCH (audit fields ['autoAdopt'])`; `deleteCamera audit names proxyId and proxyCameraId`.
- [ ] **Step 2: Run** `npx vitest run test/auto-adopt.test.ts test/registry.test.ts test/db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block, the wiring (`status.onHeartbeat` runs pins first, then auto-adopt) and the checkbox.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check:svelte` — Expected: PASS (`write-budget` included).
- [ ] **Step 5: Commit** `git add server/onboarding/autoAdopt.ts server/db/migrations.ts server/validate.ts server/registry.ts server/api/router.ts server/server.ts web/src/pages/Account.svelte test/auto-adopt.test.ts test/registry.test.ts test/db.test.ts && git commit -m "feat: auto-adopt ready cameras per account (off by default)"`

---

### Task 7: The onboarding view (diag API and session route)

**Files:**
- Create: `server/onboarding/view.ts`
- Modify: `server/diag/router.ts` (route and `ROUTES` entry `/diag/cameras/:camsId/onboarding?accountId=`), `server/api/router.ts` (`GET ${proxyBase}/cameras/:camera/onboarding`), `docs/diagnostics.md` (the row and an example), `docs/onboarding-a-camera.md` (scripted path: auto-adopt or `onboard`, the `actions` commands, polling the view until `ready`)
- Test: `test/onboarding-view.test.ts`, `test/diag.test.ts`

**Interfaces:**
- Consumes: Task 2's `reported.onboarding`; Task 4's `commands.latest()`; `snapshotRevision`, `camsInstances.list()/routes()`.
- Produces:

```ts
export interface ViewerState {
  instanceId: string; name: string; state: string; lastSeenAt: number | null; reportAt: number | null;
  hidden: boolean;                  // the instance's route for this proxy is hidden
  applied: boolean | null;          // report.appliedRevision === current revision; null without a report
  held: string[]; heldProxy: string[]; keptOld: string[];   // fields for this camsId / this proxy
  problems: { code: string; detail: string | null }[];      // the report's problems for this account (or accountId null)
}
export interface OnboardingView {
  camera: { id: string; accountId: string; camsId: string; name: string; kind: string; model: string | null; proxyCameraId: string | null; host: string | null; protocol: string | null; tlsServername: string | null; rowVersion: number; moveId: string | null } | null;
  proxy: { id: string; name: string; state: string; connected: boolean; lastHeartbeatAt: number | null; version: string | null; pin: string; commands: string; onboardingAllowed: { get: boolean; ftpSetup: boolean; timeSet: boolean } };
  proxyCameraId: string; online: boolean | null;
  reported: { ready: boolean; missing: string[] } | null;
  detail: { cmdId: string; state: string; finishedAt: number | null; result: Record<string, unknown> | null } | null;   // the newest camera.onboarding.get (result.cameras[proxyCameraId], plan A's status)
  viewers: ViewerState[];
  ready: boolean; missing: string[];
}
export function onboardingView(d: ApiDeps, accountId: string, proxyId: string, proxyCameraId: string): OnboardingView;
export function onboardingByCamsId(d: ApiDeps, idOrCamsId: string, accountId?: string): OnboardingView;   // 404 not_found, 409 ambiguous, 409 no_proxy
```
  `missing` (in this order): `proxy-offline`, `proxy:onboarding-unreported`, `proxy:<step>` per reported missing step, `not-registered`, `viewer:<name>:no-report|not-applied|held|kept-old` per viewer (enrolled, not hidden, serving the account). `ready` = `missing` is empty and `reported.ready`. Named fields only (no spread from a row; no notes, hashes, tokens); `detail.result` passes through `sanitize` as `commands.get` does.

- [ ] **Step 1: Write the failing tests** (`onboarding-view.test.ts`)
  - `a registered, ready camera with one viewer that applied the current revision is ready`.
  - `missing names each gap` (proxy offline; reported `missing: ['login']` → `proxy:login`; a viewer that holds `host` for this camsId → `viewer:<name>:held`; a hidden route is listed with `hidden: true` and not counted).
  - `before the adopt: camera null, missing has not-registered`.
  - `a proxy without onboarding: reported null, missing proxy:onboarding-unreported`.
  - `detail is the newest camera.onboarding.get of this camera`.
  - `diag.test.ts`: `diag camera onboarding by cams id, by registry id; ambiguous across accounts unless accountId; 404 for unknown`; the secret-guard test calls the new route too (markers never appear).
- [ ] **Step 2: Run** `npx vitest run test/onboarding-view.test.ts test/diag.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block, both routes and the docs.
- [ ] **Step 4: Run** `npm test && npm run lint:types` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/onboarding/view.ts server/diag/router.ts server/api/router.ts docs/diagnostics.md docs/onboarding-a-camera.md test/onboarding-view.test.ts test/diag.test.ts && git commit -m "feat: one onboarding view per camera (diag and session)"`

---

### Task 8: The camera page

**Files:**
- Create: `web/src/components/CameraOnboarding.svelte`, `web/src/lib/onboarding.ts`, `web/src/lib/onboarding.test.ts`, `e2e/onboarding.spec.ts`
- Modify: `web/src/pages/Proxy.svelte` (render `<CameraOnboarding {accountId} {proxyId} {camera} {refresh} />` above `ProxyCameraActions` when `camera` is set; in Live status, each camera row gets a chip from `d.reported?.onboarding?.[id]`), `web/src/pages/Account.svelte` (cameras tab: the existing proxy-camera link gets the title "onboarding and camera actions"), `CHANGELOG.md`
- Test: `web/src/lib/onboarding.test.ts`, `e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: Task 4's routes and `Available.onboarding`; Task 7's session route and `OnboardingView`.
- Produces (`web/src/lib/onboarding.ts`):

```ts
export const STEP_LABEL: Record<string, string>;   // reachable "Reachable", login "Camera login", trust "Certificate trusted", capabilities "Capabilities read", stream "Video stream", events "Events", ftp "Clip upload (FTP)", time "Time", name "Name", poe "PoE port", profile "Within the proxy's profile"; unknown steps shown as their name
export function missingText(m: string): string;    // 'proxy:login' → "Proxy: Camera login missing"; 'viewer:home:held' → "Viewer home: holds a change (confirm it in that viewer)"; 'not-registered' → "Not in the account yet"
export function viewerLine(v: ViewerState): string; // "applied" | "not applied yet" | "holds: host" | "kept old: host" | "no report yet" | "hidden here"
```
- `CameraOnboarding.svelte` (`data-testid="camera-onboarding"`): a ready chip (`onboarding-ready`), the proxy's step list from `detail.result.cameras[<camera>].steps` (an object keyed by step, `{ok, detail, action?}`) when present (else the compact `reported`), the registry row (cams id, name, model, host) or "Not in the account yet" with the adopt button the Reconciliation card already has, one row per viewer (`onboarding-viewer-<name>`), the missing list; buttons `Refresh status`, `Set time` (`camera.action:camera-time-set`), `FTP setup` (`camera.action:camera-ftp-setup`) (the last two `btn danger`, disabled with title "not allowed on the proxy" unless `onboardingAllowed`, a `Confirm` with `typed` = the action name and `EFFECT` text, sent through the existing actions route), results through `waitCommand` as `ProxyCameraActions` does.

- [ ] **Step 1: Write the failing tests**
  - `onboarding.test.ts`: `missingText for proxy steps, viewers and not-registered`; `an unknown step reads as its name`; `viewerLine for each state`.
  - `e2e/onboarding.spec.ts` (take the e2e lock first): `the camera page shows a ready camera; Set time is disabled until the proxy allows camera.action:camera-time-set, then asks for the typed action name and shows the result` (test-client proxy with `onboarding` option and allow entries).
- [ ] **Step 2: Run** `npx vitest run web/src/lib/onboarding.test.ts` and `npx playwright test e2e/onboarding.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block and the page changes.
- [ ] **Step 4: Run** `npm test && npm run check && npm run check:svelte && npx playwright test e2e/onboarding.spec.ts e2e/remote-config.spec.ts` — Expected: PASS.
- [ ] **Step 5: CHANGELOG** (Unreleased, one user-terms entry): cameras can be onboarded by script end to end: new operations scopes (actions, settings, removing a camera), automatic adding of ready cameras per account (off by default), site-CA pins taken from the proxy, and one onboarding status per camera in the diagnostics API and on the camera page (with cam-proxy's next release).
- [ ] **Step 6: Commit** `git add web/src/components/CameraOnboarding.svelte web/src/lib/onboarding.ts web/src/lib/onboarding.test.ts web/src/pages/Proxy.svelte web/src/pages/Account.svelte e2e/onboarding.spec.ts CHANGELOG.md && git commit -m "feat: the camera page shows onboarding and runs the onboarding commands"`
