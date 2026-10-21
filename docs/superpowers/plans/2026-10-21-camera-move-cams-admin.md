# Camera move — cams-admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams-admin runs camera moves between two proxies of one account: the wire contract, the move job (a DB state machine), the registry switch-over, the snapshot markers for cams, and a sysadmin Moves page.

**Architecture:** Proxies talk to cams-admin only over the existing outbound WebSocket. New proxy-originated **events** (`move.*`, no `cmdId`) start and steer a move; cams-admin answers with short signed **commands** (`move.*`). A `moves` row plus `move_chunks` rows hold the job; `Moves.tick()` and incoming events re-derive the next step from the row, so a restart resumes. Content and passwords never pass through cams-admin.

**Tech Stack:** TypeScript (Node ≥ 26, CommonJS), Express 5, `ws`, `node:sqlite` (STRICT tables), ajv contract, Svelte 5, vitest, Playwright.

**Spec:** `~/Development/cam-proxy/docs/superpowers/specs/2026-10-21-camera-move-design.md` (cam-proxy main, merged via PR #232). Cited as **S §n**.

**Sibling plans:** cam-proxy `docs/superpowers/plans/2026-10-21-camera-move-cam-proxy.md`, cams `docs/superpowers/plans/2026-10-21-camera-move-cams.md`.

**Execution order across repos:** this plan's **Task 1** (contract) merges first → cam-proxy plan → this plan's Tasks 2–9 → cams plan (may start after Task 1) → this plan's Task 10 (localstack end to end, needs cam-proxy main with moves).

## Global Constraints

- Repo is public: no real addresses, serials, tokens or passwords; fixtures use RFC 5737 addresses (192.0.2.x, 198.51.100.x).
- A change to a command, result or event goes into `contract/` first (`npm run contract:make`; committed output must equal a fresh build).
- Never write a token, a password, a sealed blob or an X25519 private key into the DB, an audit record, a log line or a snapshot. The move token's plaintext exists only in the `move.offer` args; blank those args when the command is final.
- Inject `Clock` (server/clock.ts); never `Date.now()`.
- Write transactions cost S3 uploads: coalesce progress; `test/write-budget.test.ts` stays green.
- Rate limits never key on client address.
- CHANGELOG.md: user-visible lines under `## [Unreleased]`.
- Move ids: `newId('mv')` (the repo's 20-char Crockford shape, not the spec's `mv_<ulid>` — Ruling R1).
- One active move per proxy (as source or target) (S §6 `busy`).
- Offer not approved within 30 min expires (S §7).

## Rulings (made while planning; cost if wrong in each)

- **R1** Move id shape follows `server/ids.ts` (`mv_` + 20 chars). — Consistency with every other id; spec said ulid. — Cost: none functional.
- **R2** Proxy-initiated messages are new signed `event` kinds without `cmdId`: `move.targets`, `move.request`, `move.approve`, `move.cancel`, `move.phase`, `move.progress`. The existing `command.done` keeps its shape. — Only path a proxy has to cams-admin. — Cost: a contract revision if a generic "proxy request" shape is wanted later.
- **R3** Commands are short; long work is announced by events. Command list (role → allow entry): `move.targets` (source, `move.send`), `move.open` (source, `move.send`), `move.offer` (target, `move.receive`), `move.answer` (source, `move.send`), `move.start` (target, `move.receive`), `move.go` (source, `move.send`), `move.release` (source, `move.send`), `move.finish` (source, `move.send`), `move.cancel` (`args.role` source → `move.send`, target → `move.receive`). — The queue is serial per proxy with 60 s envelopes (fact sheet). — Cost: one more command if a step is found missing.
- **R4** The per-move bearer token is created at `move.request`; its SHA-256 goes to the source in `move.open`, its plaintext to the target in `move.offer` (needed for the throughput probe before the panel). Bound to the IP of the target's registry `url` host (resolved once if a name). — Cost: if a target URL is a hostname that resolves differently on the source, the source refuses the target (visible as a `move.phase failed` with `token_address`).
- **R5** Snapshot gets `proxy.site` (from `proxies.tls_site`, nullable) and `camera.moveId` (nullable). cams derives nothing from TLS names. — Cost: none; additive.
- **R6** cams report gains optional `heldProxies: [{accountId, proxyId, fields}]` for the trusted-proxy banner (cams plan). — Contract owned here.
- **R7** Precheck refuses a target not routed (visible) to every cams instance the source is routed to (`not_routed`), and refuses when the camera has a per-instance `cams_camera_overrides.host` (`host_overridden`) — the camera would disappear or change host at switch-over. Not in the spec's reason table. — Cost: one extra manual step for those setups.
- **R8** Chunk states persist at most once a minute per move plus at every phase change; `move.progress` between those updates memory and the SSE only. — Write budget. — Cost: after a cams-admin crash the target's journal (authoritative for files) re-reports; nothing is re-copied.
- **R9** Host-wide retention/limits are the target's own; only the camera's per-camera settings move (cam-proxy holds retention host-wide — fact sheet). The "change retention on the target" space option sends `targetSettings` (host-wide paths) inside the approved plan. — Spec said "camera keeps retention"; code makes retention host-wide. — Cost: the panel wording (cam-proxy plan) must say "on the target proxy".

## Review Focus

1. A proxy reconnects in the middle of a move (either side): the next step is re-sent, never skipped, never doubled — Task 5 `resumes after reconnect`.
2. Two `move.request`s for the same camera, or for two cameras of one proxy, arrive close together: the second gets `busy`, never a second job — Task 4 `second request is busy`.
3. The target goes offline between `move.offer` and its result: the move fails visibly after the command gives up (15 min), not stuck in `offered` — Task 5 `offer that never answers fails`.
4. A sysadmin cancels while `move.release` is in flight: the camera ends on the source, registry back, moveId cleared — Task 6 `cancel during release`.
5. The move token never appears in `commands.args` after the command is final, in audit detail, in the snapshot or in an API answer — Task 3 `token never stored after final`, Task 7 `snapshot has no token`.

---

### Task 1: Contract v1 and cams-v1 for moves

**Files:**
- Modify: `contract/build.ts` (WIRE_COMMANDS :278, ALLOW_ENTRIES :285, event body :136, new args/result schemas next to camera.name.set :201/:214), `contract/cams-build.ts` (camera :57, proxy, report request)
- Modify: `scripts/contract/make-vectors.ts` (vectors for one move command and one move event), `scripts/contract/cam-proxy-commands.ts` (:49 pending logic)
- Modify: `contract/README.md` (check order rows, per-command rate windows), `contract/cams-v1/README.md`
- Generated: `contract/v1/**`, `contract/cams-v1/**` via `npm run contract:make`
- Test: `test/contract.test.ts`, `test/contract-commands.test.ts`, `test/contract-events.test.ts` (new)

**Interfaces:**
- Produces (wire, consumed by cam-proxy and cams plans — names exact):
  - Allow entries: `move.send`, `move.receive`.
  - Commands and args (all `v:1`, `moveId` pattern `^mv_[0-9A-HJKMNP-TV-Z]{20}$`):
    - `move.targets` `{v, requestId, targets:[{proxyId, name, site}]}` → result `{}`
    - `move.open` `{v, moveId, requestId, camera, tokenHash, targetIp}` → `{}`
    - `move.offer` `{v, moveId, token, source:{proxyId, name, url, caFingerprints, tlsServername}, camera:{camsId, proxyCameraId, name, host, protocol, user, onvifPort, rtspPort, baichuanPort}, summary, settings}` → `{accept:true, space, probeBps}` | `{accept:false, reason}`; `reason` ∈ `moves_not_allowed|camera_unreachable|camera_limit|id_taken|busy|incompatible|no_site_ca|ca_does_not_cover_camera|external_cert`
    - `move.answer` `{v, moveId, requestId, target:{proxyId, name}, accept, reason?, space?, estimateS?}` → `{}`; `reason` ∈ the `move.offer` reasons ∪ `other_account|target_offline|not_routed|host_overridden|target_failed|offer_expired`
    - `move.start` `{v, moveId, plan, settings, done:[chunkId]}` → `{publicKey, leafFingerprint}` (`publicKey` = X25519 SPKI DER base64; `leafFingerprint` = `SHA256:<64 HEX>`)
    - `move.go` `{v, moveId, plan, targetPublicKey, expectedLeaf}` → `{}`
    - `move.release` `{v, moveId}` → `{}`
    - `move.finish` `{v, moveId, abandoned:boolean}` → `{deleted:{<kind>:{files, bytes}}}`
    - `move.cancel` `{v, moveId, role:'source'|'target', copied:'delete'|'age-out', expectedLeaf?}` → `{}`
  - `summary` = `{<kind>: {files, bytes, rows, oldest, newest}}` for kind ∈ `stills|clips|events|checks|archive` (times unix ms, nullable when empty).
  - `settings` = the cam-proxy per-camera node (`name, statusPollS, ftp{enabled,stream}, stills{enabled,stream,intervalS}, storage{sharePercent}, analytics{kinds{person,vehicle,pet}}, events{poll{enabled}}`) — object, `additionalProperties:false` in strict.
  - `plan` = `{transfer:boolean, kinds:[kind], space:'all'|'omit'|'fit'|'retention', targetSettings:{<path>:<value>}|null, budgetS, estimateS}`.
  - `space` = `{needed, available, fits:boolean, perKind:{<kind>:bytes}, retentionProposal:{<path>:<value>}|null}`.
  - Events (envelope `event`, no `cmdId`; `kind` added to the enum):
    - `move.targets` `{kind, requestId, camera}`
    - `move.request` `{kind, requestId, camera:{proxyCameraId, name, host, protocol, user, onvifPort, rtspPort, baichuanPort}, target, actor:{origin:'local'|'managed', label}, summary, settings}` (the camera's connection fields come from the source's config; never a password)
    - `move.approve` `{kind, moveId, plan}`
    - `move.cancel` `{kind, moveId, copied}`
    - `move.phase` `{kind, moveId, role, phase, ok:boolean, code?, detail?}`; `phase` ∈ `opened|switching|switched|released|copying|copied|finished|cancelled|failed`
    - `move.progress` `{kind, moveId, chunks:[{id, state}], bytesDone, bytesTotal, rateBps, etaS}`; chunk `id` = `<kind>:<YYYY-MM-DD>`; `state` ∈ `pending|copied|verified|skipped|failed`
  - cams-v1: snapshot `proxies[].site: string|null`, `cameras[].moveId: string|null`; report request optional `heldProxies:[{accountId, proxyId, fields}]` (fields ⊂ `proxyUrl|caFingerprints|proxyTlsServername`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/contract-events.test.ts
it('accepts every move event kind without cmdId', () => {
  for (const f of fixtures().filter(f => f.name.startsWith('valid-event-move-'))) expect(strictValid('event', f.message.body)).toBe(true);
});
it('refuses a move.progress chunk id that is not <kind>:<date>', () => {
  expect(strictValid('event', { kind: 'move.progress', moveId: MV, chunks: [{ id: 'clips', state: 'copied' }], bytesDone: 0, bytesTotal: 1, rateBps: 0, etaS: 0 })).toBe(false);
});
it('still requires cmdId, phase and status for command.done', () => { /* existing fixture stays valid; body without cmdId invalid */ });
// test/contract-commands.test.ts
it.each(['move.targets','move.open','move.offer','move.answer','move.start','move.go','move.release','move.finish','move.cancel'])('%s has args and result schemas, strict and lenient', ...);
it('heartbeat allow enum contains move.send and move.receive', ...);
it('move.offer refuse reasons are the closed list', ...);
// test/contract.test.ts (cams-v1)
it('snapshot camera requires moveId (nullable) and proxy requires site (nullable) in strict', ...);
it('report heldProxies is optional and fields are the three proxy fields', ...);
```

- [ ] **Step 2: Run** `npx vitest run test/contract-events.test.ts test/contract-commands.test.ts test/contract.test.ts` — Expected: FAIL (schemas missing).
- [ ] **Step 3: Implement** the schemas in `contract/build.ts` and `contract/cams-build.ts`; fixtures `valid-command-move-*.json`, `refused-move-offer-not-allowed.json` (`$expect.runtime: "not_allowed"`), `valid-event-move-*.json`, `invalid-event-move-progress-bad-chunk.json`; vectors for `move.offer` and `move.progress`. README rows: per-command windows `move.*` 60/min per proxy (same as config.get); check order unchanged. `npm run contract:make`.
- [ ] **Step 4: Make the cam-proxy cross-check tolerate the new group:** in `scripts/contract/cam-proxy-commands.ts` add `const MOVE = [...]` and `MOVE_STARTED = MOVE.some(implemented)`; a move fixture is `pending` while `!MOVE_STARTED` (same rule as P3, per group).
- [ ] **Step 5: Run** `npm test && npm run lint:types && bash scripts/contract/cam-proxy-check.sh` — Expected: PASS; cross-check prints `pending` for the move fixtures.
- [ ] **Step 6: Commit** `feat(contract): camera move commands, events and cams-v1 fields` and open the PR; merge when all checks pass (this unblocks the cam-proxy plan).

### Task 2: Data model — moves and move_chunks

**Files:**
- Modify: `server/db/migrations.ts` (migration 8), `server/ids.ts` (prefix union adds `mv`)
- Create: `server/moves/store.ts`
- Test: `test/moves-store.test.ts`

**Interfaces:**
- Produces:
  - Table `moves(id TEXT PK, account_id, camera_id REFERENCES cameras, source_proxy_id, target_proxy_id, request_id, phase TEXT CHECK(phase IN ('requested','offered','awaiting-approval','approved','switching','copying','cleaning','done','rejected','cancelling','cancelled','failed')), reason TEXT, plan TEXT (JSON), summary TEXT, settings TEXT, token_hash TEXT CHECK(token_hash GLOB 'sha256:*'), target_ip TEXT, target_public_key TEXT, leaf_fingerprint TEXT, copied_choice TEXT, budget_exceeded_at INTEGER, bytes_total INTEGER, bytes_done INTEGER, rate_bps INTEGER, eta_s INTEGER, created_at, updated_at, ended_at, actor TEXT, version INTEGER)` STRICT; FKs `(account_id, source_proxy_id)` and `(account_id, target_proxy_id)` → `proxies(account_id, id)` (same account enforced by the DB).
  - Partial unique indexes: one non-ended move per `source_proxy_id`, per `target_proxy_id`, per `camera_id` (`WHERE ended_at IS NULL`).
  - Table `move_chunks(move_id REFERENCES moves ON DELETE CASCADE, chunk_id TEXT, state TEXT, PRIMARY KEY(move_id, chunk_id))` STRICT.
  - Column `cameras.move_id TEXT NULL` (the cameras trigger already bumps the config revision).
  - `class MoveStore { constructor(db, clock); create(m: NewMove): Move; get(id): Move|null; active(): Move[]; byProxy(proxyId): Move|null; setPhase(id, phase, patch?: Partial<Move>): Move; saveChunks(id, chunks: {id, state}[]): void; chunks(id): ChunkState[]; list(accountId?, limit?): Move[] }` — every write inside `tx()`; `create` maps the unique-index violation to `MoveBusy`.
- [ ] **Step 1: Failing tests** — `creates a move and reads it back`; `second active move on the same source throws MoveBusy`; `a move between proxies of two accounts violates the FK`; `ended moves do not block a new one`; `saveChunks upserts and keeps other chunks`; `migration 8 on a DB at version 7 keeps existing rows` (use the existing migration test helper).
- [ ] **Step 2: Run** `npx vitest run test/moves-store.test.ts` — FAIL.
- [ ] **Step 3: Implement** migration 8 and `MoveStore`.
- [ ] **Step 4: Run** the test and `npm test` (the migration and write-budget tests included) — PASS.
- [ ] **Step 5: Commit** `feat(moves): moves and move_chunks tables`.

### Task 3: Receiving proxy events and move commands

**Files:**
- Modify: `server/channel/connection.ts` (`case 'event'`: events without `cmdId` go to a new `onProxyEvent` hook), `server/commands/service.ts` (WireCommand union :35, `summariseArgs` :64 drops `token`/`tokenHash`/`targetPublicKey`, `requiredEntries` :75 maps per R3 including `move.cancel` by `args.role`; after a final `move.offer` set its stored `args` to the summary), `server/contract.ts` (vArgs/vResult maps)
- Modify: `test-client/client.ts`, `test-client/commands.ts` (fake proxy: `emitEvent(body)`, move command handlers returning canned results)
- Test: `test/move-channel.test.ts`

**Interfaces:**
- Produces: `Hub` option `onProxyEvent(proxyId: string, accountId: string, body: MoveEvent): void`; `MoveEvent` = the union of Task 1 event bodies (type in `server/moves/types.ts`). Events failing the strict schema are dropped and audited as `move-event-refused` (throttled per proxy). `Commands.create` accepts the nine `move.*` commands.
- [ ] **Step 1: Failing tests** — `a signed move.request event reaches onProxyEvent with the proxy id`; `an event with a forged signature is dropped`; `an unknown event kind is refused and audited once per 10 min`; `move.cancel role target requires move.receive in the proxy's reported allow list`; `token never stored after final` (create `move.offer`, fake proxy answers done, then `SELECT args FROM commands` has no `token` and the `command-create` audit detail has no `token`).
- [ ] **Step 2: Run** `npx vitest run test/move-channel.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Add audit actions `move-event-refused` to `AUDIT_ACTIONS`.
- [ ] **Step 4: Run** test + `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(moves): proxy move events and move commands on the channel`.

### Task 4: Request, targets, precheck, offer, answer

**Files:**
- Create: `server/moves/service.ts` (`class Moves`), `server/moves/precheck.ts`, `server/moves/token.ts`
- Modify: `server/server.ts` (construct `Moves`, wire `onProxyEvent`, `tick`)
- Test: `test/moves-request.test.ts`

**Interfaces:**
- Consumes: `MoveStore` (Task 2), `onProxyEvent` and `Commands.create` (Task 3), `StatusStore.viewOf`, `registry.getProxy/getCamera`, `generateToken()` (server/tokens/service.ts:40).
- Produces:
  - `eligibleTargets(accountId, sourceProxyId): {proxyId, name, site}[]` — same account, `state==='enrolled'`, derived state `online`, capability `commands`, reported allow includes `move.receive`, `site` non-null, not the source, no active move (S §4, R7 routing).
  - `precheck(m): {ok:true} | {ok:false, reason}` — reasons: `other_account`, `target_offline`, `moves_not_allowed`, `busy`, `not_routed`, `host_overridden`, `no_site_ca` (source or target `tls_site` null).
  - `Moves.onEvent(proxyId, accountId, ev)`: `move.targets` → `move.targets` command; `move.request` → precheck → create row (`requested`), token (R4), `move.open` to source, `move.offer` to target, phase `offered`; refusal → `move.answer {accept:false, reason}` and phase `rejected`.
  - `Commands.onFinal` listener: `move.offer` done → `move.answer` to source with `estimateS = ceil(summaryBytes(plan kinds) / probeBps)` and phase `awaiting-approval`; refused/failed/expired/unknown → phase `failed` with the code, and `move.answer accept:false reason:'target_failed'`.
- [ ] **Step 1: Failing tests** (fake proxies from test-client, two in one account, one in another): `targets lists only same-account online proxies allowing move.receive`; `request creates a move and sends move.open then move.offer`; `second request is busy` (both for same source and for a target already in a move); `cross-account target is refused other_account`; `target not routed to the source's cams instance is refused not_routed`; `offer refused by the target becomes move.answer with its reason and phase rejected`; `offer accepted becomes move.answer with estimateS from probeBps`; `offer that never answers fails` (advance clock past GIVE_UP_AFTER_MS).
- [ ] **Step 2: Run** `npx vitest run test/moves-request.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Audit actions (closed list): `move-request`, `move-offer`, `move-phase`. Detail: `moveId, camsId, source, target, reason`.
- [ ] **Step 4: Run** test + `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(moves): request, precheck, offer and answer`.

### Task 5: Approval, start, go, switch-over, release

**Files:**
- Modify: `server/moves/service.ts`, `server/registry.ts` (new `moveCamera(actor, accountId, cameraId, {proxyId, proxyCameraId, tlsServername, moveId})` in one `tx`, audit `move-switch`)
- Test: `test/moves-switch.test.ts`

**Interfaces:**
- Produces:
  - `move.approve` event (from the move's source only; phase must be `awaiting-approval`; offer not older than 30 min) → store `plan`, phase `approved`, audit `move-approve`, send `move.start` to target.
  - `move.start` done → store `target_public_key`, `leaf_fingerprint`; send `move.go {targetPublicKey, expectedLeaf}` to source; phase `switching`.
  - `move.phase switched` (target) → `registry.moveCamera` with `tlsServername = <proxyCameraId>.<target site>.internal`, sets `cameras.move_id`; send `move.release` to source; phase `copying` at once (the target starts copying right after `switched`; cam-proxy plan P12). `move.phase released` from the source is recorded (audit) and ends the switch-over; `move.progress` is accepted from `switching` on.
  - Resume: `Moves.resume(moveId)` re-derives the next command from `phase` + which commands are final; called from `tick()` and from the hub's "proxy live" hook.
  - Offer expiry in `tick()`: `awaiting-approval` older than 30 min → phase `failed` code `offer_expired`, `move.cancel` to both (role each), audit.
- [ ] **Step 1: Failing tests:** `approve from a proxy that is not the source is refused`; `approve after 30 minutes is refused and the move fails offer_expired`; `start result's key and leaf reach the source in move.go`; `switched moves the camera in the registry with the new TLS name and sets move_id`; `snapshot revision changes at switch-over`; `resumes after reconnect` (drop the target connection after `move.start` is sent, reconnect: `move.start` re-sent with the same cmdId, nothing doubled); `target fails before switched → automatic cancel` (S §10.2).
- [ ] **Step 2: Run** `npx vitest run test/moves-switch.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Audit: `move-approve`, `move-switch`.
- [ ] **Step 4: Run** test + `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(moves): approval, start and switch-over`.

### Task 6: Copy progress, budget, finish, cancel, end transfer

**Files:**
- Modify: `server/moves/service.ts`
- Test: `test/moves-finish.test.ts`

**Interfaces:**
- Produces:
  - `move.progress` → memory state + `live.publishRegistry('move', id)`; persisted per R8 via `saveChunks` and `setPhase(…, {bytes_done, rate_bps, eta_s})`. First time `now > approvedAt + budgetS` with `bytesDone < bytesTotal` → `budget_exceeded_at`, audit `move-budget-exceeded` (once).
  - `move.phase copied` (target) → phase `cleaning`, `move.finish {abandoned:false}` to source; its done → phase `done`, `cameras.move_id = NULL`, audit `move-done` with totals from the chunk states.
  - `cancel(actor, moveId, copied)` (API) and `move.cancel` event (source page): allowed in `approved|switching|copying`; phase `cancelling`; before `switched`: `move.cancel` to target only; after: `move.cancel {role:'target', copied}` then `move.cancel {role:'source', expectedLeaf}`; registry back via `moveCamera` to the source (source site TLS name) when the source reports `move.phase cancelled`; phase `cancelled`; `move_id` NULL. Audit `move-cancel`.
  - `endTransfer(actor, moveId)`: only in `copying`; remaining non-final chunks → `abandoned` (stored state `skipped` with reason in detail); `move.finish {abandoned:true}` to source if online, else phase `done` with `cleanup: 'not-done'` in the `move-done` detail.
- [ ] **Step 1: Failing tests:** `progress updates memory without a DB write each time` (write counter); `chunk states persist at most once a minute`; `budget exceeded is audited once`; `copied leads to finish then done and clears move_id`; `cancel before switch-over sends only the target cancel`; `cancel during release ends with the camera on the source` (Review Focus 4); `end transfer with the source offline completes with cleanup not-done`; `cancel in done is refused 409`.
- [ ] **Step 2: Run** `npx vitest run test/moves-finish.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Audit: `move-budget-exceeded`, `move-cancel`, `move-done`, `move-end-transfer`.
- [ ] **Step 4: Run** test + `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(moves): progress, finish, cancel and end transfer`.

### Task 7: Snapshot and report contract use

**Files:**
- Modify: `server/cams/snapshot.ts` (`SnapProxy.site` from `proxies.tls_site`, `SnapCamera.moveId` from `cameras.move_id`; explicit column lists), `server/cams/routes.ts` (accept and store `heldProxies` from `/cams/v1/report`), the dashboard's instance view (show held proxies next to held cameras)
- Test: `test/cams-snapshot.test.ts`, `test/cams-report.test.ts`
- [ ] **Step 1: Failing tests:** `snapshot carries proxy site and camera moveId`; `snapshot has no token` (extend the existing "no secret" guard with the move token and token hash of an active move); `report with heldProxies is stored and shown in the instance view data`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(cams): site and moveId in the snapshot, heldProxies in reports`.

### Task 8: API routes

**Files:**
- Modify: `server/api/router.ts` (new routes), `server/server.ts` `writeRoutes()`
- Test: `test/api-moves.test.ts`, `test/api-audit-completeness.test.ts` (extended automatically)

**Interfaces:**
- Produces (sysadmin, CSRF, `writeLimiter`):
  - `GET /api/v1/moves?accountId=` → `{items: MoveView[]}`; `GET /api/v1/moves/:moveId` → `MoveView & {chunks}`.
  - `POST /api/v1/moves/:moveId/cancel` body `{copied:'delete'|'age-out', confirm:'cancel'}` → 202.
  - `POST /api/v1/moves/:moveId/end-transfer` body `{confirm:'end transfer'}` → 202.
  - `MoveView = {id, accountId, camsId, cameraName, source:{id,name}, target:{id,name}, phase, reason, plan, bytesTotal, bytesDone, rateBps, etaS, budgetExceeded:boolean, createdAt, updatedAt, endedAt}` — no token, no hash, no key.
- [ ] **Step 1: Failing tests:** `lists moves of an account`; `detail includes chunk counts per state`; `cancel needs the typed confirm`; `end transfer only in copying (409 otherwise)`; `no move view field contains token, hash or publicKey`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test` PASS (audit completeness included).
- [ ] **Step 5: Commit** `feat(api): moves list, detail, cancel and end transfer`.

### Task 9: Moves page

**Files:**
- Create: `web/src/pages/Moves.svelte`, `web/src/components/MoveDetail.svelte`, `web/src/lib/moves.ts` (`phaseText(phase)`, `progressText(view)`, `etaText`)
- Modify: `web/src/lib/router.ts`, `web/src/App.svelte` (nav link "Moves"), `web/src/components/ProxyCommands.svelte` and `web/src/lib/commands.ts` (`argsText` for `move.*`, never showing token fields), `web/src/pages/Proxy.svelte` (link to an active move)
- Test: `web/src/lib/moves.test.ts`, `e2e/moves.spec.ts`
- Copy (exact): page title `Moves`; columns `Camera`, `From`, `To`, `Phase`, `Progress`; buttons `Cancel move…` (Confirm with typed `cancel` and a choice "Delete what was copied" / "Let it age out on the target") and `End transfer…` (typed `end transfer`, body "The rest of the old content stays behind and is deleted with the camera on the old proxy."); budget badge `Over time budget`.
- Live: `live({registry})` with `coalesced(load, 250)` on `registry` events of type `move`.
- [ ] **Step 1: Failing tests:** `phaseText covers every phase`; `progressText shows bytes and percent`; e2e `moves page lists a move and cancels it` (fake proxies via test-client in the e2e harness; data-testids `move-row-<id>`, `move-cancel`, `move-end-transfer`).
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test`, `npm run check`, `npm run check:svelte`, `npm run build && npm run test:e2e` PASS.
- [ ] **Step 5: Commit** `feat(web): Moves page`; CHANGELOG `## [Unreleased]`: "Camera moves between proxies: a Moves page with progress, cancel and end transfer."

### Task 10: Localstack end to end (after cam-proxy main has moves)

**Files:**
- Create: `scripts/localstack/move-check.ts`
- Modify: `docs/localstack.md`
- [ ] **Step 1:** In the localstack, beta-1 (:29200) and beta-2 (:29300) are one account. Enable `move.send` on beta-1 and `move.receive` on beta-2 (their Cams-Admin pages, local admin), give both a site CA covering the sim camera.
- [ ] **Step 2:** `move-check.ts` drives: move.targets → request (via beta-1's `POST /control/moves`) → approve with a 2× budget → wait for `done`; asserts: registry camera now on beta-2 with `<cam>.<site>.internal`; beta-2 serves the camera's clips/stills for the copied days; beta-1 lists no content for the camera; cams-admin audit has `move-request … move-done`; a second run with a forced restart of beta-2 during `copying` still ends `done`; a third run cancels after switch-over and ends with the camera on beta-1.
- [ ] **Step 3: Run** `npx tsx scripts/localstack/move-check.ts` — Expected: `move-check: 3/3 scenarios ok`.
- [ ] **Step 4: Commit** `test(localstack): camera move end to end`.
