# cams-admin: migration phase 4 (cams reads cams-admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams-admin serves cams instances: it enrolls each one with its own key, answers a signed service API (a signed configuration snapshot per instance, token-hash registration, status reports), imports today's `cameras.json` exports (dry run, idempotent, cross-checked against the live proxies) and exports a file-mode fallback, so cams can read accounts, users, roles, proxies, cameras, routes and token states from cams-admin (P4a, the cams-admin half of P4c).

**Architecture:** A new `server/cams/` area: `CamsInstances` (registry of instances, served accounts, routes, enrollment codes, keys, in-memory status), `CamsAuth` (the normative request check and the answer signer, mounted on `/cams/v1` with a raw-body parser), `buildSnapshot` (instance-filtered, secret-free, JCS-signed) and the routes. `Tokens` (P2) gains a cams holder. `server/import/` holds the importer and the export. The contract (`contract/cams-v1/`) comes first; cams vendors it. Registry writes bump `config_revision` through SQLite triggers, so every write that changes what cams sees changes the ETag without extra code. Nothing here touches the proxy channel or P3's commands.

**Tech Stack:** TypeScript, Express 5, `node:sqlite`, Node `crypto` Ed25519, ajv (run time lenient, strict in tests), vitest, Svelte 5, Playwright. Node ≥ 26. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (cited **M §n**): §2, §3 (M1, M6–M9), §5 (`cams_instances` and friends, `config_revision`, audit actions), §6, §9.1–§9.3, §9.6 (routes), §10.1 (cams holder), §10.3, §11.1–§11.4, §11.6 (Export), §12.1, §12.5, §13.2, §13.3, §14.1–§14.3, §14.5, §15 (P4a, P4c). P1 spec `2026-10-06-cams-admin-phase1-design.md` (**P1 §n**). The companion plan is cams `docs/superpowers/plans/2026-10-07-migration-p4-cams.md`; the sections "Klaus's decisions", "Rulings" and "The cams-v1 contract" are **identical** in both plans. The cut-over is run from `docs/migration-p4-runbook.md` (in this PR).

**Independence from P3:** the P3 plans (written in parallel) add `config.*` commands and `proxy_config`. This plan reads nothing of P3: no P3 table, command, route or UI. Conflicts can arise only in `server/db/migrations.ts` (R4-18), `server/audit.ts` (the action list: keep both sets), `server/server.ts` (wiring), `server/api/router.ts` (routes), `web/src/pages/Dashboard.svelte` and `CHANGELOG.md`; resolve them by keeping both sides.

## Klaus's decisions (binding; recorded as decisions, not defaults)

Klaus pre-approved spec, plan, implementation and deployment, and decided:

1. **One cams hostname serves several accounts** (M §9.5, M8): the cluster's cams instance serves every account listed for it.
2. **The same email may be in several accounts** → an **account picker** after sign-in (M §9.5).
3. **One user per account, role `admin` or `viewer`** (P1 §4 `UNIQUE (account_id, email)`).
4. **cams holds changed connection data** (proxy URL, CA pins, camera host, TLS names) until an account admin confirms (M6, M §9.7, Q1).
5. **cams uses its cached configuration however old** when cams-admin is unreachable (M §9.4, Q2).
6. **The Pi's cams (demo kit) works offline** with its local fallback (M §9.4).
7. **The Google OAuth consent screen is "Internal"** for now: no code impact; it limits who can test sign-in in production (R4-20).

## Rulings (identical in both P4 plans; where the spec is silent or unclear)

