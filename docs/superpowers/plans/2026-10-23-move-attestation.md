# Move attestation and Start move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A camera moved by cams-admin is accepted by every cams instance without a Confirm (fixes cams #269), and an admin can start a move from the cams-admin Moves page.

**Architecture:** cams-admin adds a per-camera `move` attestation `{id, sourceProxyId, targetProxyId, expiresAt}` to the signed cams snapshot (the snapshot signature covers it). cams parses it and extends `TrustStore.decide` with two attested rules: (A) a confirmed camera moving from a trusted source onto a not-yet-trusted target proxy trusts that proxy; (B) a camera new to this instance, landing on a proxy this instance already trusts, is confirmed. Both log `move-attested`. The Moves page gets a Start move form that calls the existing `POST /api/v1/moves`.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, Express, Svelte 5, vitest, Playwright. Two repos: cams-admin (Tasks 1–2), cams (Tasks 3–4).

**Spec:** cams-admin `docs/superpowers/specs/2026-10-22-operations-and-move-tokens-design.md` §3 (Klaus approved 2026-10-22, "go" 2026-10-23).

## Rulings made while planning (deviations from §3)

- Ruling: no second signature; the attestation is a field inside the already Ed25519-signed snapshot, whose `instance.id` binds it to one cams instance — the same key signs both, a nested signature adds nothing — cost if wrong: one extra field and verify call later.
- Ruling: two rules instead of the spec's single "source trusted" rule. The spec's rule cannot fix #269: the mini PC's cams instance never routes the source proxy (een), so the source is never trusted there. Rule B covers it: a new camera is accepted only onto a proxy this instance *already trusts*, with the TLS name `<proxyCameraId>.<site>.internal` that only that proxy's site CA can certify — cams-admin still can't introduce a proxy from nowhere, which is what §3's limit protects — cost if wrong: a compromised cams-admin can add a camera entry pointing at a camera the trusted proxy certified.
- Ruling: expiry is 24 h from the switch-over (`moves.switched_at`, new), checked by cams against its own clock.

## Global Constraints

- Public repos: no real addresses, serials, tokens, ids or passwords in code, fixtures or docs (use 192.0.2.x, example ids).
- Trust log entries carry ids, never values (existing rule in cams `trust.ts`).
- Contract changes go into cams-admin `contract/cams-build.ts`, then `npm run contract:make`, commit the generated files; cams vendors `contract/cams-v1/` with `SOURCE` = the cams-admin commit.
- `SNAPSHOT_FORMAT` becomes `3`.
- Attestation lifetime: `24 * 3600_000` ms after `switched_at`.
- Move id pattern `^mv_[0-9A-HJKMNP-TV-Z]{20}$`; proxy id `^prx_[0-9A-HJKMNP-TV-Z]{20}$`.
- Every change has tests; every repo's `npm test` and `npm run check`/lint stay green.

## Review Focus

1. An expired attestation (cams clock past `expiresAt`) must hold the camera exactly as today.
2. An attestation whose `targetProxyId` is not the camera's offered proxy, or whose `id` differs from `moveId`, must be ignored.
3. Rule B on a proxy that is offered with a *changed* pin or URL (held proxy) must hold — a trusted proxy id with new values is not trusted.
4. A cancelled move (camera back on the source, `move_id` still set) must not emit an attestation.
5. The Start move form must show the refusal reasons from a 409/422 answer instead of a generic error.

---

### Task 1: cams-admin — attestation in the snapshot

**Files:**
- Modify: `server/db/migrations.ts` (migration 13: `ALTER TABLE moves ADD COLUMN switched_at INTEGER;`)
- Modify: `server/moves/store.ts` (`markCamera` sets `switched_at = clock.now()` on the move)
- Modify: `contract/cams-build.ts` (camera `move` field), regenerate `contract/cams-v1/` (`npm run contract:make`)
- Modify: `server/cams/snapshot.ts` (`SnapCamera.move`, `SNAPSHOT_FORMAT = 3`)
- Modify: `contract/cams-v1/README.md` source text in `cams-build.ts` (document the field and the cams rules A/B)
- Test: `test/cams-snapshot.test.ts`, `test/contract-cams.test.ts`, `test/moves-switch.test.ts`

**Interfaces:**
- Produces: `SnapCamera.move: { id: string; sourceProxyId: string; targetProxyId: string; expiresAt: number } | null`; contract strict schema requires `move`, lenient accepts it absent.

