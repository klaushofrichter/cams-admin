# The `ptz` move kind and move leftovers (cams-admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams-admin's contract and moves take the content kind `ptz` (a camera's PTZ positions travelling with it), relay the target's accepted kinds to the source, and show each proxy's `moveLeftovers` in the diagnostics.

**Architecture:** The contract (`contract/build.ts`, written by `npm run contract:make`) splits the move kinds into the five file kinds (summary, space, deleted) and all six (plans, bounds, check counts, chunk ids). The `move.offer` accept result and `move.answer` gain an optional `kinds`; the moves service relays it only to a source whose hello announces `move-ptz`. The heartbeat gains an optional `moveLeftovers`, read with clamps like `profile`, kept in the proxy's reported state and shown by `/api/v1/diag/proxies` and the Diagnostics page.

**Tech Stack:** TypeScript, Express, node:sqlite, vitest, Svelte 5, JSON Schema 2020-12 (ajv).

**Spec:** cam-proxy `docs/superpowers/specs/2026-10-30-ptz-capabilities-design.md` §7 (cams-admin is in scope for the content kind and the diag only). cam-proxy's side is its plan `docs/superpowers/plans/2026-10-30-ptz-move-cleanup.md` (plan D), which has the wire decisions this plan mirrors.

**Release order:** this plan is released **first**. cam-proxy plan D then vendors this contract (its `SOURCE` on `main`) and is released after it: a cam-proxy target with plan D sends `kinds` in its offer result, which the contract before this plan refuses (closed in strict, so `bad_result` and `target_failed`), and its events carry `ptz` chunk ids and plan kinds. A cam-proxy before plan D keeps working against this release (every new field is optional; `kinds` goes only to sources announcing `move-ptz`).

## Global Constraints

- `FILE_KINDS = ['stills', 'clips', 'events', 'checks', 'archive']`; `MOVE_KINDS = [...FILE_KINDS, 'ptz']` (both exported from `contract/build.ts`).
- Five file kinds only: `summary` (`move.request`, `move.offer`, `move.summary` result; still all five keys, closed), `space.perKind`, the `move.finish` result's `deleted`, `RETURN_PLAN.kinds`, the estimate (`estimateS`, `bytesOf`), the space check (`server/moves/space.ts`).
- All six: `plan.kinds` and `bounds.kinds` (unique, at most 6), chunk ids `^(stills|clips|events|checks|archive|ptz):[0-9]{4}-[0-9]{2}-[0-9]{2}$`, the check counts' keys (`move.phase` `check`), the new `kinds`.
- `kinds` (optional): in the `move.offer` accept branch `{accept: true, space, probeBps, kinds?}` and in `move.answer` args; unique items of `MOVE_KINDS`, at most 6. Absent = the five file kinds.
- The hello capability `move-ptz` (a string in the existing `capabilities` array): cams-admin puts `kinds` into `move.answer` only when the **source's** last hello listed it.
- Heartbeat `moveLeftovers` (optional, also when truncated; `null` = none). Strict: array of at most 16 closed `{camera (camera id pattern), moveId (mv_ id), items: 1..4 strings of 1..80 characters}`. Lenient: anything; cams-admin reads it with clamps and drops what it can't read, never the heartbeat.
- The UI calls the kind **"PTZ positions"**.
- Public repo: fixtures use ids like `cam4`, `mv_…` from the existing id helpers; no real addresses.
- `npm test`, `npm run lint:types`, `npm run check`, `npm run check:svelte` pass at every commit; `npm run contract:make` leaves no diff after a commit.

## Decisions beyond the spec

- `kinds` is relayed only to sources announcing `move-ptz`: cam-proxy's `move.answer` check is closed, so an older source would refuse the whole answer.
- `bounds.kinds` may name `ptz` (the enum is one), but cam-proxy ignores it there: positions are not a choice. The Start move form does not offer it.
- The Moves page's content list shows a "PTZ positions" row only when the plan names `ptz`: `included` then ignores `transfer` (positions travel also without content transfer).
- The cross-check against cam-proxy (`scripts/contract/cam-proxy-commands.ts`) gets a feature-pending rule: a command fixture with `$context.feature: 'move-ptz'` is `pending` while cam-proxy's `src/moves/types.ts` does not contain `'ptz'`; strict once it does.
- The diag shows leftovers in `/api/v1/diag/proxies` (`reported.moveLeftovers`) and in a "Move leftovers" section on the Diagnostics page (the session reads the diag routes already); no new route.

