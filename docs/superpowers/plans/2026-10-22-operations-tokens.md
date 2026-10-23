# Operations Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write-scoped bearer tokens for cams-admin, so a script can revoke proxy tokens, set cams-instance routes and cancel moves without a Google sign-in.

**Architecture:** The diagnostics token store becomes a shared `BearerTokens` class, with `DiagTokens` and `OpsTokens` built on it. In `apiRouter`, `requireSysadmin` + `requireCsrf` + `writeLimiter` are replaced by one auth step. That step accepts either a session (as today) or `Authorization: Bearer cao_…` for a route the token's scopes cover, using a route→scope table. A coverage test classifies every route in the router, so a new route never accepts tokens by accident.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, vitest + supertest, Svelte 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-operations-and-move-tokens-design.md` §1 and §5 step 1.

## Global Constraints

- Token format: `cao_` + 32 random bytes as base64url. Only `sha256:<hex>` is stored. The view and the audit show only the 8-hex hash prefix.
- Lifetime 1–90 days, default 30. At most 5 live ops tokens; the next one gets 409 `too_many_tokens`.
- Scopes in this plan: `tokens`, `routes`, `moves`. (`registry` comes with the step-2 fixers; ruling R1 below.)
- Bearer only, so no CSRF check for a bearer request. 60 writes a minute per token, else 429 `rate_limited`.
- The audit actor for a bearer write is `ops-token:<8hex>`. Audit `actorType` stays as each service writes it (ruling R2).
- No token can issue proxy tokens, cams enrollment codes, diag tokens or ops tokens, read or set camera passwords, or reach any GET route under `/api/v1`. Reads use the diag token.
- Revocation is journalled (kind `ops-token`) and replayed at start, like `diag-token`.
- Public repo: no real ids, tokens or addresses in tests or docs.

## Rulings made while planning

- R1: `registry` scope deferred to step 2 — its only legitimate use is "values the proxy reports", which needs the fixer code — cost if wrong: one more scope later.
- R2: actor string `ops-token:<8hex>`, actorType unchanged — every service hard-codes `'sysadmin'`, and the issuing sysadmin is in the `ops-token-issue` record — cost if wrong: an audit filter by actorType can't isolate token writes (the actor prefix still can).

## Review Focus

1. A bearer token on a session-only write route (e.g. `POST /diag-tokens`, `POST …/tokens` issue, `POST /ops-tokens`) → 403 `scope`, nothing written.
2. A bearer token with scope `routes` on a `tokens` route → 403 `scope`.
3. An expired or revoked token, or a `cad_` diag token on a write → 401. A `cao_` token on `/api/v1/diag/*` → 401 (diag accepts only `cad_`).
4. A bearer request with a session cookie also set → the bearer decides; the cookie is ignored.
5. A restore from backup does not bring a revoked ops token back (journal replay).

---

### Task 1: Shared bearer-token store and `OpsTokens`

**Files:**
- Create: `server/auth/bearer-tokens.ts`, `server/ops/tokens.ts`
- Modify: `server/diag/tokens.ts` (becomes a thin subclass, same exports `DIAG_PREFIX`, `MAX_LIVE`, `DEFAULT_DAYS`, `MAX_DAYS`, `hashOf`, `DiagTokens`, `DiagTokenView`), `server/db/migrations.ts` (migration 10), `server/cams/revocations.ts` (kind `ops-token`), `server/server.ts` (build `OpsTokens`, journal, replay, add `ops` to deps), `server/audit.ts` (actions `ops-token-issue`, `ops-token-revoke`, `ops-auth-refused`)
- Test: `test/ops-tokens.test.ts`; `test/diag.test.ts` must stay green unchanged

**Interfaces:**
- Produces: `class BearerTokens<V>` with `list()`, `issue(actor, input)`, `revoke(actor, id)`, `replay(id)`, `verify(token): string | null`. Its config: `{ table, prefix, idPrefix, auditPrefix: 'diag-token' | 'ops-token', defaultDays, maxDays, maxLive }`.
- Produces: `OpsTokens extends BearerTokens`, which adds `scopes: OpsScope[]` to the view and to `issue` input (required, non-empty, unique, each in `OPS_SCOPES`, else FieldError `scopes`), and `verifyScoped(token): { id: string; hashPrefix: string; scopes: OpsScope[] } | null`.
- Produces: `export const OPS_SCOPES = ['tokens', 'routes', 'moves'] as const; export type OpsScope`, `OPS_PREFIX = 'cao_'`, `OPS_MAX_LIVE = 5`, `OPS_DEFAULT_DAYS = 30`, `OPS_MAX_DAYS = 90`.
- Migration 10: table `ops_tokens`, the same columns and checks as `diag_tokens`, plus `scopes TEXT NOT NULL` (a JSON array).

- [ ] **Step 1: Write failing tests** in `test/ops-tokens.test.ts`, against the class with a test db (see `test/helpers`):
  - `issue` returns `cao_` + 43 chars. The view has `scopes`, `hashPrefix` (8 hex) and `state: 'active'`. The default expiry is created + 30 days.
  - `days: 91` → FieldError `days`. `scopes: []`, `['nope']` or `['tokens','tokens']` → FieldError `scopes`.
  - The 6th live token → ApiError 409 `too_many_tokens`.
  - `verifyScoped` returns scopes for a live token, and null for an expired, revoked, unknown, or `cad_` token, or one longer than 128 chars.
  - `revoke` calls the journal with the id. `replay(id)` on an unrevoked row revokes it with `revoked_by = 'system'`.
  - No row or audit detail contains the token string.