- [ ] **Step 1: Write the failing tests**
  - `moves-switch.test.ts`: `markCamera sets switched_at` — after the switch-over the move row's `switched_at` equals the test clock.
  - `cams-snapshot.test.ts`:
    - `a camera on its move's target carries the attestation`: move in phase `copying`, camera `proxy_id` = target, `switched_at` = T → `move` equals `{ id, sourceProxyId, targetProxyId, expiresAt: T + 86_400_000 }`.
    - `no attestation after a cancel`: phase `cancelled` (camera back on source) → `move: null`, `moveId` still set.
    - `no attestation for a camera not on the target`, `no attestation without switched_at` (pre-migration rows) → `null`.
    - Phases that emit: `switching`, `copying`, `cleaning`, `done`. Every other phase → `null`.
    - `SNAPSHOT_FORMAT` is 3 and the revision differs from format 2 for the same rows.
  - `contract-cams.test.ts`: the generated strict schema refuses a camera without `move`; lenient accepts it; `valid-snapshot-two-accounts.json` has one camera with a `move` object (the one with `moveId`) and validates under both.

- [ ] **Step 2: Run them, expect FAIL** — `npx vitest run test/cams-snapshot.test.ts test/contract-cams.test.ts test/moves-switch.test.ts`

- [ ] **Step 3: Implement** — migration 13; `markCamera` sets the timestamp in the same transaction; `buildSnapshot` LEFT JOINs `moves m ON m.id = c.move_id` and emits `move` only when `m.phase IN ('switching','copying','cleaning','done') AND c.proxy_id = m.target_proxy_id AND m.switched_at IS NOT NULL`; contract field `move: nullable(obj({id: id('mv'), sourceProxyId: id('prx'), targetProxyId: id('prx'), expiresAt: int}))`, optional in lenient like `moveId`; `npm run contract:make`.

- [ ] **Step 4: Run the full suite** — `npm test` → all pass; `npm run check` → clean.

- [ ] **Step 5: Commit** — `git add` the named files and `contract/cams-v1/`; `feat(cams): move attestation in the snapshot (format 3)`.

### Task 2: cams-admin — Start move on the Moves page

**Files:**
- Modify: `web/src/pages/Moves.svelte` (a "Start move" card above the list)
- Modify: `web/src/lib/moves.ts` (`startBody`, `refusalText`)
- Modify: `docs/diagnostics.md` "Follow the move" (one paragraph: the page form = the same `POST /moves`), README if it lists pages
- Test: `web/src/lib/moves.test.ts`, `e2e/moves.spec.ts`

**Interfaces:**
- Consumes: `POST /api/v1/moves {sourceProxyId, targetProxyId, cameraId, bounds}` → 202 `{commandId, fixed, report}` or an error status with `{error, report?}` (see `server/api/router.ts:254`).
- Produces: `startBody(sourceProxyId: string, targetProxyId: string, cameraId: string): { sourceProxyId; targetProxyId; cameraId; bounds: MoveBounds }` with default bounds `{ transfer: true, kinds: ['clips','stills','events','checks','archive'], space: 'fit', maxBudgetS: 86400 }`; `refusalText(answer: unknown): string` (failed precheck rules joined by "; ", else the error code text).