## Review Focus

1. **A proxy before plan D as the source** (no `move-ptz`) with a plan-D target that sends `kinds`: the `move.answer` must go out without `kinds`, and the move must run as today. Test in Task 2 (`kinds are not relayed to a source without move-ptz`).
2. **A plan-D target's offer result with `kinds`** must not be read as `bad_result`. Test in Task 1 (fixture `valid-result-move-offer-kinds`) and Task 2 (`an offer result with kinds is accepted and relayed`).
3. **The estimate and space check with `ptz` in a plan**: no `summary.ptz` exists; nothing may read it as `NaN` or count it. Test in Task 2 (`estimateS and the space check ignore ptz`).
4. **A heartbeat whose `moveLeftovers` is malformed** (not an array, 20 entries, an item of 500 characters, a number as camera): the heartbeat is taken, the leftovers clamped or dropped. Test in Task 3 (`parseMoveLeftovers clamps and drops`).
5. **The copy back** after a cancel: `RETURN_PLAN` must stay the five file kinds, or the plans no longer compare equal with cam-proxy's. Test in Task 2 (`RETURN_PLAN keeps the five file kinds`).

---

### Task 1: The contract takes `ptz`, `kinds` and `moveLeftovers`

**Files:**
- Modify: `contract/build.ts` (`FILE_KINDS`, `MOVE_KINDS`; `kindMap` per use; `moveSummary`, `moveSpace.perKind`, `move.finish` result use `FILE_KINDS`; `move.offer` accept branch and `move.answer` gain optional `kinds`; heartbeat body gains optional `moveLeftovers`)
- Modify: `contract/make.ts` (fixtures, next to `valid-heartbeat-profile` and the move fixtures)
- Modify: `contract/README.md` ("Camera moves": a `ptz` paragraph; a new "Move leftovers (heartbeat `moveLeftovers`)" section after "The proxy profile")
- Modify: `scripts/contract/cam-proxy-commands.ts` (the feature-pending rule)
- Regenerate: `contract/v1/**` (`npm run contract:make`)
- Test: `test/contract.test.ts`, `test/contract-commands.test.ts`, `test/contract-events.test.ts`

**Interfaces:**
- Produces (`contract/build.ts`):