- [ ] **Step 2: Run** `npx vitest run test/ops-tokens.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `BearerTokens` by moving the `DiagTokens` body into it, parameterized by the config. `DiagTokens` = `BearerTokens` with `diag_tokens`/`cad_`/`dgt`/90/365/5. Then add `OpsTokens`, migration 10, the journal kind, the server wiring and the audit actions.
- [ ] **Step 4: Run** `npx vitest run test/ops-tokens.test.ts test/diag.test.ts test/db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: operations token store (shared with diagnostics tokens)`

### Task 2: Bearer auth on the API, the scope table, the management routes

**Files:**
- Create: `server/ops/scopes.ts`
- Modify: `server/auth/middleware.ts`, `server/api/router.ts`
- Test: `test/ops-auth.test.ts`

**Interfaces:**
- Consumes: `OpsTokens.verifyScoped` (Task 1), `d.ops` in `ApiDeps`.
- Produces: `OPS_ROUTES: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; scope: OpsScope }[]`, with paths in Express syntax relative to `/api/v1`. Exactly these:
  - `tokens`: POST `/accounts/:accountId/proxies/:proxyId/tokens/:tokenId/revoke`, POST `…/tokens/:tokenId/retire`, POST `…/tokens/apply`
  - `routes`: PUT and DELETE `/cams-instances/:instanceId/routes/:proxyId`, DELETE `/cams-instances/:instanceId/camera-overrides/:cameraId`
  - `moves`: POST `/moves/:moveId/cancel`, POST `/moves/:moveId/end-transfer`
- Produces: `opsScopeFor(method: string, path: string): OpsScope | null`, which matches by compiled pattern (each `:param` is one non-empty segment without `/`).
- Produces: `requireAuth(d: { sessions; ops; audit; cfg; clock }): RequestHandler[]`. It replaces `requireSysadmin(d.sessions), requireCsrf(d.cfg), writeLimiter(d.cfg, d.clock)` on the main router (the import route keeps its own `requireSysadmin` for the big body, and `requireAuth` there must also refuse a bearer).
  - With a `Bearer` header:
    - an unverified token → 401 `unauthorized` and a throttled `ops-auth-refused`;
    - a GET/HEAD, or `opsScopeFor` null, or the scope not held → 403 `scope`;
    - otherwise it sets `res.locals.actor = 'ops-token:<8hex>'` and a 60/min limit keyed `ops:<id>`.
  - Without one: the session path as today, plus `res.locals.actor = session.email`.
  - `actor(res)` in the router reads `res.locals.actor`.
- Produces: routes `GET /ops-tokens`, `POST /ops-tokens` (201, `Cache-Control: no-store`, `{token, item, shownOnce: true}`), `POST /ops-tokens/:tokenId/revoke`. These are session-only, because they are not in `OPS_ROUTES`.

- [ ] **Step 1: Write failing tests** in `test/ops-auth.test.ts`, using `testApp` as in `test/diag.test.ts`:
  - Coverage: walk `apiRouter(...)`'s layer stack (`router.stack`, each `layer.route.path` + methods). Every non-GET route is either in `OPS_ROUTES` or answers 403 `scope` to a token holding all scopes. Every `OPS_ROUTES` entry exists in the stack.
  - With a `tokens` token, revoking a seeded proxy token → 200. The token row is `revoked`. The `token-revoke` audit actor is `ops-token:<8hex>`.
  - With a `tokens` token, PUT a route → 403 `scope`. With a `routes` token, PUT then DELETE a route → 200/204. A `moves` token cancels a seeded move with `{confirm:'cancel'}` → 202.
  - Each Review Focus item 1–4 as its own test. The cookie-plus-bearer test: an expired bearer with a valid session cookie → 401.
  - A bearer write needs no `X-Cams-Admin` header. A session write without it is still 403 `csrf`.
  - 61 writes in a minute with one token → the 61st gets 429.
  - `POST /ops-tokens` with a session → 201 and `shownOnce`. With a bearer → 403 `scope`.
- [ ] **Step 2: Run** `npx vitest run test/ops-auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/ops/scopes.ts`, `requireAuth`, the `actor` change and the management routes.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including `api-audit-completeness`.
- [ ] **Step 5: Commit** `feat: write-scoped operations tokens on the API`

### Task 3: Diagnostics page section, diag view, docs

**Files:**
- Modify: `web/src/pages/Diagnostics.svelte` (an "Operations tokens" section: name, days, one checkbox per scope, Issue → `ShownOnce`, the list with scopes/state/expiry and Revoke), `web/src/api.ts` or wherever `diag-tokens` calls live, `server/diag/router.ts` + `server/diag/views.ts` (`GET /diag/ops-tokens`: the list view, no hash beyond the prefix; add it to `ROUTES`), `docs/diagnostics.md` (an operations-token section with the scope table and the curl form `curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' …`), `README.md` (one sentence), `CHANGELOG.md` (Unreleased)
- Test: `e2e/diagnostics.spec.ts` (extend), `test/diag.test.ts` (the `/diag/ops-tokens` case)

- [ ] **Step 1: Write failing tests:**
  - e2e: issue an ops token with scope `tokens` → the token is shown once and is gone after a reload. The list shows `tokens` and Active. Revoke → Revoked.
  - diag: `/diag/ops-tokens` lists the token with `scopes`, and the body never contains the token or a full hash.
- [ ] **Step 2: Run** `npx vitest run test/diag.test.ts`, then `npx playwright test e2e/diagnostics.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the page section (reuse the diag-token section's markup and `ShownOnce`), the view and the docs.
- [ ] **Step 4: Run** `npm test && npm run check && npm run check:svelte && npx playwright test e2e/diagnostics.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: operations tokens on the Diagnostics page; docs`