- **R4-1 The snapshot revision is an ETag string.** M §5 keeps one `config_revision` row per account, but a snapshot covers several accounts. `revision` = `"r:" + 16 hex` over the served accounts' revisions, the instance's version and the signing key (contract section). cams compares it for equality only.
- **R4-2 `config_revision` is bumped by SQLite triggers** on `accounts`, `account_users`, `proxies`, `cameras`, `proxy_tokens` and `cams_instance_routes`, inside the writing transaction. No registry code path can forget it, and it costs no extra write transaction.
- **R4-3 Hidden routes.** `cams_instance_routes` gains `hidden` (0/1; `url` may be null only when hidden). A proxy hidden for an instance is left out of that instance's snapshot together with its cameras. Reason: the Pi's cams serves `home` but shows only the Pi's camera today; without this its snapshot would list every `home` camera and the shadow comparison (step 6) could never reach zero. The importer's `--hide-unlisted` writes hidden routes for the account's proxies the file doesn't use.
- **R4-4 Audit actor type `cams`.** `audit_log.actor_type`'s CHECK lists the actor types, so the migration rebuilds the table (copy, drop, rename, re-index) to add `cams`. A cams instance's requests audit as `actorType: 'cams', actor: 'cms_…'`.
- **R4-5 cams enrollment codes are `CAC1-…`** with their own proof text (contract). `admin-enroll` prints cams-admin's server key fingerprint and the instance page shows it, so a person can compare them: the in-cluster enroll answer is plain HTTP and unsigned, exactly like P1's proxy enrollment.
- **R4-6 The importer matches proxies by token hash first** (the hash of the file's `proxy.token` equals a `proxy_tokens` row: the P2 managed tokens of cut-over steps 1–2), then by registered URL, then by this instance's route. A new proxy is created only with `createProxies: true`. It never deletes. It runs **in the server** (the cross-check reads the live heartbeat state in memory): production imports go through the account page; `npm run import` is an API client for the local stack and the rehearsal.
- **R4-7 Trust fields include `protocol`.** M §9.7 lists proxy URL, CA pins, proxy TLS name, camera host and camera TLS name; an `https` → `http` change sends the camera password in clear, so `protocol` is held too. Holds are per camera, keyed by **(account id, camsId)**, and cover the whole set of six values: a camera deleted and re-created in cams-admin with the same camsId is a change, never "new".
- **R4-8 cams's internal camera key is `<accountId>/<camsId>`**, a branded TypeScript type `CamKey`. Every internal map, event and store uses it; a bare camsId never finds a camera (fail closed). The compiler is the first scan (a `string` is not a `CamKey`); the source scan of M §9.6 is the second.
- **R4-9 The role table's viewer exemptions.** Every non-GET API route needs `admin` except, explicitly listed: `PUT /api/preferences` (own preferences, M §9.5), `POST /api/session/account` (the picker), and `POST`/`DELETE /api/cameras/:id/compositions[/:job]` (the "save around" download: it reads recordings and writes only a temporary file on the proxy). Klaus may move compositions to `admin` (one table line).
- **R4-10 File mode reads both state layouts.** The stores (preferences, proxy switch, TLS pins) keep the layout they find: the old one (`{email: prefs}`) until the first start in `cams-admin` mode moves it into the account layout (`*.pre-accounts.bak` kept, M §11.5); file mode reads the account layout too, using the entry of the account named `CAMS_FILE_ACCOUNT` (default `home`). So a rollback keeps what users changed in `cams-admin` mode.
- **R4-11 The trust store is seeded from `CAMERAS_FILE`** at the first start in `cams-admin` mode (account `CAMS_FILE_ACCOUNT`): today's file is the confirmed state, so after a zero-difference shadow period nothing is held at step 7 ("confirm the import" then means: the held list is empty, or Klaus confirms what remains). Without a file, a new camera's values are confirmed when its credentials exist locally (M §9.7, §9.8).
- **R4-12 Token transition.** In `cams-admin` mode a proxy without an `active` token held by this instance uses the legacy token from `CAMERAS_FILE` (the client and admin token of a camera of account `CAMS_FILE_ACCOUNT` on that proxy, matched by camsId) until its own token is active (M §10.1).
- **R4-13 Several memberships always show the picker** after a Google sign-in, the remembered account first; one membership signs in directly. A session cookie without `acc` (made before P4) resolves to the only membership, else the API answers `409 choose_account` and the web app opens the picker.
- **R4-14 Token sign-in's account** is `CAMS_TOKEN_ACCOUNT` (an account name), default the only served account. When it can't be resolved (several served accounts and none named, or the name not served), the token login answers `503 token_account_ambiguous` and logs it; cams still starts (the offline Pi must).
- **R4-15 Clip-cache names stay flat:** `fileSafe(key)` = `acc_….cam1` as the prefix of every cache key (`DiskCache` is flat by design and refuses `/`). The isolation property of M §9.6 (no two accounts share a cache name) holds.
- **R4-16 Snapshot validation is per account:** an account part that fails cams's checks keeps that account's last good part and is reported (`snapshot_invalid`); the other accounts apply.
- **R4-17 Cut-over steps 5–8 don't depend on P3.** The importer cross-checks against the proxies' heartbeat (reported camera ids and CA fingerprints, P1 §8.6), never `config.get`; steps 3–4 (P3) may happen before or after.
- **R4-18 Migration numbering.** P4's migration is appended as the next free number when it is implemented. The P3 plans are written in parallel: whichever merges second renumbers its migration and fixes its test's expected `user_version`. A shipped migration is never edited.
- **R4-19 Deleting or blocking a cams instance revokes its tokens** (each through `Tokens.revoke`, so the proxies drop them) and its keys.
- **R4-20 The production viewer check** (step 7) uses Klaus's own membership switched to `viewer` in cams-admin for the check and back (he stays a cams-admin sysadmin, so no lockout); the OAuth consent screen is Internal, so there is no outside test account. The picker check uses a second account `test` with Klaus as a member and no cameras.


## Global Constraints

- **No secret crosses the service API or reaches the database:** no camera password, no token, no token hash in a snapshot, no enrollment code, no private key (M1, M §9.3). Token hashes are stored (P2) and appear in views, audit details and the importer's diff only as an 8-hex prefix (`sha256:1a2b3c4d`). The P1 secret-marker guard is extended to the snapshot, the report, the importer's diff and the export (M §13.3).
- **Every `/cams/v1/*` answer past the header check is signed** (`X-Cams-Admin-Sig`), errors included; the snapshot body carries its own `sig` (contract).
- **Request check order is normative** (contract, steps 1–9) and limits never key on the client address: the failed-signature budget is global (300 / 10 min), the request budget per instance (60 / min), enrollment per code hash and global (as P1).
- **An instance sees only its served accounts.** Every service-API query is scoped by `cams_instance_accounts`; a proxy id, token id or account id outside them answers `404 not_found`, never `403` (no existence oracle).
- **The database is written only on meaningful changes** (P1 rule): pulls, reports, nonces, key last-seen times and instance status live in memory; enrollment, key confirmation, token registration and registry edits are write transactions. `test/write-budget.test.ts` gains a P4 case.
- **Contract first:** a change to the service API goes into `contract/cams-build.ts`, `npm run contract:make`, commit; cams vendors it the same day.
- **Public repository:** RFC 5737 / 2606 values in fixtures, docs and the runbook; the rehearsal's real exports stay in the scratch work dir, never in git.
- **Never** the real camera, the Pi, the cluster or the real S3 bucket from tests or the Mac; the runbook's real steps are Klaus's (or kube-setup's) to run.
- **Spec limits copied verbatim:** answers ≤ 1 MiB; `|ts − now| ≤ 300 s`; nonces unseen within 10 min; 60 requests per minute per instance; failed signatures 300 per 10 min in total; reports at most every 60 s (cams side); `retiring` 24 h default, 1 h–7 d.

## Review Focus

1. **A cams instance asks for something of an account it doesn't serve** (a proxy id in `POST /cams/v1/tokens`, a token id in `retire`, or a served account removed between two pulls): `404 not_found`, nothing written, and the next snapshot no longer lists the account. Task 6 (snapshot filter), Task 7 (token routes).
2. **A captured request replayed** (same nonce within 10 min; or after a cams-admin restart within the 300 s window): `401 replayed` within the window; after a restart a replayed `GET config`/`report` is harmless and a replayed `POST tokens` is idempotent by hash. Task 5 (nonce test), Task 7 (idempotency test).
3. **The Pi's clock is hours off** (no RTC): the first request gets a signed `401 clock_skew` with `serverTime`, the retry with the offset passes; a `clock_skew` answer is itself signed (a forged one can't steer cams's clock). Task 5.
4. **An import run twice, or the Pi file after the cluster file:** the second run shows "no changes"; the Pi file adds a route (loopback URL) and hidden routes, never changes the cluster's proxy URL, and never deletes. Task 8.
5. **The snapshot leaks something it must not** (a hash, a code, another account's camera because a proxy moved accounts, a hidden proxy's camera): the guard test with markers and the two-instance filter test fail. Task 6.

---

## The cams-v1 contract (identical in both plans; binding)

The cams service API (M §9.2) between a cams instance and cams-admin. Its written source is cams-admin `contract/cams-v1/` (lenient and strict JSON Schemas, fixtures, `vectors.json`, `README.md`), generated by `contract/cams-build.ts` through `npm run contract:make`. cams vendors it into `contract/cams-v1/` with a `SOURCE` file (the cams-admin commit) the way cam-proxy vendors `contract/v1/`. All paths are under `/cams/v1/`; every body is JSON (UTF-8); requests are at most 64 KiB, answers at most 1 MiB.

**Shared primitives** (byte-identical in both repos; cams copies cams-admin's `server/crypto/jcs.ts` verbatim as `server/admin/jcs.ts`):

- `jcs(value)`: RFC 8785, the P2 contract's function.
- `sha256hex(bytes)`: lower-case hex of SHA-256 over the exact body bytes (`""` for an empty body: `e3b0c442…b855`).
- Keys: Ed25519; public keys base64 SPKI DER (44 bytes), private keys base64 PKCS#8 DER; signatures base64 (88 characters) — as P1.

**Ids:** instance `^cms_[0-9A-HJKMNP-TV-Z]{20}$`; instance key `^key_…{20}$` (the P1 prefix, its own table); account `acc_`, proxy `prx_`, camera `cam_`, token `tok_` as P1/P2.

### Enrollment: `POST /cams/v1/enroll` (unsigned request, unsigned answer; as P1 §8.2)

Request (≤ 8 KiB): `{ "v": 1, "code": "CAC1-XXXX-XXXX-XXXX-XXXX-XXXX", "publicKey": "<b64 spki>", "proof": "<b64 sig>", "camsVersion": "<≤64>" }`.

- The code tag is **`CAC1`** (a proxy code is `CAE1`; neither endpoint accepts the other's), normalised like P1 (upper case, spaces/dashes dropped, `O`→`0`, `I`/`L`→`1`).
- `proof` = Ed25519 over `"cams-admin cams-enroll v1\n" + canonicalCode + "\n" + publicKey` (a different text from the proxy's `"cams-admin enroll v1\n…"`, so a proof can never be replayed across the two).

Answers: `201 { "v": 1, "instanceId": "cms_…", "instanceName": "cluster", "keyId": "key_…", "accounts": ["home"], "serverKeys": ["<b64 spki>", …], "serverKeyFingerprints": ["SHA256:…"], "apiUrl": "<origin the request came in on, if allow-listed, else PUBLIC_URL>" }`; `400 {error: "bad_request" | "bad_proof"}`; `401 {error: "invalid_code"}` (unknown, used, cancelled, expired or instance blocked: one answer); `429 {error: "rate_limited", retryAfterS}`. The new key is **pending** until its first verified signed request (as P1 migration 2's pending keys).

### Signed requests (every route but enroll)

Headers:

| header | value |
|---|---|
| `X-Cams-Instance` | `cms_…` |
| `X-Cams-Key` | `key_…` |
| `X-Cams-Ts` | integer ms (the instance's clock + its measured offset) |
| `X-Cams-Nonce` | 16 random bytes, base64url without padding (22 characters, `^[A-Za-z0-9_-]{22}$`) |
| `X-Cams-Sig` | base64 Ed25519 over the request text |

Request text: `"cams-admin/v1 request\n" + METHOD + "\n" + pathAndQuery + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)` where `METHOD` is upper case and `pathAndQuery` is the request target exactly as sent (origin-form, e.g. `/cams/v1/config`).

**Check order on cams-admin** (normative; the first failing step answers):

1. The five headers are present and well-formed, the body ≤ 64 KiB → else `400 bad_request`.
2. The global failed-signature budget (300 per 10 min, all instances together) is not used up → else `429 rate_limited`.
3. The key exists, is not revoked, belongs to the named instance → else `401 unknown_key` (counts as a failed signature).
4. The signature verifies → else `401 bad_signature` (counts).
5. `|ts − serverNow| ≤ 300 000` → else `401 clock_skew` with `{"serverTime": <ms>}`.
6. The nonce was not seen in the last 10 min → else `401 replayed`.
7. The instance's state is `enrolled` → else `403 revoked`.
8. The instance's budget (60 requests per minute) allows it → else `429 rate_limited` with `retryAfterS`.
9. The route's own checks (JSON body, schema) → `400 invalid` with `field`, `404 not_found`, `409 …`.

A pending key that passes 1–7 becomes the instance's active key (any other active key is revoked, reason `re-enrolled`; audit `cams-key-confirmed`).

### Signed answers (every answer of a request that got past step 1)

`X-Cams-Admin-Sig` = base64 Ed25519 (cams-admin's signing key) over `"cams-admin/v1 response\n" + status + "\n" + requestNonce + "\n" + sha256hex(body)`. A `304` has an empty body. cams refuses an answer without a valid signature from one of its pinned `serverKeys` (`admin_answer_unsigned`), whatever its status; a `401 clock_skew` is the one unauthenticated-looking answer cams acts on, and only because it is signed too.

**Clock skew** (the Pi has no RTC): on a signed `401 clock_skew`, cams sets `offset = serverTime − localNow` (only when `|offset| ≤ 7 days`) and retries the request **once** with a fresh nonce. The offset is kept in memory and used for every later request until the next `clock_skew`.

### `GET /cams/v1/config` → the snapshot

`If-None-Match: "<revision>"` → `304` (signed, empty) when unchanged; else `200` with `ETag: "<revision>"` and the snapshot:

```json
{ "v": 1, "type": "cams-config",
  "instance": { "id": "cms_…", "name": "cluster", "rotateBefore": null },
  "revision": "r:0123456789abcdef", "generatedAt": 1791273600000,
  "accounts": [ {
    "id": "acc_…", "name": "home", "displayName": "Home", "revision": 17,
    "users": [ { "email": "user@example.org", "role": "admin", "disabled": false } ],
    "proxies": [ { "id": "prx_…", "name": "pi", "displayName": "Pi", "url": "http://127.0.0.1:8480",
                   "adminUiUrl": "http://192.0.2.20:8480", "tlsServername": null, "caFingerprints": [],
                   "tokens": [ { "id": "tok_…", "kind": "client", "state": "active", "retireAt": null } ] } ],
    "cameras": [ { "id": "cam_…", "camsId": "cam1", "name": "Backyard", "proxyId": "prx_…",
                   "proxyCameraId": "cam1", "host": "from-proxy", "protocol": "https",
                   "tlsServername": "cam1.example.net", "cameraUser": "cams",
                   "webUiUrl": null, "webUiNote": null } ] } ],
  "sig": "<b64>" }
```

- `sig` = Ed25519 (cams-admin's key) over `jcs(snapshot without sig)`, so the cached copy verifies at every start without a nonce.
- `revision` = `"r:" + first 16 hex of sha256hex(jcs({ i: <instance id>, iv: <instance version>, a: [[accountId, accountRevision], …] sorted by id, k: <signing key fingerprint> }))`. It changes when any served account's `config_revision` changes, when the instance's own row changes (served accounts, `rotateBefore`, routes), and when cams-admin's key changes. It is **not** ordered; cams compares it for equality only.
- `accounts`: exactly the accounts in `cams_instance_accounts` for this instance, sorted by `name`. ≤ 64 accounts; per account ≤ 500 users, ≤ 64 proxies, ≤ 256 cameras.
- `users`: every user row of the account (`email` lower case, `role` `admin` | `viewer`, `disabled`).
- `proxies`: the account's proxies **except** those with a hidden route for this instance (§9.6 + ruling R4-3); `url` = this instance's route URL if one exists, else the proxy's registered `url` (may be `null`); `caFingerprints` as registered (`SHA256:` + 64 upper-case hex, no colons, as P1's `normaliseFingerprint` stores them; cams normalises with its own `normalizeFingerprint`); `tokens` = the `proxy_tokens` rows **held by this instance** (`holder` = the instance id) in states `pending`, `active`, `retiring` (and `revoked` ones for 7 days after `revoked_at`, so cams can drop its copy) — ids, kinds, states and `retireAt` only.
- `cameras`: the account's cameras whose `proxyId` is null or a listed proxy; all P1 camera fields as registered (nulls kept).
- **No secrets, ever:** no password, token, hash, enrollment code or private key. A guard test fills every text column with a marker and checks the snapshot never contains a marker from `proxy_tokens.hash`, `enrollment_codes`, `cams_enrollment_codes` or a key.

### `POST /cams/v1/tokens`

Request `{ "v": 1, "proxyId": "prx_…", "kind": "client" | "admin", "hash": "sha256:<64 lower hex>" }`.

- The proxy must belong to an account the instance serves and not be hidden for it → else `404 not_found`.
- Idempotent by hash: the same hash already held by this instance for this proxy and kind → `200` with that row.
- The hash held by anything else → `409 hash_in_use` (no detail).
- Another `pending` token of this instance for the same proxy and kind → `409 pending_exists` with `{"tokenId": "tok_…"}`.
- 64 live tokens on the proxy → `409 too_many_tokens`; the P2 pre-checks (`409 unsupported_by_proxy`, `paused_on_proxy`, `not_allowed_on_proxy`, `proxy_ahead`) pass through unchanged.
- Else `201 { "tokenId": "tok_…", "state": "pending", "label": "cams <instance name>" }` (a `kind: admin` label is `"cams <instance name> admin"`), and a `tokens.apply` is queued with actor = the instance id.

### `POST /cams/v1/tokens/:tokenId/retire`

Request `{ "v": 1, "hours": 24 }` (`hours` optional, integer 1–168, default 24). Only a token held by this instance (else `404 not_found`) in state `active` (else `409 not_active`). Answer `200 { "tokenId": "tok_…", "state": "retiring", "retireAt": <ms> }`.

### `POST /cams/v1/report`

Request (≤ 64 KiB):

```json
{ "v": 1, "mode": "cams-admin", "version": "2026.10.07.1",
  "appliedRevision": "r:0123456789abcdef", "cacheVerifiedAt": 1791273600000, "lastPullAt": 1791273600000,
  "held":    [ { "accountId": "acc_…", "camsId": "cam1", "fields": ["host"] } ],
  "keptOld": [ { "accountId": "acc_…", "camsId": "cam1", "fields": ["host"] } ],
  "shadow":  { "accountId": "acc_…", "differences": 0, "items": [] },
  "tokens":  { "managed": 2, "pending": 0, "legacy": 0 },
  "problems": [ { "code": "snapshot_invalid", "accountId": "acc_…", "detail": "camera 3: protocol" } ] }
```

`mode` `file` | `shadow` | `cams-admin`; `appliedRevision`, `cacheVerifiedAt`, `lastPullAt` may be null; `held`/`keptOld` ≤ 200 entries, `fields` ⊆ the trust fields `proxyUrl`, `caFingerprints`, `proxyTlsServername`, `host`, `protocol`, `tlsServername`; `shadow` null outside shadow mode, `items` ≤ 20 strings of ≤ 200 characters naming a camsId and a field, never a value; `problems` ≤ 50, `code` ≤ 64, `detail` ≤ 200. Answer `200 { "changed": <revision ≠ appliedRevision>, "revision": "r:…" }`. cams sends one at start, then at most one per 60 s, and at once after a held change is confirmed or kept.

### Fixtures and vectors

`contract/cams-v1/fixtures/`: `valid-snapshot-two-accounts`, `valid-snapshot-empty`, `valid-tokens-request`, `valid-report-shadow`, `valid-report-cams-admin`, `valid-enroll-request`, `valid-enroll-response`, `invalid-snapshot-secret-field` (a camera with `password`), `invalid-snapshot-bad-camsid`, `invalid-snapshot-unsigned`, `invalid-tokens-request-upper-hex`, `invalid-report-value-in-items` (strict refuses an item over 200 characters), `drift-snapshot-new-field` (lenient accepts, strict refuses). `vectors.json`: `keys` (`server` = the v1 vectors' server seed, `cams` = a new fixed seed, `other`), `enroll` (`{code, publicKey, text, sig}`), `requests` (`{method, pathAndQuery, ts, nonce, body, bodySha256, text, sig}`: one GET config, one POST tokens, one POST report), `responses` (`{status, nonce, body, bodySha256, text, sig}`: a 200 snapshot, a 304, a 401 clock_skew), `snapshots` (`{snapshot, text, sig}`). Both repos reproduce every signature byte for byte.

---

## File map

| file | responsibility |
|---|---|
| `contract/cams-build.ts` (new), `contract/make.ts`, `contract/cams-v1/**` (generated), `contract/README.md` | the cams-v1 contract |
| `server/crypto/ed25519.ts` | + `signedText.camsEnroll`, `camsRequestText`, `camsResponseText`, `sha256hex` |
| `server/contract.ts` | + `validateCams(name, value)` (lenient, run time) |
| `server/db/migrations.ts` | the P4 migration (next number, R4-18) |
| `server/ids.ts` | `cms` prefix; `newCamsEnrollmentCode`, `normaliseCamsCode` (tag `CAC1`) |
| `server/audit.ts` | actor type `cams`; the P4 audit actions |
| `server/cams/instances.ts` (new) | `CamsInstances`: instances, served accounts, routes, codes, keys, block/delete, rotate, in-memory status |
| `server/cams/enroll.ts` (new) | `redeemCamsCode` (`POST /cams/v1/enroll`) |
| `server/cams/auth.ts` (new) | `CamsAuth`: the request check (steps 1–8), nonce cache, budgets; `signAnswer` |
| `server/cams/snapshot.ts` (new) | `buildSnapshot(instanceId)`, `snapshotRevision` |
| `server/cams/routes.ts` (new) | the `/cams/v1` router |
| `server/tokens/service.ts` | + `registerForInstance`, `retireForInstance`, `revokeHeldBy`, holder-aware views |
| `server/import/export-format.ts`, `server/import/importer.ts`, `server/import/export.ts` (new) | the importer (§11.2) and the Export (§11.6) |
| `server/api/router.ts` | sysadmin routes for instances, import, export; dashboard rows |
| `server/server.ts` | wiring, tick (nonce sweep) |
| `test-client/cams.ts` (new) | an independent reference cams client (signing, verification) for tests and the local stack |
| `web/src/pages/CamsInstances.svelte`, `web/src/pages/CamsInstance.svelte`, `web/src/components/ImportPanel.svelte`, `web/src/pages/Account.svelte`, `web/src/pages/Dashboard.svelte`, `web/src/lib/router.ts`, `web/src/App.svelte` | UI |
| `scripts/import.ts` (new) | `npm run import` (API client) |
| `scripts/rehearse/localize.ts` (new) | rewrites real exports for the local stack (§11.3) |
| `scripts/localstack/start.sh`, `scripts/localstack/setup.ts`, `scripts/localstack/plan.json` (if separate), `e2e/cams-multi.spec.ts` (new), `docs/localstack.md` | two cams instances, the §14.3 suite |
| `docs/kube-setup-request-p4.md` (new), `docs/migration-p4-runbook.md` (this PR), `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/restore.md` | docs |

---

### Task 1: The cams-v1 contract

**Files:**
- Create: `contract/cams-build.ts`, `contract/cams-v1/**` (generated), `test/contract-cams.test.ts`
- Modify: `contract/make.ts` (also writes `cams-v1/`), `contract/README.md`, `server/crypto/ed25519.ts`, `server/contract.ts`, `scripts/contract/make-vectors.ts` (or a sibling `make-cams-vectors.ts` called by `make.ts`)

**Interfaces:**
- Produces:
  - `sha256hex(b: Buffer | string): string`
  - `signedText.camsEnroll(code: string, publicKey: string): string` = `` `cams-admin cams-enroll v1\n${code}\n${publicKey}` ``
  - `camsRequestText(method: string, pathAndQuery: string, ts: number, nonce: string, body: Buffer): string`
  - `camsResponseText(status: number, nonce: string, body: Buffer): string`
  - `CAMS_SCHEMAS = ['enroll-request', 'enroll-response', 'snapshot', 'tokens-request', 'tokens-response', 'retire-request', 'retire-response', 'report-request', 'report-response', 'error'] as const`
  - `validateCams(name: (typeof CAMS_SCHEMAS)[number], value: unknown): { ok: true } | { ok: false; detail: string }` (lenient)
  - `TRUST_FIELDS = ['proxyUrl', 'caFingerprints', 'proxyTlsServername', 'host', 'protocol', 'tlsServername'] as const` (exported from `contract/cams-build.ts`)
  - `contract/cams-v1/vectors.json` shaped as in the contract section.

- [ ] **Step 1: Failing tests** (`test/contract-cams.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { camsRequestText, camsResponseText, keyFromSeed, privateFromB64, publicFromB64, sha256hex, sign, signedText, signEnvelope, verify, verifyEnvelope } from '../server/crypto/ed25519';
import { jcs } from '../server/crypto/jcs';
import { validateCams } from '../server/contract';
import vectors from '../contract/cams-v1/vectors.json';
import { strictCamsValidator } from './helpers/contract'; // ajv over contract/cams-v1/strict

const DIR = join(__dirname, '../contract/cams-v1/fixtures');
const fixtures = readdirSync(DIR).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
const priv = (k: 'server' | 'cams' | 'other') => privateFromB64(keyFromSeed(vectors.keys[k].seedHex).privateKeyPkcs8B64);

describe('cams-v1 contract', () => {
  it('valid-* pass lenient and strict; invalid-* fail strict; drift-* pass lenient only', () => {
    for (const f of fixtures) {
      const strict = strictCamsValidator(f.schema)(f.message);
      const lenient = validateCams(f.schema, f.message).ok;
      if (f.name.startsWith('valid-')) expect([f.name, strict, lenient]).toEqual([f.name, true, true]);
      if (f.name.startsWith('invalid-')) expect([f.name, strict]).toEqual([f.name, false]);
      if (f.name.startsWith('drift-')) expect([f.name, strict, lenient]).toEqual([f.name, false, true]);
    }
  });
  it('request and response texts and signatures reproduce byte for byte', () => {
    for (const r of vectors.requests) {
      const body = Buffer.from(r.body, 'utf8');
      expect(sha256hex(body)).toBe(r.bodySha256);
      expect(camsRequestText(r.method, r.pathAndQuery, r.ts, r.nonce, body)).toBe(r.text);
      expect(sign(priv('cams'), r.text)).toBe(r.sig);
      expect(verify(publicFromB64(vectors.keys.other.publicKey), r.text, r.sig)).toBe(false);
    }
    for (const a of vectors.responses) {
      expect(camsResponseText(a.status, a.nonce, Buffer.from(a.body, 'utf8'))).toBe(a.text);
      expect(sign(priv('server'), a.text)).toBe(a.sig);
    }
    expect(vectors.responses.find((a) => a.status === 304)!.bodySha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('the snapshot signature is over jcs(snapshot without sig) and the enroll proof uses its own text', () => {
    for (const s of vectors.snapshots) {
      expect(jcs(s.snapshot)).toBe(s.text);
      expect(signEnvelope(priv('server'), s.snapshot)).toBe(s.sig);
      expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), { ...s.snapshot, sig: s.sig })).toBe(true);
    }
    const e = vectors.enroll[0];
    expect(signedText.camsEnroll(e.code, e.publicKey)).toBe(e.text);
    expect(e.text.startsWith('cams-admin cams-enroll v1\n')).toBe(true);
    expect(e.code.startsWith('CAC1-')).toBe(true);
  });
  it('no fixture or vector holds anything that looks like a token, a hash of one, or a password field', () => {
    // Only the token-hash requests may carry a hash, and only the "secret field" fixture a password.
    const rest = fixtures.filter((f) => !/tokens-request|invalid-snapshot-secret-field/.test(f.name));
    const all = JSON.stringify({ fixtures: rest, vectors: { ...vectors, requests: vectors.requests.filter((r) => !r.pathAndQuery.startsWith('/cams/v1/tokens')) } });
    expect(all).not.toMatch(/"password"|"token"\s*:|sha256:[0-9a-f]{64}/);
  });
});
```

(`test/helpers/contract.ts` gains `strictCamsValidator(name)` compiling `contract/cams-v1/strict/<name>.schema.json` with ajv 2020, `strict: false`.)

- [ ] **Step 2: Run** `npx vitest run test/contract-cams.test.ts` → FAIL (files missing).

- [ ] **Step 3: Implement.**
  - `server/crypto/ed25519.ts`:

```ts
export const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
// signedText gains:
//   camsEnroll: (code: string, publicKey: string) => `cams-admin cams-enroll v1\n${code}\n${publicKey}`,
export const camsRequestText = (method: string, pathAndQuery: string, ts: number, nonce: string, body: Buffer): string =>
  `cams-admin/v1 request\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${nonce}\n${sha256hex(body)}`;
export const camsResponseText = (status: number, nonce: string, body: Buffer): string =>
  `cams-admin/v1 response\n${status}\n${nonce}\n${sha256hex(body)}`;
```

  - `contract/cams-build.ts` builds the schemas with the same helpers as `contract/build.ts` (`obj`, `str`, `int`, `id`, `arr`, `en`, `nullable`; lenient = open objects and plain strings, strict = closed objects, enums, every listed field required). The snapshot schema in full:

```ts
const fp: S = { type: 'string', pattern: '^SHA256:[0-9A-F]{64}$' };
const user = obj({ email: { type: 'string', maxLength: 254 }, role: en(['admin', 'viewer']), disabled: bool }, ['email', 'role', 'disabled']);
const tokenRef = obj({ id: id('tok'), kind: en(['client', 'admin']), state: en(['pending', 'active', 'retiring', 'revoked']), retireAt: nullable(int()) }, ['id', 'kind', 'state', 'retireAt']);
const proxy = obj({ id: id('prx'), name: str(32), displayName: str(), url: nullable(str(512)), adminUiUrl: nullable(str(512)), tlsServername: nullable(str(253)), caFingerprints: arr(fp, 2), tokens: arr(tokenRef, 64) },
  ['id', 'name', 'displayName', 'url', 'adminUiUrl', 'tlsServername', 'caFingerprints', 'tokens']);
const camera = obj({ id: id('cam'), camsId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' }, name: str(), proxyId: nullable(id('prx')), proxyCameraId: nullable(str(32)), host: nullable(str(255)),
  protocol: nullable(en(['https', 'http'])), tlsServername: nullable(str(253)), cameraUser: nullable(str(64)), webUiUrl: nullable(str(512)), webUiNote: nullable(str(120)) },
  ['id', 'camsId', 'name', 'proxyId', 'proxyCameraId', 'host', 'protocol', 'tlsServername', 'cameraUser', 'webUiUrl', 'webUiNote']);
const account = obj({ id: id('acc'), name: str(32), displayName: str(), revision: int(0), users: arr(user, 500), proxies: arr(proxy, 64), cameras: arr(camera, 256) }, ['id', 'name', 'displayName', 'revision', 'users', 'proxies', 'cameras']);
const snapshot = obj({ v: { const: 1 }, type: { const: 'cams-config' }, instance: obj({ id: id('cms'), name: str(32), rotateBefore: nullable(int()) }, ['id', 'name', 'rotateBefore']),
  revision: { type: 'string', pattern: '^r:[0-9a-f]{16}$' }, generatedAt: int(), accounts: arr(account, 64), sig: { type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$' } },
  ['v', 'type', 'instance', 'revision', 'generatedAt', 'accounts', 'sig']);
```

  and `tokens-request`, `retire-request`, `report-request` (with `TRUST_FIELDS` as the `fields` enum in strict, `items` strings `maxLength: 200`), their responses, `enroll-request`/`enroll-response` and `error` (`{error: str(64), field?, retryAfterS?, serverTime?, tokenId?}`) as the contract section says. Fixtures as listed there; the vectors with fixed nonces/ts (`ts: 1791273600000`, nonce `AAAAAAAAAAAAAAAAAAAAAA`), the `cams` key from seed `'c4'.repeat(32)`.
  - `make.ts` writes `contract/cams-v1/{,strict/}<name>.schema.json`, `fixtures/`, `vectors.json` and `README.md` (the contract section of this plan, verbatim, so the vendored copy carries the rules).
  - `server/contract.ts`: compile the lenient `cams-v1` schemas; `validateCams` returns `ajv.errorsText` clamped to 200 characters.

- [ ] **Step 4: Run** `npm run contract:make && npx vitest run test/contract-cams.test.ts test/contract.test.ts` → PASS; `git status contract/` shows only `cams-v1/` added (v1 unchanged).
- [ ] **Step 5: Commit**

```bash
git add contract/cams-build.ts contract/make.ts contract/README.md contract/cams-v1 server/crypto/ed25519.ts server/contract.ts test/contract-cams.test.ts test/helpers/contract.ts
git commit -m "feat(contract): cams-v1, the cams service API (schemas, fixtures, signing vectors)"
```

---

### Task 2: Migration, ids and audit (instances, routes, revisions, actor `cams`)

**Files:**
- Modify: `server/db/migrations.ts`, `server/ids.ts`, `server/audit.ts`, `test/db.test.ts`, `test/ids.test.ts`, `test/audit.test.ts`, `test/backup.test.ts` (if it lists tables)

**Interfaces:**
- Produces: tables `cams_instances`, `cams_instance_keys`, `cams_enrollment_codes`, `cams_instance_accounts`, `cams_instance_routes`, `config_revision` (+ triggers); `audit_log.actor_type` accepts `cams`; `IdPrefix` gains `'cms'`; `newCamsEnrollmentCode(): string`, `normaliseCamsCode(input: unknown): string | null`; `AuditEntry.actorType: 'sysadmin' | 'proxy' | 'system' | 'cams'`; actions `cams-instance-create`, `cams-instance-update`, `cams-instance-delete`, `cams-instance-block`, `cams-enrollment-code-create`, `cams-enrollment-code-cancel`, `cams-enrolled`, `cams-enroll-refused`, `cams-key-confirmed`, `cams-key-revoke`, `cams-auth-refused`, `route-update`, `cams-rotate`, `import-run`, `import-apply`, `export-run`.

- [ ] **Step 1: Failing tests** (`test/db.test.ts`):

```ts
it('P4 migration: tables, one active and one pending key per instance, routes need a url unless hidden', () => {
  const r = makeRegistry(dir);
  const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const px = r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host', url: 'https://proxy.example.net:8480' });
  r.db.prepare(`INSERT INTO cams_instances (id, name, display_name, state, created_at, updated_at) VALUES ('cms_A', 'cluster', 'Cluster', 'pending', 1, 1)`).run();
  expect(() => r.db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES ('cms_A', ?, NULL, 0)`).run(px.id)).toThrow(/CHECK/);
  r.db.prepare(`INSERT INTO cams_instance_routes (instance_id, proxy_id, url, hidden) VALUES ('cms_A', ?, NULL, 1)`).run(px.id);
  r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_1', 'cms_A', 'pk1', 'fp', 1, 1)`).run();
  expect(() => r.db.prepare(`INSERT INTO cams_instance_keys (id, instance_id, public_key, fingerprint, created_at, confirmed_at) VALUES ('key_2', 'cms_A', 'pk2', 'fp', 1, 2)`).run()).toThrow(/UNIQUE/);
});
it('config_revision: one row per account, bumped by every write cams can see, in the same transaction', () => {
  const r = makeRegistry(dir);
  const acc = r.reg.createAccount(ACTOR, { name: 'home', displayName: 'Home' });
  const rev = () => (r.db.prepare('SELECT revision FROM config_revision WHERE account_id = ?').get(acc.id) as { revision: number }).revision;
  const steps: [string, () => void][] = [
    ['user', () => r.reg.createUser(ACTOR, acc.id, { email: 'a@example.org', role: 'viewer' })],
    ['proxy', () => r.reg.createProxy(ACTOR, acc.id, { name: 'pi', displayName: 'Pi', runsOn: 'local-host' })],
    ['camera', () => r.reg.createCamera(ACTOR, acc.id, { camsId: 'cam1', name: 'Yard', kind: 'camera' })],
    ['account', () => r.reg.updateAccount(ACTOR, acc.id, { displayName: 'Home 2', version: 1 })],
  ];
  for (const [what, fn] of steps) {
    const before = rev();
    const epoch = readEpoch(r.db);
    fn();
    expect(rev(), what).toBe(before + 1);
    expect(readEpoch(r.db) - epoch, what).toBe(1); // no extra write transaction
  }
});
it('audit_log accepts actor type cams and keeps every old row (table rebuilt)', () => {
  const r = makeRegistry(dir);
  r.audit.write({ actorType: 'cams', actor: 'cms_0123456789ABCDEFGHJK', action: 'cams-auth-refused', outcome: 'refused', detail: { reason: 'bad_signature' } });
  expect(r.db.prepare(`SELECT count(*) n FROM audit_log WHERE actor_type = 'cams'`).get()).toEqual({ n: 1 });
});
it('a database at the previous version migrates with its audit rows intact', () => { /* open a fixture db made by migrations[0..N-1], insert 3 audit rows, run the P4 migration, rows equal */ });
```

`test/ids.test.ts`: `normaliseCamsCode(' cac1-abcd-efgh-jkmn-pqrs-tvwx ')` → `'CAC1-ABCD-EFGH-JKMN-PQRS-TVWX'`; `normaliseCamsCode(newEnrollmentCode())` → `null` (a proxy code is refused); `normaliseCode(newCamsEnrollmentCode())` → `null`; `newId('cms')` matches `^cms_[0-9A-HJKMNP-TV-Z]{20}$`.

- [ ] **Step 2: Run** `npx vitest run test/db.test.ts test/ids.test.ts test/audit.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Append the next migration (R4-18; today it would be index 5):

```ts
  // P4 (migration spec §5, plan R4-1…R4-4): cams instances, their keys,
  // codes, served accounts and routes; one config_revision per account,
  // bumped by triggers; audit actor type 'cams' (table rebuilt for its CHECK).
  (db) => db.exec(`
CREATE TABLE cams_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
  display_name TEXT NOT NULL,
  base_url TEXT, notes TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','enrolled','revoked')),
  rotate_before INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE cams_instance_keys (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL, enrollment_id TEXT, confirmed_at INTEGER, last_seen_at INTEGER,
  revoked_at INTEGER, revoked_reason TEXT CHECK (revoked_reason IN ('admin','re-enrolled','instance-deleted','blocked'))
) STRICT;
CREATE UNIQUE INDEX cams_keys_one_active ON cams_instance_keys(instance_id) WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL;
CREATE UNIQUE INDEX cams_keys_one_pending ON cams_instance_keys(instance_id) WHERE revoked_at IS NULL AND confirmed_at IS NULL;
CREATE TABLE cams_enrollment_codes (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, cancelled_at INTEGER
) STRICT;
CREATE UNIQUE INDEX cams_codes_one_live ON cams_enrollment_codes(instance_id) WHERE used_at IS NULL AND cancelled_at IS NULL;
CREATE TABLE cams_instance_accounts (
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (instance_id, account_id)
) STRICT;
CREATE TABLE cams_instance_routes (
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  url TEXT, hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  PRIMARY KEY (instance_id, proxy_id),
  CHECK (hidden = 1 OR url IS NOT NULL)
) STRICT;
CREATE TABLE config_revision (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT INTO config_revision (account_id) SELECT id FROM accounts;
CREATE TRIGGER rev_account_ins AFTER INSERT ON accounts BEGIN INSERT INTO config_revision (account_id) VALUES (NEW.id); END;
CREATE TRIGGER rev_account_upd AFTER UPDATE ON accounts BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = NEW.id; END;
${['account_users', 'proxies', 'cameras', 'proxy_tokens'].map((t) => `
CREATE TRIGGER rev_${t}_ins AFTER INSERT ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = NEW.account_id; END;
CREATE TRIGGER rev_${t}_upd AFTER UPDATE ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id IN (NEW.account_id, OLD.account_id); END;
CREATE TRIGGER rev_${t}_del AFTER DELETE ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = OLD.account_id; END;`).join('')}
${['INSERT', 'UPDATE', 'DELETE'].map((op) => `
CREATE TRIGGER rev_routes_${op.toLowerCase()} AFTER ${op} ON cams_instance_routes BEGIN
  UPDATE config_revision SET revision = revision + 1 WHERE account_id IN (SELECT account_id FROM proxies WHERE id IN (${op === 'DELETE' ? 'OLD.proxy_id' : op === 'INSERT' ? 'NEW.proxy_id' : 'NEW.proxy_id, OLD.proxy_id'}));
END;`).join('')}

CREATE TABLE audit_log_p4 (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('sysadmin','proxy','system','cams')),
  actor TEXT NOT NULL, action TEXT NOT NULL, account_id TEXT,
  target_type TEXT, target_id TEXT, target_label TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')), detail TEXT
) STRICT;
INSERT INTO audit_log_p4 SELECT id, at, actor_type, actor, action, account_id, target_type, target_id, target_label, outcome, detail FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_p4 RENAME TO audit_log;
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_account_at ON audit_log(account_id, at);
CREATE INDEX audit_action_at ON audit_log(action, at);
`),
```

  (The account trigger on `UPDATE accounts` and the per-table triggers fire inside the writer's transaction; `meta.write_epoch` counts transactions, so the budget is unchanged. If P3 has added columns or indexes to `audit_log` by the time this lands, copy them into `audit_log_p4` — check `PRAGMA table_info(audit_log)` and `PRAGMA index_list(audit_log)` against the statement before committing.)

  `server/ids.ts`: `IdPrefix` + `'cms'`; `const CAMS_CODE_TAG = 'CAC1'`; `newCamsEnrollmentCode` and `normaliseCamsCode` as the existing pair with the tag as a parameter (refactor `normaliseCode(input, tag = CODE_TAG)` and keep the old export's behaviour). `server/audit.ts`: the actions above in `AUDIT_ACTIONS`; `actorType` union + `'cams'`.

- [ ] **Step 4: Run** `npx vitest run test/db.test.ts test/ids.test.ts test/audit.test.ts test/backup.test.ts test/write-budget.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/db/migrations.ts server/ids.ts server/audit.ts test/db.test.ts test/ids.test.ts test/audit.test.ts
git commit -m "feat(db): cams instances, routes and per-account config revisions (triggers); audit actor cams"
```

---

### Task 3: `CamsInstances` (registry of cams instances) and the sysadmin API

**Files:**
- Create: `server/cams/instances.ts`, `test/cams-instances.test.ts`
- Modify: `server/api/router.ts`, `server/server.ts`, `test/api-audit-completeness.test.ts`

**Interfaces:**
- Consumes: Task 2; `Registry.getAccount/getProxy/proxyById`, `Audit`, `tx`, `Tokens` (for R4-19, Task 7 adds `revokeHeldBy`; until then `onRevoke` is a no-op hook).
- Produces:

```ts
export interface CamsInstance { id: string; name: string; displayName: string; baseUrl: string | null; notes: string | null; state: 'pending' | 'enrolled' | 'revoked'; rotateBefore: number | null; accounts: string[]; createdAt: number; updatedAt: number; version: number }
export interface CamsRoute { instanceId: string; proxyId: string; accountId: string; url: string | null; hidden: boolean }
export interface CamsKey { id: string; instanceId: string; fingerprint: string; createdAt: number; confirmedAt: number | null; lastSeenAt: number | null; revokedAt: number | null; revokedReason: string | null }
export interface CamsLive { lastSeenAt: number | null; lastPullAt: number | null; lastPullStatus: 200 | 304 | null; report: CamsReport | null; reportAt: number | null; shadowZeroSince: number | null }
export class CamsInstances {
  constructor(d: { db: Db; clock: Clock; audit: Audit; registry: Registry; cfg: Config; serverKeys: string[]; serverKeyFingerprints: string[]; onRevoke: (instanceId: string, actor: string) => void });
  create(actor: string, input: unknown): CamsInstance;               // {name, displayName, baseUrl?, notes?, accounts: string[]}
  get(id: string): CamsInstance;                                      // 404
  list(): (CamsInstance & { live: CamsLive; activeKey: CamsKey | null })[];
  update(actor: string, id: string, patch: unknown): CamsInstance;     // version check (409); accounts replaced as a whole
  remove(actor: string, id: string, confirmName: unknown): void;       // revokes tokens (onRevoke) and keys, then deletes
  block(actor: string, id: string): CamsInstance;                      // state revoked, keys revoked, tokens revoked
  rotateNow(actor: string, id: string): CamsInstance;                 // rotate_before = now
  routes(id: string): CamsRoute[];
  setRoute(actor: string, id: string, proxyId: string, input: unknown): CamsRoute;   // {url: string|null, hidden: boolean}; proxy must be in a served account
  deleteRoute(actor: string, id: string, proxyId: string): void;
  createCode(actor: string, id: string, lifetimeH: unknown): { id: string; code: string; expiresAt: number; command: { cluster: string; pi: string }; serverKeyFingerprints: string[] };
  cancelCode(actor: string, id: string, codeId: string): void;
  keys(id: string): CamsKey[];
  revokeKey(actor: string, id: string, keyId: string): CamsKey;
  servedAccountIds(id: string): string[];
  live(id: string): CamsLive;                                         // memory
  touch(id: string, patch: Partial<CamsLive>): void;                  // memory only, never the database
}
```

  `Built` (server/server.ts) gains `camsInstances: CamsInstances` and `signing: SigningKey` (tests read the public key from it).

  API (sysadmin session, CSRF, write limit as every P1 route): `GET/POST /api/v1/cams-instances`, `GET/PATCH/DELETE /api/v1/cams-instances/:instanceId`, `POST …/block`, `POST …/rotate`, `GET …/routes`, `PUT/DELETE …/routes/:proxyId`, `POST …/enrollment-codes`, `DELETE …/enrollment-codes/:codeId`, `GET …/keys`, `POST …/keys/:keyId/revoke`. Every write = one transaction + one audit record (the existing rule; `test/api-audit-completeness.test.ts` lists the new write routes).

- [ ] **Step 1: Failing tests** (`test/cams-instances.test.ts`, with `makeRegistry`):

```ts
it('create: name rules, served accounts must exist, one audit record', () => {
  const i = inst.create(ACTOR, { name: 'cluster', displayName: 'Cluster', accounts: [home.id] });
  expect(i).toMatchObject({ state: 'pending', accounts: [home.id] });
  expect(() => inst.create(ACTOR, { name: 'Bad Name', displayName: 'x', accounts: [] })).toThrow(expect.objectContaining({ status: 400, field: 'name' }));
  expect(() => inst.create(ACTOR, { name: 'x', displayName: 'x', accounts: ['acc_NOPE'] })).toThrow(expect.objectContaining({ status: 400, field: 'accounts' }));
  expect(auditActions()).toContain('cams-instance-create');
});
it('a route only for a proxy of a served account; url rules as proxy urls; hidden needs no url', () => {
  expect(() => inst.setRoute(ACTOR, i.id, otherAccountProxy.id, { url: 'http://127.0.0.1:8480', hidden: false })).toThrow(expect.objectContaining({ status: 404 }));
  expect(inst.setRoute(ACTOR, i.id, piProxy.id, { url: 'http://127.0.0.1:8480', hidden: false })).toMatchObject({ url: 'http://127.0.0.1:8480', hidden: false });
  expect(() => inst.setRoute(ACTOR, i.id, piProxy.id, { url: 'ftp://x', hidden: false })).toThrow(expect.objectContaining({ field: 'url' }));
  expect(inst.setRoute(ACTOR, i.id, clusterProxy.id, { url: null, hidden: true })).toMatchObject({ hidden: true });
});
it('removing an account from an instance keeps its routes but the snapshot ignores them (Task 6 checks the snapshot)', () => {});
it('codes: shown once (CAC1-…), hash stored, a new code cancels the live one, commands name the cluster and the Pi forms', () => {
  const c = inst.createCode(ACTOR, i.id, 24);
  expect(c.code).toMatch(/^CAC1-/);
  expect(JSON.stringify(r.db.prepare('SELECT * FROM cams_enrollment_codes').all())).not.toContain(c.code);
  expect(c.command.cluster).toBe('kubectl exec -i -n cams <cams pod> -- node dist/server/cli.js admin-enroll --url <CAMS_ADMIN_URL>');
  expect(c.command.pi).toBe('docker compose exec -T cams node dist/server/cli.js admin-enroll --url https://admin.example.org');
});
it('block and delete revoke the keys and call onRevoke once (R4-19)', () => {});
it('rotateNow sets rotateBefore and bumps the instance version', () => {});
it('touch() never writes the database', () => { const e = readEpoch(r.db); inst.touch(i.id, { lastPullAt: 1 }); expect(readEpoch(r.db)).toBe(e); });
```

(`<cams pod>` and `<CAMS_ADMIN_URL>` stay literal in the cluster command: the in-cluster URL is kube-setup's, documented in the runbook; the Pi form uses `PUBLIC_URL`.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `server/cams/instances.ts` following `Registry`'s patterns (`guard`, `tx`, `updateRow` with version, `mapConstraint` → `duplicate_name`). Input checks: `name` `^[a-z0-9][a-z0-9-]{0,31}$`; `displayName` 1–200; `baseUrl` via `checkUrl` or null; `accounts` an array of ≤ 64 distinct existing account ids; route `url` via `checkUrl(v, 'url')` (http(s), no credentials/query/hash) or null when `hidden`. `update` with `accounts` replaces the rows of `cams_instance_accounts` and bumps `cams_instances.version` (the ETag includes it). Audit details name ids and names only. The router uses the existing `h()` wrapper; `remove` takes `{confirmName}` like account deletion.
- [ ] **Step 4: Run** `npx vitest run test/cams-instances.test.ts test/api-audit-completeness.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/cams/instances.ts server/api/router.ts server/server.ts test/cams-instances.test.ts test/api-audit-completeness.test.ts
git commit -m "feat(cams): cams instances, served accounts, routes, codes and keys (sysadmin API)"
```

---

### Task 4: Enrollment of a cams instance (`POST /cams/v1/enroll`)

**Files:**
- Create: `server/cams/enroll.ts`, `test/cams-enroll.test.ts`
- Modify: `server/cams/routes.ts` (created here with the enroll route; Tasks 5–7 add the rest), `server/server.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `Buckets`, `validateCams('enroll-request', …)`, `connectUrlFor`-style origin check (`requestOrigin` from `server/enroll/route.ts`).
- Produces: `class CamsEnrollment { constructor(d: { db; clock; audit; instances: CamsInstances; cfg: Config; serverKeys: string[]; serverKeyFingerprints: string[] }); redeem(raw: unknown, requestOrigin: string | null): { status: number; body: Record<string, unknown> } }`; `camsRouter(d: CamsRouterDeps): express.Router` mounted at the app root before `cookieParser`.

- [ ] **Step 1: Failing tests** (`test/cams-enroll.test.ts`, real server via `startServer`, the reference client of Task 9 not needed yet — sign by hand with `generateKeyPair`):

```ts
it('redeems a CAC1 code once: 201 with instance, key, served account names, server keys and fingerprints; key pending', async () => {
  const { code } = await s.api('POST', `/cams-instances/${inst.id}/enrollment-codes`, { lifetimeH: 1 });
  const kp = generateKeyPair();
  const body = { v: 1, code, publicKey: kp.publicKeySpkiB64, proof: sign(privateFromB64(kp.privateKeyPkcs8B64), signedText.camsEnroll(normaliseCamsCode(code)!, kp.publicKeySpkiB64)), camsVersion: 'test' };
  const r = await fetch(`${s.url}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ v: 1, instanceId: inst.id, instanceName: 'cluster', accounts: ['home'], serverKeys: [s.built.signing.publicKeyB64], serverKeyFingerprints: [expect.stringMatching(/^SHA256:/)] });
  expect(s.built.camsInstances.keys(inst.id)[0]).toMatchObject({ confirmedAt: null });
  expect((await fetch(`${s.url}/cams/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(401); // used
});
it('a proxy code (CAE1) at /cams/v1/enroll and a cams code at /proxy/v1/enroll: 401 invalid_code', async () => {});
it('a proof made with the proxy enroll text is bad_proof', async () => {});
it('expired, cancelled, blocked instance: the same 401 invalid_code; audited cams-enroll-refused (throttled)', async () => {});
it('per-code and global limits answer 429 with retryAfterS, never keyed on the address', async () => {});
it('apiUrl: the request origin when allow-listed (INTERNAL_URLS), else PUBLIC_URL', async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `CamsEnrollment.redeem` as `Enrollment.redeem` (P1 `server/enroll/codes.ts`) with: `normaliseCamsCode`; the `cams_enrollment_codes` / `cams_instances` / `cams_instance_keys` tables; proof text `signedText.camsEnroll`; `key_in_use` also checked against `proxy_keys.public_key` (a proxy's key can never become a cams key); retire older pending keys; instance `state` `pending` → stays `pending` until the key confirms (Task 5 sets `enrolled`); answer as the contract. Audit `cams-enrolled` (actor type `cams`, actor = instance id). The router: `r.post('/cams/v1/enroll', express.json({ limit: 8 * 1024, type: () => true }), …)` with `Cache-Control: no-store` and `bodyErrors`.
- [ ] **Step 4: Run** `npx vitest run test/cams-enroll.test.ts test/enroll.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/cams/enroll.ts server/cams/routes.ts server/server.ts test/cams-enroll.test.ts
git commit -m "feat(cams): enroll a cams instance with a one-time CAC1 code"
```

---

### Task 5: Signed requests and signed answers (`CamsAuth`)

**Files:**
- Create: `server/cams/auth.ts`, `test/cams-auth.test.ts`
- Modify: `server/cams/routes.ts`, `server/server.ts` (tick: `camsAuth.sweep()`), `server/config.ts` (`limits.camsPerInstancePerMin = 60`, `limits.camsFailedSigPer10Min = 300`)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
export interface CamsRequest { instanceId: string; keyId: string; nonce: string; body: Buffer; json: unknown }
export class CamsAuth {
  constructor(d: { db: Db; clock: Clock; audit: Audit; instances: CamsInstances; signingKey: KeyObject; limits: Limits; log: Logger });
  middleware(): express.RequestHandler;     // steps 1–8; sets res.locals.cams: CamsRequest
  sweep(): void;                            // drops nonces older than 10 min
  nonces(): number;                         // for tests and /dev/metrics
}
export function sendSigned(res: express.Response, signingKey: KeyObject, nonce: string, status: number, body: unknown | null, headers?: Record<string, string>): void;
export const NONCE_TTL_MS = 600_000, SKEW_MS = 300_000;
```

- [ ] **Step 1: Failing tests** (`test/cams-auth.test.ts`; a tiny signer helper `signedFetch(s, key, inst, method, path, body?, o?: {ts?, nonce?, sigWith?})` in `test/helpers/cams.ts`; a test-only route `GET /cams/v1/ping` registered when `NODE_ENV=test` answering `{ok: true}`):

```ts
it('a correctly signed request passes; the answer carries X-Cams-Admin-Sig over status, nonce and body', async () => {
  const r = await signedFetch(s, key, inst, 'GET', '/cams/v1/ping');
  expect(r.status).toBe(200);
  const body = Buffer.from(await r.arrayBuffer());
  expect(verify(publicFromB64(s.built.signing.publicKeyB64), camsResponseText(200, r.nonce, body), r.headers.get('x-cams-admin-sig'))).toBe(true);
});
it('the first verified request confirms a pending key and sets the instance enrolled; an older active key is revoked re-enrolled', async () => {});
for (const [name, mutate, code, status] of [
  ['missing header', { drop: 'X-Cams-Nonce' }, 'bad_request', 400],
  ['unknown key', { keyId: 'key_ZZZZZZZZZZZZZZZZZZZZ' }, 'unknown_key', 401],
  ['key of another instance', { otherInstanceKey: true }, 'unknown_key', 401],
  ['signed by another key', { sigWith: 'other' }, 'bad_signature', 401],
  ['body changed after signing', { tamperBody: true }, 'bad_signature', 401],
  ['path changed after signing', { signPath: '/cams/v1/config' }, 'bad_signature', 401],
  ['ts 301 s old', { tsOffset: -301_000 }, 'clock_skew', 401],
  ['revoked instance', { blocked: true }, 'revoked', 403],
] as const) it(`refuses: ${name} → ${status} ${code} (signed)`, async () => {
  const r = await signedFetch(s, key, inst, 'POST', '/cams/v1/report', REPORT, mutate);
  expect([r.status, (await r.clone().json()).error]).toEqual([status, code]);
  if (status !== 400 || mutate.drop !== 'X-Cams-Nonce') expect(r.headers.get('x-cams-admin-sig')).toBeTruthy();
});
it('clock_skew carries serverTime, and the answer is signed', async () => {
  const r = await signedFetch(s, key, inst, 'GET', '/cams/v1/ping', undefined, { tsOffset: -3600_000 });
  const j = await r.json();
  expect(j).toEqual({ error: 'clock_skew', serverTime: expect.any(Number) });
});
it('a nonce reused within 10 min is replayed; after the sweep window it is refused by the ts check instead', async () => {});
it('300 failed signatures in 10 min (all instances) → 429 for everyone until the window ends; never keyed on the address', async () => {});
it('61 requests in a minute from one instance → 429 rate_limited with retryAfterS; another instance is unaffected', async () => {});
it('refusals are audited cams-auth-refused, throttled per instance and reason; no header value, nonce or signature in the detail', async () => {});
it('a body over 64 KiB → 400 bad_request without reading it all', async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Mount `express.raw({ type: () => true, limit: 64 * 1024 })` on `/cams/v1` (except enroll, mounted before), then `camsAuth.middleware()`:

```ts
middleware(): express.RequestHandler {
  return (req, res, next) => {
    const now = this.d.clock.now();
    const h = (n: string) => (typeof req.headers[n] === 'string' ? (req.headers[n] as string) : '');
    const instanceId = h('x-cams-instance'), keyId = h('x-cams-key'), tsRaw = h('x-cams-ts'), nonce = h('x-cams-nonce'), sig = h('x-cams-sig');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const okNonce = /^[A-Za-z0-9_-]{22}$/.test(nonce);
    const answer = (status: number, b: Record<string, unknown>) =>
      okNonce ? sendSigned(res, this.d.signingKey, nonce, status, b) : void res.status(status).set('Cache-Control', 'no-store').json(b);
    if (!/^cms_[0-9A-HJKMNP-TV-Z]{20}$/.test(instanceId) || !/^key_[0-9A-HJKMNP-TV-Z]{20}$/.test(keyId) || !/^\d{1,16}$/.test(tsRaw) || !okNonce || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return answer(400, { error: 'bad_request' });
    if (this.failed.full('global', now)) return answer(429, { error: 'rate_limited', retryAfterS: 60 });
    const key = this.keyRow(instanceId, keyId); // not revoked, belongs to the instance
    const fail = (reason: 'unknown_key' | 'bad_signature') => { this.failed.take('global', now); this.refused(instanceId, reason); answer(401, { error: reason }); };
    if (!key) return fail('unknown_key');
    if (!verify(publicFromB64(key.publicKey), camsRequestText(req.method, req.originalUrl, Number(tsRaw), nonce, body), sig)) return fail('bad_signature');
    if (Math.abs(Number(tsRaw) - now) > SKEW_MS) { this.refused(instanceId, 'clock_skew'); return answer(401, { error: 'clock_skew', serverTime: now }); }
    if (this.seen.has(nonce)) { this.refused(instanceId, 'replayed'); return answer(401, { error: 'replayed' }); }
    this.seen.set(nonce, now);
    const inst = this.d.instances.getRaw(instanceId);
    if (key.confirmedAt === null) this.d.instances.confirmKey(instanceId, keyId); // one transaction: confirm, revoke the older active key, state enrolled, audit cams-key-confirmed
    else if (inst.state === 'revoked') return answer(403, { error: 'revoked' });
    const t = this.perInstance.take(instanceId, now);
    if (!t.ok) return answer(429, { error: 'rate_limited', retryAfterS: t.retryAfterS });
    this.d.instances.touch(instanceId, { lastSeenAt: now });
    let json: unknown = null;
    if (body.length) { try { json = JSON.parse(body.toString('utf8')); } catch { return answer(400, { error: 'invalid', field: 'body' }); } }
    res.locals.cams = { instanceId, keyId, nonce, body, json } satisfies CamsRequest;
    next();
  };
}
```

  (`confirmKey` refuses a pending key of a revoked instance: `revoked` wins.) `sendSigned` serialises once, signs `camsResponseText(status, nonce, bytes)`, sets `Content-Type: application/json`, `Cache-Control: no-store`, `X-Cams-Admin-Sig`, and sends the same bytes (for 304: no body, no content type). The nonce map is bounded (a hard cap of 100 000 entries; above it the oldest go first and a warning is logged).
- [ ] **Step 4: Run** `npx vitest run test/cams-auth.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/cams/auth.ts server/cams/routes.ts server/server.ts server/config.ts test/cams-auth.test.ts test/helpers/cams.ts
git commit -m "feat(cams): signed requests (normative check order, nonces, skew, budgets) and signed answers"
```

---

### Task 6: The snapshot (`GET /cams/v1/config`)

**Files:**
- Create: `server/cams/snapshot.ts`, `test/cams-snapshot.test.ts`
- Modify: `server/cams/routes.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `Registry` reads; `proxy_tokens` (P2).
- Produces: `buildSnapshot(d: { db: Db; clock: Clock; signingKey: KeyObject; signingFingerprint: string }, instanceId: string): Snapshot` (signed); `snapshotRevision(db, instanceId, signingFingerprint): string`; the TypeScript types `Snapshot`, `SnapAccount`, `SnapProxy`, `SnapCamera` exactly as the contract's JSON.

- [ ] **Step 1: Failing tests** (`test/cams-snapshot.test.ts`):

```ts
// Fixture: accounts home (Klaus admin, v viewer), beta (Klaus viewer); home: proxies pi (url https://proxy.example.net:8480) and cluster,
// cameras cam1 (pi) and cam2 (cluster); beta: proxy b1 with camera cam1 (the same camsId in another account).
// Instances: cluster (home + beta), pi (home only, route pi → http://127.0.0.1:8480, cluster hidden).
it('an instance sees exactly its accounts, sorted by name; the pi instance sees only the pi proxy, at its route URL', () => {
  const c = buildSnapshot(d, cluster.id);
  expect(c.accounts.map((a) => a.name)).toEqual(['beta', 'home']);
  const p = buildSnapshot(d, pi.id);
  expect(p.accounts.map((a) => a.name)).toEqual(['home']);
  expect(p.accounts[0].proxies.map((x) => [x.name, x.url])).toEqual([['pi', 'http://127.0.0.1:8480']]);
  expect(p.accounts[0].cameras.map((x) => x.camsId)).toEqual(['cam1']);
});
it('the same camsId in two accounts stays in its own account', () => {
  const c = buildSnapshot(d, cluster.id);
  expect(c.accounts.find((a) => a.name === 'beta')!.cameras[0]).toMatchObject({ camsId: 'cam1', proxyId: b1.id });
  expect(c.accounts.find((a) => a.name === 'home')!.cameras.find((x) => x.camsId === 'cam1')).toMatchObject({ proxyId: piProxy.id });
});
it('tokens: only those held by this instance, never a hash; revoked ones only for 7 days', () => {});
it('the signature verifies over jcs(snapshot without sig); strict schema passes', () => {
  const c = buildSnapshot(d, cluster.id);
  expect(verifyEnvelope(publicFromB64(d.publicKeyB64), c as never)).toBe(true);
  expect(strictCamsValidator('snapshot')(c)).toBe(true);
});
it('revision changes on a user role change, a route change, a token state change, served accounts, rotate-now, and not on a heartbeat', () => {
  const r0 = snapshotRevision(d.db, cluster.id, FP);
  reg.updateUser(ACTOR, home.id, viewer.id, { role: 'admin', version: viewer.version });
  const r1 = snapshotRevision(d.db, cluster.id, FP);
  expect(r1).not.toBe(r0);
  status.heartbeat(piProxy.id, HB, clock.now());
  expect(snapshotRevision(d.db, cluster.id, FP)).toBe(r1);
});
it('the secret guard: markers in token hashes, codes and keys never appear in any instance\'s snapshot', () => {
  const MARK = 'f00dfeed';
  r.db.prepare(`UPDATE proxy_tokens SET hash = 'sha256:' || ? || substr(hash, 16)`).run(MARK);
  insertCode(cluster.id, `codehash${MARK}`);
  for (const i of [cluster, pi]) expect(JSON.stringify(buildSnapshot(d, i.id))).not.toContain(MARK);
});
it('GET /cams/v1/config: 200 with ETag; If-None-Match equal → 304 signed with an empty body; an unserved instance gets no account', async () => {
  const a = await camsClient.get('/cams/v1/config');
  expect(a.status).toBe(200);
  const etag = a.headers.get('etag');
  const b = await camsClient.get('/cams/v1/config', { 'If-None-Match': etag! });
  expect([b.status, (await b.arrayBuffer()).byteLength]).toEqual([304, 0]);
  expect(b.signatureOk).toBe(true);
});
it('a snapshot over 1 MiB is refused with 500 snapshot_too_large and logged (never truncated)', () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `server/cams/snapshot.ts`:

```ts
export function snapshotRevision(db: Db, instanceId: string, keyFp: string): string {
  const inst = db.prepare('SELECT version FROM cams_instances WHERE id = ?').get(instanceId) as { version: number };
  const a = (db.prepare(`SELECT c.account_id id, c.revision rev FROM config_revision c JOIN cams_instance_accounts s ON s.account_id = c.account_id
    WHERE s.instance_id = ? ORDER BY c.account_id`).all(instanceId) as { id: string; rev: number }[]).map((r) => [r.id, r.rev]);
  return 'r:' + sha256hex(jcs({ i: instanceId, iv: inst.version, a, k: keyFp })).slice(0, 16);
}
```

  `buildSnapshot` reads, per served account (sorted by name): users (`ORDER BY email`), proxies `LEFT JOIN cams_instance_routes r ON r.proxy_id = p.id AND r.instance_id = ?` filtered `WHERE r.hidden IS NOT 1` with `url = COALESCE(r.url, p.url)`, tokens `WHERE holder = ? AND (state IN ('pending','active','retiring') OR (state = 'revoked' AND revoked_at > now − 7 d))`, cameras whose `proxy_id IS NULL OR proxy_id IN (listed proxies)`, each mapped field by field (an explicit list, never `SELECT *` spread into the output, so a new column can't leak). `generatedAt = clock.now()`, `sig = signEnvelope(signingKey, snapshot)`. The route:

```ts
r.get('/cams/v1/config', (req, res) => {
  const c = res.locals.cams as CamsRequest;
  const rev = snapshotRevision(d.db, c.instanceId, d.signingFingerprint);
  d.instances.touch(c.instanceId, { lastPullAt: d.clock.now() });
  if (req.headers['if-none-match'] === `"${rev}"`) { d.instances.touch(c.instanceId, { lastPullStatus: 304 }); return sendSigned(res, d.signingKey, c.nonce, 304, null, { ETag: `"${rev}"` }); }
  const snap = buildSnapshot(d, c.instanceId);
  d.instances.touch(c.instanceId, { lastPullStatus: 200 });
  sendSigned(res, d.signingKey, c.nonce, 200, snap, { ETag: `"${rev}"` });
});
```

  (`buildSnapshot` recomputes `revision` with the same function inside the same synchronous call, so the body's `revision` equals the ETag.)
- [ ] **Step 4: Run** `npx vitest run test/cams-snapshot.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/cams/snapshot.ts server/cams/routes.ts test/cams-snapshot.test.ts
git commit -m "feat(cams): the signed per-instance configuration snapshot with ETag"
```

---

### Task 7: Tokens for cams holders, and reports

**Files:**
- Modify: `server/tokens/service.ts`, `server/cams/routes.ts`, `server/cams/instances.ts` (wire `onRevoke`), `server/server.ts`, `test/tokens.test.ts`
- Create: `test/cams-tokens.test.ts`, `test/cams-report.test.ts`

**Interfaces:**
- Consumes: P2 `Tokens` (`nextApply`, `retire`, `revoke`, `MAX_TOKENS`), `Commands` pre-checks (409 codes), Tasks 3–6.
- Produces:

```ts
// Tokens:
registerForInstance(inst: { id: string; name: string }, servedAccountIds: string[], input: unknown): { status: 200 | 201; body: { tokenId: string; state: 'pending' | 'active' | 'retiring'; label: string } };
retireForInstance(inst: { id: string }, tokenId: string, hours: unknown): { tokenId: string; state: 'retiring'; retireAt: number };
revokeHeldBy(actor: string, holder: string): number;   // R4-19, returns the count
// CamsReport (the contract's report-request type) and:
CamsInstances.report(instanceId: string, report: CamsReport, now: number): { changed: boolean; revision: string };
```

- [ ] **Step 1: Failing tests** (`test/cams-tokens.test.ts`, real server with a `ProxyClient` (test-client) answering commands with allow `['tokens.apply', 'tokens.apply.admin']`, and a signed cams client):

```ts
it('registers a client token hash: 201 pending, label "cams cluster", holder = the instance; becomes active after tokens.apply; audit actor type cams', async () => {
  const { token, hash } = generateToken();
  const a = await cams.post('/cams/v1/tokens', { v: 1, proxyId: px.id, kind: 'client', hash });
  expect([a.status, a.json]).toEqual([201, { tokenId: expect.stringMatching(/^tok_/), state: 'pending', label: 'cams cluster' }]);
  await until(async () => (await cams.snapshot()).accounts[0].proxies[0].tokens.find((t) => t.id === a.json.tokenId)?.state === 'active');
  expect((await proxyClient.check(token)).accepted).toBe(true); // the test client's managed-token check (P2)
  expect(auditRows('token-issue').at(-1)).toMatchObject({ actor_type: 'cams', actor: inst.id });
});
it('idempotent by hash (200, same tokenId); another pending one of the same kind → 409 pending_exists with its id', async () => {});
it('a hash already used anywhere else → 409 hash_in_use, nothing written', async () => {});
it('a proxy of an unserved account, or hidden for this instance → 404 not_found', async () => {});
it('kind admin on a proxy that does not allow tokens.apply.admin → 409 not_allowed_on_proxy (the P2 pre-check, unchanged)', async () => {});
it('retire: only own tokens (another instance\'s → 404), only active (else 409 not_active); hours 1–168, default 24', async () => {});
it('blocking the instance revokes every token it holds and the next tokens.apply removes them (R4-19)', async () => {});
it('write budget: a registration costs one transaction plus the P2 command writes; pulls and reports cost none', async () => {});
```

  `test/cams-report.test.ts`:

```ts
it('a valid report is kept in memory (no write) and answers changed when the applied revision differs', async () => {
  const e = readEpoch(db);
  const a = await cams.post('/cams/v1/report', { ...REPORT, appliedRevision: 'r:0000000000000000' });
  expect(a.json).toEqual({ changed: true, revision: expect.stringMatching(/^r:/) });
  expect(readEpoch(db)).toBe(e);
  expect(s.built.camsInstances.live(inst.id).report).toMatchObject({ mode: 'cams-admin' });
});
it('shadow: zeroSince is set at the first report with 0 differences and cleared by one with differences', async () => {});
it('an invalid report → 400 invalid with the field; a report with a value-shaped item over 200 chars is refused', async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**

```ts
registerForInstance(inst: { id: string; name: string }, served: string[], input: unknown) {
  const v = validateCams('tokens-request', input);
  if (!v.ok) throw new ApiError(400, 'invalid', 'body');
  const { proxyId, kind, hash } = input as { proxyId: string; kind: 'client' | 'admin'; hash: string };
  const px = this.d.registry.proxyById(proxyId);
  const hidden = px && this.q('SELECT 1 FROM cams_instance_routes WHERE instance_id = ? AND proxy_id = ? AND hidden = 1').get(inst.id, proxyId);
  if (!px || !served.includes(px.accountId) || hidden) throw new ApiError(404, 'not_found');
  const same = this.q('SELECT * FROM proxy_tokens WHERE hash = ?').get(hash) as Row | undefined;
  if (same) {
    if (same.holder === inst.id && same.proxy_id === proxyId && same.kind === kind && same.state !== 'revoked') return { status: 200 as const, body: { tokenId: same.id as string, state: same.state as 'pending', label: same.label as string } };
    throw new ApiError(409, 'hash_in_use');
  }
  const pending = this.q(`SELECT id FROM proxy_tokens WHERE holder = ? AND proxy_id = ? AND kind = ? AND state = 'pending'`).get(inst.id, proxyId, kind) as { id: string } | undefined;
  if (pending) throw Object.assign(new ApiError(409, 'pending_exists'), { extra: { tokenId: pending.id } });
  this.notAhead(proxyId);
  // the P2 issue path with holder = inst.id, label `cams ${inst.name}` (+ ' admin'), actor type cams; nextApply in the same transaction
}
```

  The `/cams/v1` router maps `ApiError` (with `extra`) to a signed answer. `revokeHeldBy(actor, holder)` revokes every non-revoked token of the holder through the existing `revoke` path (one transaction per proxy, one `tokens.apply` each). `CamsInstances.report` validates with `validateCams('report-request')`, stores `{report, reportAt}` and `shadowZeroSince` in memory, and answers `{changed, revision}` from `snapshotRevision`.
- [ ] **Step 4: Run** `npx vitest run test/cams-tokens.test.ts test/cams-report.test.ts test/tokens.test.ts test/write-budget.test.ts` → PASS (add the P4 write-budget case: 100 pulls (200/304) + 10 reports → 0 write transactions).
- [ ] **Step 5: Commit**

```bash
git add server/tokens/service.ts server/cams/routes.ts server/cams/instances.ts server/server.ts test/cams-tokens.test.ts test/cams-report.test.ts test/tokens.test.ts test/write-budget.test.ts
git commit -m "feat(cams): token-hash registration and retirement for cams holders; status reports in memory"
```

---

### Task 8: The importer and the Export

**Files:**
- Create: `server/import/export-format.ts`, `server/import/importer.ts`, `server/import/export.ts`, `test/import.test.ts`, `test/export.test.ts`, `scripts/import.ts`
- Modify: `server/api/router.ts`, `package.json` (`"import": "tsx scripts/import.ts"`)

**Interfaces:**
- Consumes: Registry, `CamsInstances`, `StatusStore.row(proxyId).reported` (`cameras[].ref`, `caFingerprint`), `proxy_tokens`.
- Produces:

```ts
// The cams export (cams `export-config`, cams plan Task 15) — parsed strictly:
export interface CamsExport { v: 1; kind: 'cams-export'; exportedAt: number; camsVersion: string; source: 'cameras-file';
  cameras: { id: string; name: string; host: string; protocol: 'https' | 'http'; tlsServername?: string; webUiUrl?: string | null; webUiNote?: string; user: string;
    proxy?: { url: string; token: { sha256: string }; adminToken?: { sha256: string }; camera?: string; caFingerprint?: string[]; tlsServername?: string } }[];
  counts: { preferencesUsers: number; proxySwitchOff: number; tlsCas: number; tlsPins: number } }
export function parseCamsExport(raw: unknown): CamsExport;        // 400 invalid with the path of the first problem; refuses any key named password/token text

export type ImportChange =
  | { kind: 'proxy-matched'; proxyId: string; name: string; by: 'token' | 'url' | 'route'; fileUrl: string }
  | { kind: 'proxy-new'; name: string; url: string }                                   // only applied with createProxies
  | { kind: 'route-add' | 'route-change'; proxyId: string; name: string; url: string; was?: string | null }
  | { kind: 'route-hide'; proxyId: string; name: string }                              // hideUnlisted
  | { kind: 'camera-new'; camsId: string; fields: Record<string, unknown> }
  | { kind: 'camera-change'; cameraId: string; camsId: string; fields: Record<string, { from: unknown; to: unknown }> }
  | { kind: 'pins-set'; proxyId: string; name: string; from: string[]; to: string[] }
  | { kind: 'proxy-tls-name'; proxyId: string; name: string; from: string | null; to: string | null }
  | { kind: 'token-external'; proxyId: string; name: string; tokenKind: 'client' | 'admin'; hashPrefix: string }
  | { kind: 'registry-only'; camsId: string };                                        // in the registry, not in the file (never deleted)
export interface ImportMismatch { id: string; camsId?: string; proxyId?: string; what: 'camera-not-on-proxy' | 'pin-differs' | 'proxy-offline' | 'proxy-not-enrolled'; detail: string }
export interface ImportResult { dryRun: boolean; account: string; instance: string; changes: ImportChange[]; mismatches: ImportMismatch[]; blocked: boolean; applied: boolean; noChanges: boolean }
export class Importer {
  constructor(d: { db: Db; clock: Clock; audit: Audit; registry: Registry; instances: CamsInstances; status: StatusStore });
  run(actor: string, accountId: string, instanceId: string, raw: unknown, o: { apply: boolean; acceptMismatch: string[]; createProxies: boolean; hideUnlisted: boolean }): ImportResult;
}
export function exportForInstance(d: { db: Db; registry: Registry; instances: CamsInstances }, accountId: string, instanceId: string): { cameras: object[]; tokens: { proxyId: string; tokenId: string; kind: string; state: string }[] };
```

  API: `POST /api/v1/accounts/:accountId/import` body `{instanceId, file: <export JSON>, apply?: boolean, acceptMismatch?: string[], createProxies?: boolean, hideUnlisted?: boolean}` → `ImportResult`; `GET /api/v1/accounts/:accountId/export?instance=cms_…` → the `cameras.json` for file mode (no `password`, no `token`/`adminToken`; `proxy.url` = the instance's route or the registered URL; `proxy.caFingerprint`, `proxy.tlsServername`, `proxy.camera`; `"user"` = `cameraUser`) plus `tokens` (ids and states only), `Content-Disposition: attachment`; audited `export-run`.

- [ ] **Step 1: Failing tests** (`test/import.test.ts`; fixture exports in `test/fixtures/import/cluster.json` and `pi.json` with RFC 5737 values; the P2 manual tokens of steps 1–2 inserted into `proxy_tokens` with the hashes the fixtures carry; the status store fed with a heartbeat reporting `cam1` and the pin):

```ts
it('dry run by default: proxies matched by token hash, cameras new, external token rows, nothing written', () => {
  const e = readEpoch(db);
  const r = imp.run(ACTOR, home.id, cluster.id, CLUSTER, { apply: false, acceptMismatch: [], createProxies: false, hideUnlisted: false });
  expect(r.changes.filter((c) => c.kind === 'proxy-matched').map((c) => (c as { by: string }).by)).toEqual(['token', 'token']);
  expect(r.changes.some((c) => c.kind === 'camera-new' && c.camsId === 'cam2')).toBe(true);
  expect(r.applied).toBe(false);
  expect(readEpoch(db)).toBe(e + 1); // the import-run audit record only
});
it('apply writes everything in one transaction with one import-apply record; a second apply shows noChanges', () => {
  imp.run(ACTOR, home.id, cluster.id, CLUSTER, APPLY);
  const again = imp.run(ACTOR, home.id, cluster.id, CLUSTER, APPLY);
  expect(again).toMatchObject({ noChanges: true, changes: [] });
});
it('the Pi file after the cluster file: a loopback route for the pi instance, hidden routes with hideUnlisted, the registered URL unchanged', () => {
  imp.run(ACTOR, home.id, cluster.id, CLUSTER, APPLY);
  const r = imp.run(ACTOR, home.id, pi.id, PI, { ...APPLY, hideUnlisted: true });
  expect(r.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'route-add', url: 'http://127.0.0.1:8480' }),
    expect.objectContaining({ kind: 'route-hide', name: 'cluster' }),
  ]));
  expect(reg.getProxy(home.id, piProxy.id).url).toBe('https://proxy.example.net:8480');
});
it('proxy groups follow cams\'s rule: same url + token hash = one proxy; two proxies with one url but different tokens are two', () => {});
it('cross-check: a proxy.camera not in the proxy\'s reported cameras, a pin that differs, an offline proxy → mismatches; apply refused (blocked) unless every id is in acceptMismatch', () => {
  status.heartbeat(piProxy.id, hbWithCameras(['other']), clock.now());
  const r = imp.run(ACTOR, home.id, cluster.id, CLUSTER, APPLY);
  expect(r).toMatchObject({ blocked: true, applied: false });
  const ok = imp.run(ACTOR, home.id, cluster.id, CLUSTER, { ...APPLY, acceptMismatch: r.mismatches.map((m) => m.id) });
  expect(ok.applied).toBe(true);
});
it('never deletes: a registry camera missing from the file is listed registry-only', () => {});
it('an unknown proxy without createProxies: listed proxy-new, apply blocked with error unknown_proxy; with it: created as runs_on local-host, pending', () => {});
it('a hash of the file\'s token that is unknown is recorded as an external token (state external, holder manual, label "imported <file proxy host>"); never sent in tokens.apply', () => {});
it('parseCamsExport refuses a password field, a token in clear (a string), a hash that is not 64 hex', () => {});
it('the diff and the audit detail carry only 8-hex hash prefixes (secret guard)', () => {});
```

  `test/export.test.ts`: the export has no `password`, `token`, `adminToken` or hash; per instance it uses the route URL; it round-trips through cams's `parseCameras` rules (a copy of the rule list as a schema in `test/fixtures/import/cameras-file.schema.json`) when a placeholder token is added; audited `export-run`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - Proxy grouping: key = `url.replace(/\/+$/, '') + '\0' + token.sha256` (cams's `groupKey` with the hash). Matching per group, in order: (1) `SELECT proxy_id FROM proxy_tokens WHERE hash = 'sha256:' || ? AND account_id = ?` (client token hash, then admin token hash); (2) `proxies.url` equal after trailing-slash trim, same account; (3) `cams_instance_routes.url` equal for this instance. A group matching two different proxies is a mismatch `proxy-ambiguous` (blocks).
  - Route: matched proxy whose registered `url` ≠ the file URL → `route-add`/`route-change` for this instance (never changes `proxies.url`). `hideUnlisted`: every proxy of the account not matched by any group and without a route for this instance → `route-hide`.
  - Cameras: matched by `(account, camsId)`; compared fields `name, host, protocol, tlsServername, cameraUser (file user), webUiUrl, webUiNote, proxyId, proxyCameraId (file proxy.camera ?? camsId)`; a camera whose proxy differs only by the route is the same proxy.
  - Pins and proxy TLS name: the group's `caFingerprint` (normalised to `SHA256:<64 upper hex>` with `normaliseFingerprint`) and `tlsServername` vs the proxy's registered ones → `pins-set` / `proxy-tls-name`.
  - Tokens: each group's token hash (and admin token hash) not in `proxy_tokens` → `token-external` (inserted on apply with state `external`, `issued_revision` = current revision, never in a `tokens.apply` set because `currentSet` reads only `pending/active/retiring`).
  - Cross-check from `status.row(proxyId)?.reported`: `proxy-offline` when not online, `camera-not-on-proxy` when `proxyCameraId ∉ reported.cameras[].ref`, `pin-differs` when the group's first pin ≠ `reported.caFingerprint[0]` (normalised). Mismatch ids are stable (`sha256hex(kind|proxyId|camsId).slice(0, 12)`) so `acceptMismatch` from a dry run applies to the apply.
  - Apply: one `tx` with all writes through `Registry` methods (each writes its own audit record, as everywhere) plus one `import-apply` record `{instance, changes: counts by kind, accepted: ids}`. A dry run writes one `import-run` record. `noChanges` = no change of any kind but `proxy-matched` and `registry-only`.
  - `scripts/import.ts`: `npm run import -- --url http://localhost:29000 --session-file <file> --account home --instance cluster --file export.json [--apply] [--accept-mismatch id,…] [--create-proxies] [--hide-unlisted]`: resolves names to ids via the API and prints the result as a table (hash prefixes only). For the local stack and the rehearsal; production uses the account page (Task 9).
- [ ] **Step 4: Run** `npx vitest run test/import.test.ts test/export.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/import scripts/import.ts server/api/router.ts package.json test/import.test.ts test/export.test.ts test/fixtures/import
git commit -m "feat(import): import a cams export (dry run, idempotent, cross-checked) and export a file-mode fallback"
```

---

### Task 9: The UI (instances, import, export, dashboard)

**Files:**
- Create: `web/src/pages/CamsInstances.svelte`, `web/src/pages/CamsInstance.svelte`, `web/src/components/ImportPanel.svelte`, `web/src/lib/cams.ts`, `web/src/lib/cams.test.ts`
- Modify: `web/src/lib/router.ts` (+ `/cams-instances`, `/cams-instances/:id`), `web/src/App.svelte` (nav), `web/src/pages/Account.svelte` (Import / Export), `web/src/pages/Dashboard.svelte` (cams rows), `server/api/router.ts` (`dashboard()` gains `cams`), `e2e/cams-instances.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 3, 7, 8 APIs.
- Produces: `dashboard().cams: { id: string; name: string; state: string; lastSeenAt: number | null; lastPullAt: number | null; mode: string | null; appliedRevision: string | null; current: boolean; held: number; keptOld: number; diverged: boolean; shadowDifferences: number | null; shadowZeroSince: number | null; problems: number }[]`; `web/src/lib/cams.ts`: `instanceState(row): 'ok' | 'stale' | 'diverged' | 'held' | 'shadow-diff' | 'never'`, `importSummary(result): {label: string; count: number}[]`.

- [ ] **Step 1: Failing tests** (`web/src/lib/cams.test.ts`): `instanceState` for each case (never pulled; last pull > 5 min ago → `stale`; `keptOld > 0` → `diverged`; `held > 0` → `held`; shadow with differences → `shadow-diff`; else `ok`); `importSummary` groups by kind with the label table; (`e2e/cams-instances.spec.ts`, fake Google, the e2e lock) create an instance, tick two accounts, add a route and a hidden route, create a code (shown once, with both commands and the server key fingerprint), revoke the key, rotate now; on an account page upload `test/fixtures/import/cluster.json`, see the dry-run table, apply, upload again → "No changes".
- [ ] **Step 2: Run** `npx vitest run web/src/lib/cams.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Instance page sections: Served accounts (checkboxes, saved with `version`), Routes (per proxy of the served accounts: URL field, "hidden for this instance" switch), Enrollment (code shown once in `ShownOnce.svelte` with the two commands and "compare this fingerprint with what admin-enroll prints"), Keys (fingerprints, confirmed, revoke), Status (last request, last pull and status, mode, applied revision vs current, held and kept-old lists by account/camsId/fields, shadow differences and "zero since", problems, token counts), Rotate now, Block, Delete (type the name). Import panel on the account page: instance picker, file input (JSON, ≤ 1 MiB, parsed in the browser only to show its size), Dry run → table of changes and mismatches (accept checkboxes per mismatch), options (create proxies, hide unlisted), Apply (confirm dialog naming the counts). Export button per instance. Every element used by e2e has a `data-testid`; colours from `theme.css`.
- [ ] **Step 4: Run** `npx vitest run web/src/lib/cams.test.ts && npm run check && npm run build && npm run test:e2e -- e2e/cams-instances.spec.ts` (with the e2e lock) → PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/pages/CamsInstances.svelte web/src/pages/CamsInstance.svelte web/src/components/ImportPanel.svelte web/src/lib/cams.ts web/src/lib/cams.test.ts web/src/lib/router.ts web/src/App.svelte web/src/pages/Account.svelte web/src/pages/Dashboard.svelte server/api/router.ts e2e/cams-instances.spec.ts
git commit -m "feat(ui): cams instances, import and export, dashboard rows"
```

---

### Task 10: Reference cams client, local stack with two cams instances, the §14.3 suite

**Files:**
- Create: `test-client/cams.ts`, `test/test-client-cams.test.ts`, `scripts/rehearse/localize.ts`, `test/localize.test.ts`, `e2e/cams-multi.spec.ts`
- Modify: `scripts/localstack/start.sh`, `scripts/localstack/stop.sh`, `scripts/localstack/setup.ts`, `scripts/localstack/lib.sh`, `docs/localstack.md`, `playwright.config.ts` (a `localstack` project that runs only with `LOCALSTACK=1`)

**Interfaces:**
- Consumes: everything above; cams `main` with the cams P4 plan merged (its `admin-enroll` and `CONFIG_SOURCE`). Until then `start.sh` prints "cams main has no cams-admin client yet: cams instances skipped" and starts as today.
- Produces: `class CamsTestClient { constructor(o: { url: string; instanceId: string; keyId: string; privateKey: string; serverKeys: string[] }); request(method, path, body?, o?): Promise<{ status: number; headers: Headers; json: any; bytes: Buffer; signatureOk: boolean }>; get(path, headers?); post(path, body); snapshot(): Promise<Snapshot> }` and `enrollCams(url, code): Promise<KeyFile & { instanceId: string }>` — an implementation independent of `server/cams/auth.ts` (it builds the texts from the contract README, not from the server's helpers); `localize(exportJson, map: { proxies: Record<string, { url: string; caFingerprint?: string[] }>; dropTlsServername?: boolean }): CamsExport`.

- [ ] **Step 1: Failing tests:** `test/test-client-cams.test.ts` (the client against a real server: enroll, pull 200 then 304, verify both signatures, register a token, report; the client refuses an answer whose signature it can't verify); `test/localize.test.ts` (URLs rewritten by group, pins replaced by the local CA's, everything else byte-identical, no field added; refuses input that contains `password`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `start.sh` (after the proxies): build cams from `CAMS_REPO` (`origin/main`, or `LOCALSTACK_CAMS_REF`) once per commit; create two instances through the API (`cms-main` serving `alpha` and `beta`; `cms-pi` serving `alpha` with a loopback route to `alpha-1` and every other `alpha` proxy hidden); start two cams processes on `127.0.0.1:29600` and `:29610` (`CONFIG_SOURCE=cams-admin`, `CAMS_ADMIN_URL=http://127.0.0.1:29000`, `CAMS_DATA_DIR` per instance under `$RUN`, Google sign-in against the fake Google for `cms-main`, `CAMS_LOGIN_TOKEN` (per-run, mode 600) for `cms-pi`, `CAMERA_CREDENTIALS_FILE` with the cam-sims' fake passwords); enroll each by piping its code into `node dist/server/cli.js admin-enroll --url http://127.0.0.1:29000`. Users: `localstack@example.com` admin in `alpha`, viewer in `beta`; `viewer@example.com` viewer in `alpha`. Ports 29600–29619 are added to `CLAUDE.md`'s port list.
  - `e2e/cams-multi.spec.ts` (runs against the local stack only, `LOCALSTACK=1`, e2e lock): (1) the picker for `localstack@example.com` lists Alpha (admin) and Beta (viewer); in Beta every admin control is absent and a PUT to settings answers 403; (2) both accounts have a `cam1`: Alpha's `cam1` and Beta's `cam1` show different proxies' streams (by the sims' overlay text); (3) a held change: change Alpha's `alpha-1` URL in cams-admin → cms-main shows the banner, keeps working on the old URL, Confirm moves it; (4) token rotation: cams-admin "Rotate now" for cms-main → new tokens active, old retiring, a request loop against cms-main's `/api/cameras/cam1/still/latest.jpg` has zero failures; (5) cms-pi restarts with cams-admin stopped (`stop` only the cams-admin PID) and serves Alpha from its cache (token sign-in, live still); cams-admin started again.
  - `scripts/rehearse/localize.ts` (`npx tsx scripts/rehearse/localize.ts --in real-export.json --map map.json --out local.json`): reads a redacted export (refuses any `password` key or a string `token`), rewrites by proxy group. Used by the rehearsal in the runbook; its inputs and outputs live in the scratch work dir.
  - `docs/localstack.md`: "Two cams instances" and "The multi-account suite" sections; what the suite proves; how to run the rehearsal with `localize.ts`.
- [ ] **Step 4: Run** `npx vitest run test/test-client-cams.test.ts test/localize.test.ts`; with cams P4 on `main`: `scripts/localstack/start.sh && LOCALSTACK=1 npx playwright test e2e/cams-multi.spec.ts` (e2e lock) → PASS; `scripts/localstack/stop.sh`.
- [ ] **Step 5: Commit**

```bash
git add test-client/cams.ts test/test-client-cams.test.ts scripts/rehearse/localize.ts test/localize.test.ts e2e/cams-multi.spec.ts scripts/localstack/start.sh scripts/localstack/stop.sh scripts/localstack/setup.ts scripts/localstack/lib.sh docs/localstack.md playwright.config.ts CLAUDE.md
git commit -m "test(localstack): two cams instances, the multi-account suite, localize for the rehearsal"
```

---

### Task 11: Docs, the kube-setup request, full checks

**Files:**
- Create: `docs/kube-setup-request-p4.md`
- Modify: `README.md`, `CHANGELOG.md` (`## [Unreleased]`), `CLAUDE.md`, `docs/restore.md`, `docs/migration-p4-runbook.md` (update any command, name or option the implementation changed)

- [ ] **Step 1:** `docs/kube-setup-request-p4.md` with exactly these requests (the runbook says when each is needed):
  1. **NetworkPolicy (cut-over step 5):** ingress to the cams-admin pod's port 8080 from the cams ksvc pods (`serving.knative.dev/service: cams` in namespace `cams`); if namespace `cams` has (or gets) a default-deny egress policy, egress from those pods to cams-admin:8080. Nothing else: no new public host, LAN port or broader egress.
  2. **Ingress path (step 6):** `https://cams-admin.skylar.technology/cams/v1/*` must reach the cams-admin Service like `/proxy/v1/*` does (only if the ingress filters paths).
  3. **cams ksvc env (step 5, then step 7):** `CONFIG_SOURCE=shadow` and `CAMS_ADMIN_URL=http://<cams-admin Service>.<namespace>.svc.cluster.local:8080` at step 5; `CONFIG_SOURCE=cams-admin` at step 7. Rollback at either step: `CONFIG_SOURCE=file`. `CAMS_DATA_DIR` stays unset (cams uses the PVC folder of `PREFS_FILE`, `/var/lib/cams`).
  4. **cams-admin env:** `INTERNAL_URLS` gains the in-cluster Service origin if it isn't listed yet (the enroll answer's `apiUrl`).
  5. **Enrollment (step 5):** one `kubectl exec -i` into the cams pod running `node dist/server/cli.js admin-enroll --url $CAMS_ADMIN_URL` with the code on stdin (Klaus or kube-setup; the code is shown once in cams-admin; the key lands on the `cams-data` PVC under `admin/`, mode 600).
  6. **Later, P4d (30 days after step 8, when Klaus says go; M §11.6):** Secret `cams-camera-credentials` (`{"v":1,"home/cam1":{"user":"cams","password":"…"},…}`) mounted read-only with `CAMERA_CREDENTIALS_FILE`, replacing `cams-cameras`; `ALLOWED_EMAILS` removed from `cams-oauth`; `CAMPROXY_TOKENS` removed from `cam-proxy-secrets`. Not part of this rollout.
- [ ] **Step 2:** `README.md`: "cams instances and the service API" (what an instance is, enrollment, routes and hidden routes, the snapshot carries no secret, import and export). `CLAUDE.md`: "the service API's check order (contract/cams-v1/README.md) is normative; a change goes into contract/ first and cams vendors it"; ports 29600–29619. `docs/restore.md`: the Export → file-mode recovery procedure (M §11.6). `CHANGELOG.md`: user-visible changes.
- [ ] **Step 3:** Full checks: `npm run lint:types && npm test && npm run build && npm run check && npm run check:svelte && scripts/contract/cam-proxy-check.sh && npm run test:e2e && npm audit --audit-level=high && scripts/backup/restore-test.sh` → green.
- [ ] **Step 4: Commit**

```bash
git add docs/kube-setup-request-p4.md README.md CHANGELOG.md CLAUDE.md docs/restore.md docs/migration-p4-runbook.md
git commit -m "docs: cams instances and the service API; kube-setup request for P4"
```

---

## Release and rollout order

Each step is a PR to `main` (merge only when every check passes), then a release when it changes the running service. The cut-over itself follows `docs/migration-p4-runbook.md`.

1. **cams-admin PR A — contract** (Task 1). cams vendors `contract/cams-v1/` the same day (cams plan Task 1).
2. **cams-admin PR B — service API** (Tasks 2–8, 11 docs part). Release. Safe: no instance exists, nothing calls `/cams/v1`; the migration only adds tables, triggers and the audit table rebuild (run `scripts/backup/restore-test.sh` on the PR: a restored older backup migrates). **P4a done** when the local stack's two instances pull signed snapshots and the tamper tests are green.
3. **cams PRs** (cams plan) and their release (cams stays in `file` mode by default: no behaviour change).
4. **cams-admin PR C — UI and local stack** (Tasks 9–10), the §14.3 suite green on the Mac.
5. **Rehearsal** (runbook §R, M §11.3) — a written result in the runbook's log section, before cut-over step 5 and again before step 7.
6. **Cut-over steps 5–8** (runbook), Klaus with kube-setup. **P4c done** after 24 h of zero shadow differences per instance, both switched, Klaus signed in through the picker.

## Self-review

- **Spec coverage:** M §5 tables, audit actions (Task 2; `commands`/`proxy_tokens` were P2, `proxy_config` is P3); §9.1 enrollment (Tasks 3–4); §9.2 routes, signing, skew, limits, transport (Tasks 4–7; transport in the kube-setup request); §9.3 snapshot, no secrets (Task 6); §9.6 routes (Tasks 3, 6; hidden routes R4-3); §10.1 cams holder, rotation flag (Tasks 3, 7); §10.3 external tokens (Task 8); §11.2 importer (Task 8); §11.3 rehearsal (Task 10, runbook); §11.4 steps 5–8 (runbook); §11.6 Export (Task 8, restore doc); §12.1 dashboard rows (Task 9); §12.5 (Task 11); §13.2 threats (Tasks 4–7: forged instance, forged snapshot, unserved accounts); §13.3 logging/guard (Tasks 5–8); §14.1–§14.3 (Tasks 1–10); §15 P4a/P4c (rollout). The cams half (§9.4, §9.5, §9.7, §9.8, §11.1, §11.5) is the cams plan.
- **Placeholder scan:** none; Task 10's dependence on cams `main` is stated with its fallback.
- **Type consistency:** `CamsInstances.touch/live/report/servedAccountIds/getRaw/confirmKey`, `CamsAuth.middleware/sweep`, `sendSigned`, `buildSnapshot/snapshotRevision`, `Tokens.registerForInstance/retireForInstance/revokeHeldBy`, `Importer.run`, `exportForInstance` are used with the same signatures in Tasks 3–11. (`getRaw(id)` and `confirmKey(instanceId, keyId)` are `CamsInstances` methods added in Task 5 next to `touch`.)
- **Review Focus:** each line has its test in the named task.