```ts
export const FILE_KINDS = ['stills', 'clips', 'events', 'checks', 'archive'] as const;
export const MOVE_KINDS = [...FILE_KINDS, 'ptz'] as const;
export const MOVE_LEFTOVERS_MAX = 16;
export const MOVE_LEFTOVER_ITEMS_MAX = 4;
export const MOVE_LEFTOVER_ITEM_LEN = 80;
```
- New fixtures (names fixed; each `valid-*` passes lenient and strict, each `drift-*` passes lenient and fails strict):
  - `valid-result-move-offer-kinds` (accept with `kinds` = all six), `valid-command-move-answer-kinds` (`$context.feature: 'move-ptz'`), `valid-event-move-approve-ptz` (plan `kinds: ['clips', 'ptz']`), `valid-event-move-approve-ptz-only` (`transfer: false`, `kinds: ['ptz']`), `valid-event-move-progress-ptz` (a chunk `ptz:2026-10-30`), `valid-event-move-phase-check-ptz` (`check.failed: {ptz: 1}`);
  - `valid-heartbeat-move-leftovers` (`[{camera: 'cam4', moveId, items: ['config.json entry', 'env CAMPROXY_CAMERA_PASSWORD_CAM4_FILE']}]`), `valid-heartbeat-move-leftovers-null`, `drift-heartbeat-move-leftovers-long` (5 items);
  - `drift-event-move-request-summary-ptz`: a `move.request` whose `summary` has a sixth key `ptz` (lenient is open and takes it; strict's closed summary refuses it, which is why cam-proxy never sends one).
- Feature-pending rule in the cross-check: `const PTZ_STARTED = readFileSync(file('src/moves/types.ts'), 'utf8').includes("'ptz'")`; a fixture with `f.$context.feature === 'move-ptz'` and a different verdict counts `pending` while `!PTZ_STARTED`.

- [ ] **Step 1: Write the failing tests**
  - `contract.test.ts`: `FILE_KINDS and MOVE_KINDS` (values above); `summary and space.perKind keep the five file kinds, plan and bounds take six`; `the new fixtures validate as named` (or extend the existing loop's expected fixture list, as the file does for other groups).
  - `contract-commands.test.ts`: `move.answer with kinds: lenient and strict valid; kinds ['ptz','ptz'] or ['video'] refused`; `the move.offer result with kinds validates; without kinds still does`.
  - `contract-events.test.ts`: `move.progress with a ptz chunk id`, `move.phase check with ptz`, `move.approve with ptz` validate; `a move.finish result with deleted.ptz is refused in strict`.
- [ ] **Step 2: Run** `npx vitest run test/contract.test.ts test/contract-commands.test.ts test/contract-events.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `contract/build.ts` and the fixtures in `contract/make.ts`; run `npm run contract:make`.
- [ ] **Step 4: Write the README parts**: under "Camera moves": the kinds split (which wire fields take `ptz`), `kinds` in the offer result and `move.answer` (absent = the five; relayed only to sources announcing `move-ptz`), positions travel with `transfer: false` too, `ptz` chunks have no files; the new section "Move leftovers (heartbeat `moveLeftovers`)" with the strict shape, the lenient rule, the three item forms cam-proxy sends (`config.json entry`, `env CAMPROXY_CAMERA_PASSWORD_<ID>`, `env CAMPROXY_CAMERA_PASSWORD_<ID>_FILE`) and the fixture names.
- [ ] **Step 5: Run** `npm test && npm run lint:types && npm run contract:make && git status --short contract` — Expected: PASS, and no diff after the make. Run `tsx scripts/contract/cam-proxy-commands.ts <a cam-proxy main checkout>` — Expected: `pending valid-command-move-answer-kinds`, no DRIFT.
- [ ] **Step 6: Commit** `git add contract scripts/contract/cam-proxy-commands.ts test/contract.test.ts test/contract-commands.test.ts test/contract-events.test.ts && git commit -m "feat(contract): the ptz move kind, offer kinds and heartbeat moveLeftovers"`

---

### Task 2: Moves use the split and relay `kinds`

**Files:**
- Modify: `server/moves/types.ts` (`FileKind`, `MoveKind` adds `'ptz'`; `MoveKindSummary` over `FileKind`), `server/moves/service.ts` (`estimateS`, `bytesOf`, `answerSpace` use `FILE_KINDS`; the accepted offer at `~613` passes `kinds`; `answer()` takes `kinds`), `server/moves/space.ts` (`FILE_KINDS`), `server/moves/returns.ts` (`RETURN_PLAN.kinds = [...FILE_KINDS]`), `server/moves/view.ts` (`KIND_ORDER` gains `'ptz'`), `web/src/lib/moves.ts` (`KIND_LABEL.ptz = 'PTZ positions'`; the presummary's `KIND_ORDER` stays the five)
- Test: `test/moves-request.test.ts` (or the file that drives an offer to its answer: `grep -ln "awaiting-approval" test`), `test/moves-return.test.ts`, `test/api-moves.test.ts`, `web/src/lib/moves.test.ts`

**Interfaces:**
- Consumes: Task 1's `FILE_KINDS`, `MOVE_KINDS`.
- Produces:
  - `export function answerKinds(x: unknown): MoveKind[] | null` (`server/moves/service.ts`): the offer result's `kinds` when it is an array of unique `MOVE_KINDS` items, else null.
  - The accepted offer sends `move.answer` `{ …as today, ...(kinds && sourceCaps.includes('move-ptz') ? { kinds } : {}) }`, where `sourceCaps = this.d.status.row(m.sourceProxyId)?.reported?.capabilities ?? []` (the store keeps the last hello's capabilities). The `move-offer` audit details gain `kinds` (or null).
  - `moveContent` row for `ptz`: present only when the plan names `ptz`; `included: true` regardless of `transfer`; sizes null (no summary entry); chunk counts from `ptz:` chunks.

- [ ] **Step 1: Write the failing tests**
  - `an offer result with kinds is accepted and relayed` (source hello capabilities `['status', 'commands', 'move-ptz']`: the queued `move.answer` has `kinds` equal to the result's).
  - `kinds are not relayed to a source without move-ptz` (capabilities `['status', 'commands']`: no `kinds` key; the move reaches `awaiting-approval` as before).
  - `an offer result with bad kinds: relayed without kinds` (`['ptz', 'ptz']`).
  - `estimateS and the space check ignore ptz` (a plan with `ptz`; `estimateS(summary, bps)` unchanged; `spaceCheck` unchanged).
  - `moves-return.test.ts`: `RETURN_PLAN keeps the five file kinds` (the existing assertion stays green with `FILE_KINDS`).
  - `api-moves.test.ts`: `the content lists PTZ positions when the plan names ptz, also without transfer`; `no ptz row otherwise` (the existing order assertion `['clips', 'stills', 'events', 'checks', 'archive']` holds for plans without `ptz`).
  - `moves.test.ts`: `kindLine for ptz reads "PTZ positions: included"`.
- [ ] **Step 2: Run** those files with `npx vitest run …` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check && npm run check:svelte` — Expected: PASS.
- [ ] **Step 5: Commit** `git add server/moves web/src/lib/moves.ts web/src/lib/moves.test.ts test && git commit -m "feat: moves carry the ptz kind and relay the target's kinds"`

---

### Task 3: `moveLeftovers` from the heartbeat to the diagnostics

**Files:**
- Create: `server/status/leftovers.ts`
- Modify: `server/status/derive.ts` (`Reported.moveLeftovers`), `server/status/store.ts` (heartbeat at `~182`: `moveLeftovers: parseMoveLeftovers(body.moveLeftovers)`; `HeartbeatBody.moveLeftovers?: unknown`), `server/diag/views.ts` (`reported.moveLeftovers`), `web/src/pages/Diagnostics.svelte` (a "Move leftovers" section), `CHANGELOG.md`
- Test: `test/status-leftovers.test.ts`, `test/diag.test.ts`

**Interfaces:**
- Consumes: Task 1's `MOVE_LEFTOVERS_MAX`, `MOVE_LEFTOVER_ITEMS_MAX`, `MOVE_LEFTOVER_ITEM_LEN`, the camera id and `mv_` id patterns from `contract/build.ts`.
- Produces:

```ts
// server/status/leftovers.ts
export interface MoveLeftover { camera: string; moveId: string; items: string[] }
export function parseMoveLeftovers(x: unknown): MoveLeftover[];   // [] for null/undefined/not an array
```
  Entries whose `camera` or `moveId` don't match their patterns are dropped; at most 16 entries; items: strings only, cut to 80 characters, at most 4, entries left with no items dropped.
- `/api/v1/diag/proxies` item: `reported.moveLeftovers: MoveLeftover[]` (`[]` before a heartbeat that had any).
- Diagnostics page: loads `GET /diag/proxies` with the session; lists each proxy (`displayName ?? name`) that has leftovers, one line per entry: `<camera> (move <moveId>): <items joined by "; ">`, and "No leftovers from camera moves." when none. No tokens or other diag data are shown there.

- [ ] **Step 1: Write the failing tests**
  - `status-leftovers.test.ts`: `parseMoveLeftovers reads a valid list`; `parseMoveLeftovers clamps and drops` (`it.each`: not an array → `[]`; 20 entries → 16; an item of 500 characters → 80; 6 items → 4; camera `42` → entry dropped; moveId `x` → dropped; items `[]` → dropped); `a heartbeat with malformed moveLeftovers is still taken` (the store's heartbeat path: `lastHeartbeatAt` set, `reported.moveLeftovers` `[]`).
  - `diag.test.ts`: `diag proxies show moveLeftovers` (a heartbeat with one entry → the item's `reported.moveLeftovers` equals it); the existing marker grep stays green.
- [ ] **Step 2: Run** `npx vitest run test/status-leftovers.test.ts test/diag.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block and the Diagnostics section.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run check && npm run check:svelte` — Expected: PASS.
- [ ] **Step 5: CHANGELOG** (Unreleased): one user-terms entry: camera moves carry PTZ positions (with cam-proxy's next release); the diagnostics show what a proxy could not clean up after a move.
- [ ] **Step 6: Commit** `git add server/status server/diag/views.ts web/src/pages/Diagnostics.svelte test/status-leftovers.test.ts test/diag.test.ts CHANGELOG.md && git commit -m "feat: show each proxy's move leftovers in the diagnostics"`
