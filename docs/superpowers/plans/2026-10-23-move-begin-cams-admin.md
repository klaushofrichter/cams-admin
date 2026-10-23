# Moves started from cams-admin (move.begin) — cams-admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/v1/moves` starts a camera move from cams-admin: it fixes the three fixable precheck failures itself, sends the new `move.begin` command to the source, and carries pre-approval bounds that the source uses to approve its own offer.

**Architecture:** The contract gets one command, `move.begin` (cams-admin → source, allow entry `move.send`), and an optional `bounds` field on the `move.request` event. A new `server/moves/begin.ts` parses the body, runs `precheckReport`, applies the fixers (routes, registry `tlsSite`, host override), re-checks, and queues `move.begin` through `Commands.create`. The source then emits the usual `move.request` event, which the unchanged `Moves.onRequest` path handles; only the bounds are stored on the row and shown in the move view. Auto-approval happens on the source (cam-proxy plan); cams-admin's `onApprove` and its `plan_changed` guard are unchanged.

**Tech Stack:** TypeScript (Node ≥ 26, CommonJS), Express 5, `node:sqlite` (STRICT tables), ajv contract, Svelte 5, vitest + supertest, the localstack (`scripts/localstack/`).

**Spec:** `docs/superpowers/specs/2026-10-22-operations-and-move-tokens-design.md` §2 and §5 step 2 (cited **S §n**). The controller's rulings R1–R6 (below) override the spec where they differ.

**Sibling plan:** cam-proxy `docs/superpowers/plans/2026-10-23-move-begin-cam-proxy.md`.

**Execution order across repos:**
1. **This plan's Task 1** (contract) merges to cams-admin main.
2. **cam-proxy plan Task 1** (re-vendor) follows at once: cam-proxy's `contract-drift` check fails on every cam-proxy PR from step 1 until it merges. Then cam-proxy Tasks 2–5, and a cam-proxy release.
3. **This plan's Tasks 2–4.** They may start right after step 1, because their tests use the test-client fake proxies, not cam-proxy. Then a cams-admin release.
4. **This plan's Task 5** (localstack end to end). It needs both mains from steps 2 and 3.

## Global Constraints

- The repo is public: no real addresses, ids, tokens or passwords. Fixtures use RFC 5737 addresses (192.0.2.x, 198.51.100.x).
- A change to a command, result or event goes into `contract/` first (`npm run contract:make`). The committed output must equal a fresh build.
- `move.begin` carries no password, token or key. Camera passwords stay on the source proxy (S §2, R1).
- Only three rules are fixable: `routed` (reason `not_routed`), `site_ca` (reason `no_site_ca`), `no_host_override` (reason `host_overridden`). Every other precheck rule refuses as today.
- The fixers never write `caFingerprints` or `tlsServername` (R3). `tlsSite` is written only from the proxy's own reported `site`, and only when the registry field is empty.
- Each fix is audited under action `move-fix`, with the rule and the ids it touched. Add `move-fix` and `move-begin` to `AUDIT_ACTIONS` (`server/audit.ts`); `test/api-audit-completeness.test.ts` stays green.
- `OPS_ROUTES` gains exactly one entry: `POST /moves`, scope `moves`. A session works too (CSRF as today).
- Inject `Clock` (server/clock.ts). Never use `Date.now()`.
- `test/write-budget.test.ts` stays green.
- CHANGELOG.md: user-visible lines go under `## [Unreleased]`.

## Rulings

From the controller, as given:
- **R1** New proxy command `move.begin`, cams-admin → source, under allow entry `move.send`.
  - Args: `{camera: <proxy camera id>, target: <proxyId>, bounds: {transfer: boolean, kinds: string[], space: <MovePlan space choices>, maxBudgetS: integer} | null}`.
  - The source runs the same refusal checks and `request()` as `POST /control/moves`, with actor `{origin:'managed', label:'cams-admin move'}`. It returns `{requestId}` or a refusal code.
  - The source keeps `bounds` with the pending request and the move record. The camera password stays on the proxy.