- [ ] **Step 1: Write the failing tests**
  - `moves.test.ts`: `startBody` returns exactly the default bounds above; `refusalText` of `{ error: 'precheck_failed', report: { rules: [{ id: 'online', ok: false, detail: 'target offline' }, { id: 'x', ok: true }] } }` is `'target offline'` (use the real report shape from `server/moves/precheck.ts`); of `{ error: 'busy' }` is a non-empty human text.
  - `e2e/moves.spec.ts`: `start a move from the Moves page` — pick account's source proxy, a camera on it, a target proxy; click **Start move**; the request body equals `startBody(...)`; the page shows "Move requested" and the list reloads. A second case answers 409 with a report and the card shows the `refusalText`.

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run web/src/lib/moves.test.ts` and `npx playwright test e2e/moves.spec.ts -g "Start move|start a move"`.

- [ ] **Step 3: Implement** — selects fed by the endpoints the Proxy and Cameras pages already use; the target list excludes the source and proxies of other accounts; camera list = cameras whose `proxyId` is the source. One button, no typed confirmation (Klaus: fewer clicks). Show `fixed` items when present ("cams-admin fixed: …").

- [ ] **Step 4: Run the full suite** — `npm test`, `npm run check`, `npx playwright test e2e/moves.spec.ts` → pass.

- [ ] **Step 5: Commit** — `feat(moves): start a move from the Moves page`.

### Task 3: cams — vendor the contract, parse the attestation

**Files:**
- Modify: `contract/cams-v1/**` (copy from cams-admin branch head), `contract/cams-v1/SOURCE`
- Modify: `server/admin/snapshot.ts` (`SnapCamera.move`, validation)
- Test: `test/contract/camsV1.test.ts`, the snapshot parse test next to it (grep `camera ${i}` failures)

**Interfaces:**
- Produces: `SnapCamera.move: { id: string; sourceProxyId: string; targetProxyId: string; expiresAt: number } | null` (absent → `null`).

- [ ] **Step 1: Failing tests** — a snapshot camera with a valid `move` parses to it; absent → `null`; `move` with a bad id pattern, non-integer `expiresAt`, or a non-object fails the account part (`camera <i>`); all vendored `valid-*` fixtures parse.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run test/contract`
- [ ] **Step 3: Implement** — validate in the camera check at `server/admin/snapshot.ts:69` with `MOVE_ID_RE` and a `PRX_RE`; copy the vendored files and SOURCE.
- [ ] **Step 4: Run** — `npm test` → pass.
- [ ] **Step 5: Commit** — `feat(admin): vendor cams-v1 with the move attestation`.

### Task 4: cams — attested move rules (A and B)

**Files:**
- Modify: `server/admin/apply.ts` (`MoveContext.attested`, built at line ~105)
- Modify: `server/admin/trust.ts` (`decide`, new private `attestedAllowed`, log action `'move-attested'`)
- Modify: docs where the move rule is described (grep `camera_moved_trusted` / "move rule" in `docs/`), `CHANGELOG.md` Unreleased
- Test: `test/admin/trust.test.ts` (new `describe('TrustStore: attested moves')`), `test/admin/apply*.test.ts` if present for the context wiring

**Interfaces:**
- Consumes: Task 3's `SnapCamera.move`.
- Produces: `MoveContext { moveId; proxyId; proxyCameraId; site; attested?: { sourceProxyId: string; targetProxyId: string; expiresAt: number } }` — set only when `c.move && c.move.id === c.moveId && c.move.targetProxyId === p.id`. `LogEntry.action` gains `'move-attested'` (with `moveId`, `proxyIds`).

Rule conditions (both need: `attested` present, `Date.now() < expiresAt`, the TLS name `${proxyCameraId}.${site}.internal` with `site` non-null, `offered.proxyUrl` non-null, `offered.caFingerprints` non-empty, `offered.host`/`protocol` non-null):
- **A** (confirmed camera, target proxy not trusted): the source proxy (`attested.sourceProxyId`) is trusted and the camera's confirmed proxy part equals that trusted entry; host and protocol equal the confirmed ones; the target proxy is offered in this snapshot with exactly the offered proxy part. Effect: trust the target proxy with the offered values, confirm the camera, one log entry `{action:'move-attested', moveId, camsIds:[camsId], proxyIds:[targetProxyId]}`, logger `camera_move_attested`.
- **B** (no confirmed values for the camera): the target proxy is trusted with exactly the offered proxy part and not held. Effect: confirm the camera, log as A with `proxyIds: []`.
- The existing move rule stays first and unchanged; A/B apply only when it didn't.

- [ ] **Step 1: Failing tests** (reuse the move-rule fixtures; `MOVE = 'mv_…'`, not `mov_`):
  - `A: a confirmed camera moving from a trusted source onto a new proxy trusts it`: the target is then in `heldProxies` → `[]`, the decision is `{confirmed:true, held:null}`, the log entry is as above with no values in it.
  - `A refused: source not trusted`, `A refused: host changed`, `A refused: expired` (`expiresAt = Date.now() - 1`), `A refused: attestation names another target` → held as today, proxy still held.
  - `B: a new camera on a trusted proxy is confirmed` (#269 shape: `cam4`, site `minipc`) → `confirmed:true`; persisted after `TrustStore.load`.
  - `B refused: proxy trusted with other values (held pin)`, `B refused: TLS name not under the site`, `B refused: no attestation` (the existing `a new camera is never confirmed by a move` still passes), `B refused: expired`.
  - apply wiring: `buildFleet` passes `attested` only when ids match (unit test with a stub `trust`).
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run test/admin/trust.test.ts`
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run** — `npm test`, `npm run check` → pass.
- [ ] **Step 5: Commit** — `feat(admin): accept a cams-admin-attested camera move without Confirm (#269)`.

## Release order

cams-admin first (cams ignores the new field until Task 3–4 ship), then cams; then update cams on the Pi and the mini PC.