- **R2** Auto-approval happens at the source. The rule is in the cam-proxy plan; cams-admin only stores and shows the bounds.
- **R3** `POST /api/v1/moves`:
  - Body `{sourceProxyId, targetProxyId, cameraId, bounds|null}`, in ops-token scope `moves`; a session also works.
  - It runs `precheckReport` and fixes `not_routed` and `no_host_override`. It fixes `site_ca` only when the proxy's reported status has a `site` and the registry `tlsSite` is empty.
  - CA fingerprints are not written automatically in this step. That is a ruling.
  - Any other failing rule → 409 with the report. Otherwise it queues `move.begin` → 202 `{commandId, fixed, report}`.
  - The bounds reach cams-admin in the `move.request` event: the move view and `/diag/moves` show `autoApprove` and `bounds`.
- **R4** The contract change is this plan's Task 1. cam-proxy re-vendors it.
- **R5** cams does not change. A "Start move" form on the page only if it is cheap (see A8).
- **R6** Every change has tests, plus one localstack move that is approved automatically.

Added while planning (each with why and cost if wrong):
- **A1** `bounds` is **optional** on the `move.request` event, in both the lenient and the strict schema. Absent means null.
  - Why: cams-admin validates incoming events strictly (`server/channel/connection.ts:186`), and proxies already released send no `bounds`. If the field were required, their moves would stop at the first cams-admin release.
  - Cost if wrong: the strict schema cannot catch a cam-proxy that forgets to send `bounds`. The cam-proxy plan always sends it and tests that.
- **A2** `move.begin` args carry `v: 1`, like every move command. `maxBudgetS` is an integer from 60 to 604800 (one minute to seven days).
  - Why: these are the contract's conventions, and the panel's smallest budget is one minute.
  - Cost if wrong: a contract revision to widen the range.
- **A3** The contract cross-check (`scripts/contract/cam-proxy-commands.ts`) keeps a `move.begin` fixture `pending` while cam-proxy main does not implement `move.begin`. This is a per-command rule; the rest of the move group is already implemented and stays strict.
  - Why: otherwise Task 1's PR fails the cross-check against cam-proxy main.
  - Cost: none once cam-proxy Task 1 has merged.
- **A4** `begin` checks these before it fixes anything:
  - the camera is on the source;
  - the source is online;
  - `move.send` is in the source's reported allow list;
  - the source's registry `url` and `tlsServername` are set;
  - no non-fixable precheck rule fails.

  Any failure → 409 with nothing written.
  - Why: a refused request should leave nothing behind. These are the refusals `Commands.create` and `onRequest` would otherwise give only after the fixes.
  - Cost: none.
- **A5** A **hidden** route for the target is never unhidden. That instance stays `not_routed`, and the request gets a 409.
  - Why: a sysadmin hid it on purpose.
  - Cost: one manual step for that setup.
- **A6** The host-override fix sets `host` to null and keeps a set `cameraUser` (via `setOverride` with the row's version). It deletes the row (`clearOverride`) only when no `cameraUser` is set.
  - Why: the precheck objects to the host only.
  - Cost: none.
- **A7** `cameraId` is the registry id or the cams id within the source's account, as in `/diag/moves/precheck`.
- **A8** There is no "Start move" form in this step. It would need source, target and camera pickers, a bounds form and a precheck report display, so it is not cheap. The API and the curl form in `docs/diagnostics.md` cover it. The Moves page detail gets one line showing the bounds.
- **A9** Fixes are audited with the rule and target ids, not under a move id. No move row exists until the source's `move.request` arrives. S §2 said "under the move's id".
  - Cost: a reader joins `move-fix` to the move through `move-begin`'s `cmdId` and the `requestId`.
- **A10** A failed or refused `move.begin` is audited `move-begin` with outcome `failed` and its code. There is no move row, and the fixes already made stay.

## Review Focus

1. A request where a non-fixable rule fails (the target is offline, busy or in another account): 409 with the report. Nothing is fixed: no route, registry or override row changes. Task 3 `non-fixable failure fixes nothing`.
2. The target has a **hidden** route on an instance that sees the source: the route stays hidden, and the answer is 409 `precheck` with `routed` failing. Task 3 `a hidden target route is not unhidden`.
3. The registry `tlsSite` is set but differs from the proxy's reported site: it is not overwritten, and the answer is 409 with `site_ca` failing. Task 3 `a registry site that differs is not overwritten`.
4. A `move.request` event from a proxy that is not updated yet (no `bounds` field): it is valid and stored with `bounds` null, and the view shows `autoApprove: false`. Task 2 `request without bounds stores null`.
5. The source refuses `move.begin` (busy, no_site_ca): no move row, a `move-begin` audit with outcome `failed` and the code, and the fixes stay audited. Task 3 `a refused move.begin is audited and leaves no move`.

---

### Task 1: Contract — `move.begin` and `bounds` on `move.request`

**Files:**
- Modify: `contract/build.ts`:
  - `MOVE_COMMANDS` (:383) gets `'move.begin'` first;
  - `moveArgs` / `moveResults` (:264, :287);
  - the `move.request` event (:309): `bounds` optional;
  - a new `const moveBounds`.
- Modify: `scripts/contract/make-vectors.ts` (if it enumerates move commands), `scripts/contract/cam-proxy-commands.ts` (`MOVE` :65; the per-command pending rule, A3)
- Modify: `server/commands/service.ts` (the `WireCommand` union :35), `server/contract.ts` (the vArgs/vResult maps: import the `move.begin` schemas)
- Modify: `contract/README.md` (the move command list: `move.begin`, source, `move.send`; the result `{requestId}`; refusal codes)
- Generated: `contract/v1/**` via `npm run contract:make`
- Fixtures: `valid-command-move-begin.json`, `valid-command-move-begin-no-bounds.json` (`bounds: null`), `refused-move-begin-not-allowed.json` (`$expect.runtime: "not_allowed"`, allow without `move.send`), `valid-event-move-request-bounds.json`
- Test: `test/contract-commands.test.ts`, `test/contract-events.test.ts`

**Interfaces:**
- Produces (wire; the cam-proxy plan and Tasks 2–4 use these exact names):
  - `move.begin` args: `{v: 1, camera: <camId>, target: <prx id>, bounds: MoveBounds | null}`, all required, closed in strict.
  - `MoveBounds = {transfer: boolean, kinds: <kind>[] (unique, ⊂ MOVE_KINDS, ≤ 5), space: 'all'|'omit'|'fit'|'retention' (MOVE_SPACE_CHOICES), maxBudgetS: integer 60..604800}`, closed.
  - `move.begin` result: `{requestId: <rq id>}`.
  - The refusal is the command's `failed` status. Its `code` is one of `no_site_ca|external_cert|moves_not_allowed|busy|unknown_camera`, exported as `MOVE_BEGIN_REFUSALS`.
  - The `move.request` event gets `bounds: MoveBounds | null`, optional in both schemas (A1).
  - The allow entry for `move.begin` is `move.send`. `requiredEntries` already maps every other `move.*` to `move.send`; a test pins it.

- [ ] **Step 1: Write the failing tests**

```ts
// test/contract-commands.test.ts
it('covers 55 fixtures (P2 17, P3 24, moves 14)', () => expect(cases).toHaveLength(55));
it.each([...MOVE, 'move.begin'])('%s has args and result schemas, strict and lenient', ...); // extend the existing each
it('move.begin args: bounds null or the closed bounds object', () => {
  const ok = { v: 1, camera: 'cam1', target: 'prx_1123456789ABCDEFGHJK', bounds: { transfer: true, kinds: ['clips'], space: 'fit', maxBudgetS: 3600 } };
  expect(strictArgs('move.begin', ok)).toBe(true);
  expect(strictArgs('move.begin', { ...ok, bounds: null })).toBe(true);
  expect(strictArgs('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 59 } })).toBe(false);
  expect(strictArgs('move.begin', { ...ok, bounds: { ...ok.bounds, maxBudgetS: 604801 } })).toBe(false);
  expect(strictArgs('move.begin', { ...ok, bounds: { ...ok.bounds, kinds: ['clips', 'clips'] } })).toBe(false);
  expect(strictArgs('move.begin', { ...ok, bounds: { ...ok.bounds, space: 'some' } })).toBe(false);
  expect(strictArgs('move.begin', { ...ok, bounds: { ...ok.bounds, extra: 1 } })).toBe(false);
  expect(strictArgs('move.begin', { ...ok, password: 'x' })).toBe(false);
});
it('move.begin result is {requestId}', () => {
  expect(strictResult('move.begin', { requestId: 'rq_0123456789ABCDEFGHJK' })).toBe(true);
  expect(strictResult('move.begin', {})).toBe(false);
});
it('move.begin needs move.send', () => expect(requiredEntries('move.begin', {})).toEqual(['move.send']));
// test/contract-events.test.ts
it('move.request with bounds, with bounds null and without bounds are valid (strict)', ...);
it('move.request with bounds outside the closed object is invalid', ...); // maxBudgetS 0 → false
```

- [ ] **Step 2: Run** `npx vitest run test/contract-commands.test.ts test/contract-events.test.ts`. Expected: FAIL (no `move.begin` schema).
- [ ] **Step 3: Implement** `moveBounds` and the `move.begin` args/result in `contract/build.ts`, and `export const MOVE_BEGIN_REFUSALS = ['no_site_ca', 'external_cert', 'moves_not_allowed', 'busy', 'unknown_camera'] as const`. Add `bounds: nullable(moveBounds)` to the `move.request` event with `optional: ['bounds']`. Add the fixtures, the `WireCommand` member and the `server/contract.ts` imports. Then `npm run contract:make`.
- [ ] **Step 4: Add the cross-check rule (A3).** In `scripts/contract/cam-proxy-commands.ts`, add `'move.begin'` to `MOVE`. A fixture whose command is `move.begin` is `pending` while `!implemented('move.begin')`, whatever `MOVE_STARTED` is.
- [ ] **Step 5: Run** `npm test && npm run lint:types && bash scripts/contract/cam-proxy-check.sh`. Expected: PASS. The cross-check prints `pending` for the three `move.begin` fixtures and `ok` for every other fixture.
- [ ] **Step 6: Commit** `feat(contract): move.begin command and move.request bounds`. Open the PR and merge it when all checks pass. Then tell the cam-proxy plan's Task 1 that it can start (execution order step 2).

### Task 2: Store and show the bounds of a request

**Files:**
- Modify: `server/db/migrations.ts` (migration 11: `ALTER TABLE moves ADD COLUMN bounds TEXT`, JSON or NULL)
- Modify: `server/moves/store.ts` (`Move.bounds`, `NewMove.bounds`, `JSON_COLS` gets `bounds`, the INSERT)
- Modify: `server/moves/types.ts` (`MoveBounds`; `MoveRequestEvent.bounds?: MoveBounds | null`)
- Modify: `server/moves/service.ts` `onRequest` (:378): pass `bounds: ev.bounds ?? null` to `store.create`; add `autoApprove: bounds !== null` to the `move-request` audit detail
- Modify: `server/moves/view.ts` (`MoveView.autoApprove: boolean`, `MoveView.bounds: MoveBounds | null`)
- Modify: `test-client/client.ts` / `test-client/commands.ts`, if the fake proxy builds `move.request` bodies (it takes an optional `bounds`)
- Test: `test/moves-request.test.ts`, `test/moves-store.test.ts`, `test/diag.test.ts`

**Interfaces:**
- Consumes: `MoveBounds` (Task 1 wire shape).
- Produces: `export interface MoveBounds { transfer: boolean; kinds: MoveKind[]; space: MovePlanSpace; maxBudgetS: number }` in `server/moves/types.ts`; `Move.bounds: MoveBounds | null`; `MoveView.autoApprove`, `MoveView.bounds`. `/diag/moves` shows both through `moveView`, with no change to `server/diag/views.ts`.

- [ ] **Step 1: Write the failing tests**
  - `moves-request`: `request with bounds stores them and the view shows autoApprove`. A fake source emits `move.request` with `bounds: {transfer: true, kinds: ['clips','stills'], space: 'fit', maxBudgetS: 3600}`. Then `moveView(db, m).autoApprove === true`, `.bounds` equals the bounds, and the `move-request` audit detail has `autoApprove: true`.
  - `moves-request`: `request without bounds stores null` (Review Focus 4). The event has no `bounds` key. It passes the strict schema, `m.bounds === null`, and `autoApprove === false`.
  - `moves-request`: `the request flow is unchanged with bounds`. The same request with bounds still sends `move.open` and then `move.offer`. Neither command's args contains `bounds`.
  - `moves-store`: `migration 11 on a DB at version 10 keeps existing moves with bounds NULL`.
  - `diag`: `/diag/moves lists autoApprove and bounds`.
- [ ] **Step 2: Run** `npx vitest run test/moves-request.test.ts test/moves-store.test.ts test/diag.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** migration 11 and the store, type, `onRequest` and view changes.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, with `write-budget` and `api-audit-completeness` included.
- [ ] **Step 5: Commit** `feat(moves): keep a request's pre-approval bounds and show them`.

### Task 3: `begin` — the fixers and `move.begin`

**Files:**
- Create: `server/moves/begin.ts`
- Modify: `server/moves/service.ts`:
  - `Moves.begin(actor, body)` delegates to `begin.ts` with the deps it has, plus `camsInstances`. Add `camsInstances` to `MovesDeps` and wire it in `server/server.ts`.
  - `onFinal` (:415): handle `move.begin` before the `moveId` lookup.
- Modify: `server/audit.ts` (`move-fix`, `move-begin`)
- Modify: `test-client/commands.ts` (the fake proxy handles `move.begin`: with `move.send` allowed it emits a `move.request` carrying `camera`, `target` and `bounds` from the args and answers `{requestId}`; it can also be set to answer `failed` with a given code)
- Test: `test/moves-begin.test.ts` (new)

**Interfaces:**
- Consumes:
  - `precheckReport`, `siteOf`, `routed` (server/moves/precheck.ts);
  - `registry.proxyById`, `registry.listCameras`, `registry.updateProxy(actor, accountId, id, {tlsSite, version})`;
  - `camsInstances.routes(id)`, `.setRoute(actor, id, proxyId, {url: null, hidden: false})`, `.overrides(id)`, `.setOverride(actor, id, cameraId, {host: null, cameraUser, version})`, `.clearOverride(actor, id, cameraId)`;
  - `Commands.create(actor, accountId, proxyId, 'move.begin', args)`;
  - `MoveBounds` (Task 2).
- Produces:
  - `export interface BeginInput { sourceProxyId: string; targetProxyId: string; cameraId: string; bounds: MoveBounds | null }`
  - `export function beginInput(body: unknown): BeginInput`. It throws `ApiError(400, 'invalid', <field>)`, where field ∈ `sourceProxyId|targetProxyId|cameraId|bounds`. `bounds` is checked with the contract's strict `move.begin` args validator.
  - `export type Fix = { rule: 'routed'; instanceId: string; proxyId: string } | { rule: 'site_ca'; proxyId: string; site: string } | { rule: 'no_host_override'; instanceId: string; cameraId: string }`
  - `export type BeginResult = { ok: true; commandId: string; fixed: Fix[]; report: PrecheckReport } | { ok: false; status: 404 | 409; error: string; field?: string; reason?: PrecheckReason | null; report?: PrecheckReport; fixed?: Fix[] }`, where `PrecheckReport` is the return type of `precheckReport`.
  - `Moves.begin(actor: string, body: unknown): BeginResult`
  - The 409 errors (A4): `camera_not_on_source`, `source_offline`, `moves_not_allowed` (the source's allow list lacks `move.send`), `source_registry_incomplete`, and `precheck` (with `reason`, `report`, `fixed`).
  - 404: `not_found` with field `sourceProxyId` or `cameraId`.
  - Audit `move-fix`: `{actorType: 'sysadmin', actor, action: 'move-fix', accountId, targetType: 'proxy' | 'cams-instance', targetId, outcome: 'ok', detail: {rule, source, target, camera: camsId, ...ids of the Fix}}`.
  - Audit `move-begin`: outcome `ok`, detail `{cmdId, source, target, camera: camsId, bounds, fixed: Fix['rule'][]}`. On a final `move.begin` that is not `done`: outcome `failed`, detail `{cmdId, source, code}`.

Fix algorithm (the order is the decision; the rest follows from the interfaces):
1. Run `r1 = precheckReport(...)`. If a failing rule is not one of `site_ca`, `routed`, `no_host_override`, answer 409 `precheck` with `fixed: []`.
2. `site_ca` is fixable when every failing side has registry `tlsSite === null` and a reported site matching the contract's `SITE_PATTERN`. Otherwise answer 409 with nothing fixed.
3. `routed` is fixable when no unseen instance has a hidden route for the target (A5). Otherwise answer 409 with nothing fixed.
4. Apply the fixes in this order: `site_ca` (source first, then target), `routed` (one `setRoute` per unseen instance), `no_host_override` (A6, one per instance whose override has a host).
5. Run `r2 = precheckReport(...)`. If it is not ok, answer 409 `precheck` with `r2` and `fixed`; the fixes stay.
6. Call `Commands.create(actor, accountId, source, 'move.begin', {v: 1, camera: proxyCameraId, target, bounds})`. An `ApiError` from it propagates.

- [ ] **Step 1: Write the failing tests** in `test/moves-begin.test.ts`. They use two fake proxies in one account, one cams instance that serves it, and both proxies with `site` reported.
  - `begin with a clean precheck queues move.begin and fixes nothing`: result `ok`, `fixed` `[]`, one `commands` row with command `move.begin` and args `{v:1, camera:'cam1', target:<B>, bounds}`. The fake source then emits `move.request` with the same bounds, and a move row exists with `bounds` equal to them.
  - `not_routed is fixed with a visible route, url null`: before, the instance has a route to the source only. After, `routes(instance)` has the target with `url: null, hidden: false`. `fixed` is `[{rule:'routed', instanceId, proxyId: B}]`, and one `move-fix` audit has `rule: 'routed'`.
  - `site_ca is fixed from the reported site when the registry is empty`: the target has registry `tlsSite: null` and reported site `'beta-2'`. After, the registry has `'beta-2'`, and `fixed` contains `{rule:'site_ca', proxyId: B, site:'beta-2'}`. `caFingerprints` and `tlsServername` are unchanged.
  - `a registry site that differs is not overwritten` (Review Focus 3): registry `'old'`, reported `'beta-2'` → 409 `precheck`, reason `no_site_ca`. The registry still has `'old'`, and no `move-fix` audit is written.
  - `a hidden target route is not unhidden` (Review Focus 2): 409 `precheck`, reason `not_routed`. The route stays `hidden: true`.
  - `a host override loses its host and keeps its camera user`: an override `{host: '192.0.2.50', cameraUser: 'viewer'}` becomes `{host: null, cameraUser: 'viewer'}`. With `cameraUser: null` the row is deleted. Each case has a `move-fix` with `rule: 'no_host_override'`.
  - `non-fixable failure fixes nothing` (Review Focus 1): the target is offline and also unrouted → 409 `precheck`, reason `target_offline`. The route table, registry and overrides are unchanged, and no `move-fix` audit is written.
  - `source checks come first`: a camera on another proxy → 409 `camera_not_on_source`; an offline source → 409 `source_offline`; a source without `move.send` → 409 `moves_not_allowed`; a source with `url` null → 409 `source_registry_incomplete`. No command or fix in any case.
  - `cameraId may be the cams id`: same result as the registry id.
  - `a refused move.begin is audited and leaves no move` (Review Focus 5): the fake source answers `failed` with code `busy`. One `move-begin` audit has outcome `failed` and code `busy`, there is no `moves` row, and the earlier `move-fix` audits remain.
  - `bounds null starts a move with no auto-approval`: the command args have `bounds: null`, and the stored move has `bounds` null.
  - `bad bounds are 400 bounds`: `maxBudgetS: 30` → `ApiError` 400, field `bounds`.
- [ ] **Step 2: Run** `npx vitest run test/moves-begin.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `server/moves/begin.ts`, `Moves.begin`, the `onFinal` branch, the audit actions and the fake proxy's `move.begin`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(moves): start a move from cams-admin, fixing routes, site and host override`.

### Task 4: `POST /api/v1/moves`, the scope, the docs, the bounds line

**Files:**
- Modify: `server/api/router.ts`, next to the other moves routes (:245). Add `r.post('/moves', …)`, which calls `d.moves.begin(actor(res), req.body)`. On `ok` it answers `res.status(202)` with `{commandId, fixed, report}`. Otherwise `res.status(result.status)` with `{error, field?, reason?, report?, fixed?}`.
- Modify: `server/ops/scopes.ts` (add `{ method: 'POST', path: '/moves', scope: 'moves' }`)
- Modify: `web/src/lib/moves.ts` (`boundsText(b: MoveBounds | null): string`), `web/src/components/MoveDetail.svelte` (one line with `data-testid="move-bounds"`), `web/src/api.ts` or wherever `MoveView` is typed on the web side (`autoApprove`, `bounds`)
- Modify: `docs/diagnostics.md`:
  - the scope table gets a row `moves | POST /moves`;
  - a "Start a move" section with the curl form (below), the 202 and 409 bodies, and how to follow the move (`GET /api/v1/diag/moves?accountId=…`, matching the `requestId` from the command's result at `GET /api/v1/accounts/:accountId/proxies/:proxyId/commands/:cmdId`);
  - a note that CA fingerprints are not written automatically (R3).
- Modify: `CHANGELOG.md` `## [Unreleased]`, with the line: "Camera moves can be started from cams-admin (`POST /api/v1/moves`, also with an operations token with scope `moves`): it adds the missing cams routes, the proxy's own site and clears a camera's host override first, and can pre-approve the move within bounds (the source proxy approves its own offer when the target's answer fits)."
- Test: `test/api-moves.test.ts`, `test/ops-auth.test.ts` (the coverage walk picks up the route; one explicit case), `web/src/lib/moves.test.ts`

The curl form, exactly:

```
curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' \
  -d '{"sourceProxyId":"prx_…","targetProxyId":"prx_…","cameraId":"porch","bounds":{"transfer":true,"kinds":["clips","stills","events","checks","archive"],"space":"fit","maxBudgetS":3600}}' \
  https://cams-admin.example.net/api/v1/moves
```

- [ ] **Step 1: Write the failing tests**
  - `api-moves`: `POST /moves with a session answers 202 with commandId, fixed and report`, with `report.ok === true`.
  - `api-moves`: `POST /moves answers 409 precheck with the report`: body `error: 'precheck'`, `reason: 'target_offline'`, and `report.rules` has a rule `target_online` with `ok: false`.
  - `api-moves`: `POST /moves with a bad body is 400 with the field`. Missing `targetProxyId` → `{error:'invalid', field:'targetProxyId'}`.
  - `api-moves`: `a session POST without X-Cams-Admin is 403 csrf`.
  - `ops-auth`: `a moves token may POST /moves; a routes token gets 403 scope`. With the `routes` token nothing is fixed and no command is created.
  - `web moves.test`:

```ts
expect(boundsText(null)).toBe('Approval on the source proxy');
expect(boundsText({ transfer: true, kinds: ['clips', 'stills'], space: 'fit', maxBudgetS: 3600 })).toBe('Auto-approved within: clips, stills; space fit; at most 60 min');
expect(boundsText({ transfer: false, kinds: [], space: 'all', maxBudgetS: 90 })).toBe('Auto-approved within: no content; at most 2 min');
```

  (Minutes are rounded up, `Math.ceil(maxBudgetS / 60)`.)
- [ ] **Step 2: Run** `npx vitest run test/api-moves.test.ts test/ops-auth.test.ts web/src/lib/moves.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, the scope entry, `boundsText` and the detail line, the docs and the CHANGELOG line.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check && npm run check:svelte`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): POST /moves (session or ops token, scope moves); docs`.

### Task 5: Localstack — one move that is approved automatically (after both mains)

**Files:**
- Modify: `scripts/localstack/move-check.ts` (scenario 4)
- Modify: `docs/localstack.md` ("The move check": scenario 4; the output line `move-check: 4/4 scenarios ok`)

Scenario 4, **beta-1 → beta-2, started from cams-admin and approved automatically**. It starts where scenario 3 left the camera, on beta-1.
- [ ] **Step 1: Write the scenario.** Its steps:
  - With the session, issue an ops token: `POST /ops-tokens {name: 'move-check', days: 1, scopes: ['moves']}`.
  - Break two fixable rules: PATCH beta-2's registry `tlsSite` to null, and DELETE the route from one cams instance to beta-2 if one exists. The scenario keeps `caFingerprints` and `tlsServername` as they are.
  - `POST /api/v1/moves` with `Authorization: Bearer <token>` and body `{sourceProxyId: beta-1, targetProxyId: beta-2, cameraId: 'beta-1-cam4', bounds: {transfer: true, kinds: [all five], space: 'fit', maxBudgetS: 3600}}`.
  - Wait for `done`. The scenario never calls beta-1's `/control/moves/:id/approve`.
  - Revoke the token.
- [ ] **Step 2: Write its assertions.**
  - The answer is 202, and `fixed` contains `site_ca` (proxy beta-2), plus `routed` if a route was deleted.
  - The registry `tlsSite` of beta-2 is `'beta-2'` again, and the route is visible with `url: null`.
  - `/diag/moves` shows the move with `autoApprove: true` and the bounds.
  - cams-admin's audit has `move-fix`, `move-begin`, then `move-request` … `move-done`.
  - beta-1's audit has a `move-approve` record whose `details.label` is `cams-admin auto-approval`.
  - Scenario 1's end checks pass (the same helper, `assertOn(beta2, beta1, …)`).
- [ ] **Step 3: Run** `scripts/localstack/stop.sh --clean && LOCALSTACK_MOVES=1 scripts/localstack/start.sh && npx tsx scripts/localstack/move-check.ts`. Expected: `move-check: 4/4 scenarios ok`.
- [ ] **Step 4: Commit** `test(localstack): a move started from cams-admin, approved automatically`.
