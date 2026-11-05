# Viewer tokens (cams-admin + cams)

Status: design 2026-11-05. cams-admin part built in the PR that adds this
file; the cams part is specified in §9 and comes next.

## Klaus's answers to the open questions (2026-11-05)

1. **Who manages tokens: the system admin only, for now.** cams-admin has no
   account-admin sign-in today (only `ALLOWED_EMAILS` sign in; "admin" and
   "viewer" are roles inside the cams viewer). The `canManage` check stays
   in the code as the hook for a later account-admin sign-in, which would
   then enforce "account admins for their own accounts, only the system
   admin across other people's accounts".
2. **A viewer that has lost cams-admin** stops accepting cams-admin viewer
   tokens (new sign-ins and existing sessions) once its last good pull is
   older than **24 hours** (cams side, §9.4). The Pi's `CAMS_LOGIN_TOKEN`
   keeps working offline (demo kit).
3. **Last used is saved**, with the existing 10-minute status snapshot, so it
   survives a restart; no write of its own (§ Storage).

## Intent

A link or a QR code that lets a person (family, a neighbour, a demo visitor)
watch the cameras of one or more accounts without a Google account, for a
limited time, revocable at any moment, managed in cams-admin next to the
account's users.

## Klaus's decisions (2026-11-05)

**cams-admin**
- An account's Users page (`#/accounts/<id>/users`) gets a **Tokens** list
  with **Add token**. Tokens are **viewer-only**.
- A token has a **name** (fixed after creation), **one or more accounts**,
  and a **validity**: 1 day, 1 week (default), 30, 90 or 365 days. No
  unlimited tokens.
- The list shows name, accounts, valid until, status (valid / expired /
  revoked) and last used. Actions:
  - **Copy**: the token to the clipboard, any time.
  - **Validity**: a new length from today (longer or shorter), or revoke. A
    revoked or expired token stays listed and can be made valid again, with
    the same token string.
  - **Accounts**: add or remove accounts.
  - **Delete**: revokes it and removes it from the list.
  - **QR code**: a light window with the QR code of the sign-in link and
    **Copy link**. **The link always uses `https://cams.skylar.technology`**
    (Klaus, 2026-11-05: no viewer picker). Tokens still work on every viewer
    of their accounts by paste.
- **Who**: account admins for their own accounts; only the system admin may
  give one token accounts another person administers (system admin only for
  now: answer 1).
- **Audit**: create, validity change, revoke, account change, delete and copy;
  never the token itself.
- **Storage**: the token is kept readable (copy any time), encrypted at rest.
  Viewers get only a fingerprint.
- **Token size** (Klaus, 2026-11-05): about 120–130 random bits as base62,
  21–22 characters, a 2–4 character prefix, the whole link at most about 65
  characters: a version 5 QR code (37×37) at level M, byte mode, quiet zone 4.

**cams** (§9)
- `/token` sign-in page, linked from the sign-in screen as "Sign in with a
  token": paste, or scan with the device camera (getUserMedia +
  BarcodeDetector, jsQR where there is none, e.g. iOS Safari). No scanner on
  a plain-http page (the Pi's LAN address): paste and link only.
- Link `https://<viewer>/token#t=<token>`; the token only in the fragment;
  read, removed at once with `replaceState`, then "Sign in as '<name>'?" with
  one button (no silent sign-in), then posted. Never in a query string.
- The session is a viewer of the token's accounts and lasts until the token
  expires; a revoke, an expiry or a shortened validity reaches every viewer
  within a few minutes and ends its sessions.
- Every viewer that serves one of the token's accounts accepts it.
- The Pi's `CAMS_LOGIN_TOKEN` keeps working alongside.
- About page: "Signed in as": the email, or the token's name with "valid
  until …".

## Token format (my call, within Klaus's numbers)

- `cav_` + **22 base62 characters** (`0-9A-Za-z`, rejection-sampled from
  `crypto.randomBytes`): 22 × log2(62) ≈ **131 bits**, 26 characters in all.
  `cav_` follows `cao_` (operations) and `cad_` (diagnostics).
- Link: `https://cams.skylar.technology/token#t=` (39) + 26 = **65
  characters**. Byte mode, level M: version 4 holds 62 bytes, version 5
  holds 84, so the link is a **version 5** code (37×37 modules), drawn with
  a 4-module quiet zone. `test/viewer-tokens.test.ts` checks the length and
  the version.
- Base62 is case-sensitive: the paste field only trims white space.
- The link's origin is `VIEWER_LINK_URL` (default
  `https://cams.skylar.technology`; must be https and at most 30 characters
  so the link stays in version 5).

## Storage and keys (my call)

- Tables (migration 20): `viewer_tokens` (id `vtk_…`, name, `fingerprint`
  UNIQUE, `secret` (ciphertext), `days`, created by and at, updated at,
  `expires_at` NOT NULL, `revoked_at/by`, `last_used_at`, `version`) and
  `viewer_token_accounts (token_id, account_id)`, both ON DELETE CASCADE.
  Triggers bump each linked account's `config_revision` on every change of
  what a snapshot says (name, fingerprint, expiry, revoke, accounts), so
  every viewer serving it pulls a new snapshot.
- **Last used** (answer 3): the viewers' reports update it in memory; the
  status store's 10-minute snapshot writes the changed ones in its own
  transaction (`StatusStore.onSnapshot`), and the shutdown flush does too,
  so it survives a restart without a write of its own and without moving a
  snapshot revision (`test/cams-snapshot-viewer-tokens.test.ts`).
- **Encryption at rest**: AES-256-GCM. The repo has no symmetric key yet (the
  Ed25519 signing key only signs), so a new one: `VIEWER_TOKEN_KEY_FILE`, a
  file holding 32 random bytes as base64 (mode 600, refused when readable by
  group or others, like the signing key). Stored value
  `v1:<keyId>:<iv>:<ciphertext+tag>` (base64url; `keyId` = 8 hex of SHA-256
  over the key, so a wrong key reads as "unavailable", never as garbage);
  the token id is the GCM additional data, so a ciphertext can't be moved to
  another row.
- Without the key (not set, or the file missing) the server starts and existing tokens keep working on
  the viewers (they need only the fingerprint), but **create**, **Copy** and
  **QR code** answer `503 viewer_tokens_unconfigured`; the page says so.
- The key never goes into the database, the backup or the export. The
  ciphertext goes into the Litestream/S3 backup; without the key it is
  useless. Losing the key: the tokens keep working, but can't be copied any
  more (make new ones). Rotation: later, through `keyId`.
- Import and export never carry viewer tokens.
- **Restore** (as the other tokens, review M5): every revoke, delete and
  validity change is also written to the revocation journal; at start the
  newest entry per token is applied to a row last changed before it, so a
  restore from an older backup never brings a revoked or deleted token back
  or a longer validity.

## Fingerprint (my call)

`fingerprint = "sha256:" + hex(SHA-256(UTF-8("cams-viewer-token v1\n" + token)))`.

With 131 random bits a fast hash can't be reversed or guessed, so a plain
SHA-256 with a domain prefix is enough (no HMAC key to share with viewers).
The same value is the database's unique lookup key. It is the one hash a
snapshot carries: the snapshot rule "never a hash" is about stored secrets
that could be guessed (codes) or that open a proxy; this one only lets a
viewer recognise a token it is shown. `vectors.json` has a fixed fake token,
its fingerprint and its link, so cams reproduces them.

## Contract change (cams-v1, snapshot format 4)

- `accounts[].viewerTokens`: `[{ id: "vtk_…", name: "≤64", fingerprint:
  "sha256:<64 hex>", expiresAt: <ms> }]`, ≤ 64 per account, sorted by id:
  the tokens valid at `generatedAt` (not revoked, not expired) that include
  this account. Required in strict, optional at run time.
- `report-request.viewerTokens` (optional): `[{ id, lastUsedAt }]`, ≤ 200,
  what cams saw since its last report (§9.6).
- `SNAPSHOT_FORMAT` 3 → 4, so every viewer fetches the new snapshot once.
- **Old viewers**: cams's `checkAccount` maps the fields it knows one by one
  and drops the rest, and the signature covers the whole object as received,
  so today's cams verifies and ignores `viewerTokens`. Nothing has to ship in
  cams first. After merging, cams re-vendors `contract/cams-v1` (its
  `contract-drift` check fails until it does; the re-vendor alone is safe).

## Revoke path and its latency

revoke / delete / shorter validity in cams-admin → trigger bumps the
accounts' `config_revision` → the snapshot revision changes → the viewer's
next pull gets `200` with the new snapshot → the token is gone from the
fleet → cams's per-request session check (§9.4) refuses it.

Measured (cams `server/admin/puller.ts`, default options as
`configSource.ts` runs them; the cluster's manifests don't set
`CAMS_ADMIN_PULL_MS`, and cams allows it only 1–60 s): the code's interval is 60 s ± 10 % jitter, so the **worst case is about
66 s** plus one request (measured below). That is
within "a few minutes"; no change proposed. Natural expiry needs no pull:
cams compares `expiresAt` with its own clock (plus the offset it measures
against cams-admin). A viewer that can't reach cams-admin backs off to 5
minutes and keeps its last snapshot; after 24 hours without a good pull it
stops accepting cams-admin tokens (answer 2).

Measurement (2026-11-05, the real `Puller` class with default options, six
pulls, a pull that always succeeds): gaps 58.8, 57.0, 58.3, 55.5, 64.9 s,
the largest 64.9 s, against a code maximum of 66 s. So a revoke ends the
sessions on a viewer that reaches cams-admin **within about 66 s** (the
revision moves in the same transaction as the revoke:
`test/cams-snapshot-viewer-tokens.test.ts`).

## APIs (cams-admin, under `/api/v1`, session + CSRF like the rest)

| method and path | what |
|---|---|
| `GET /viewer-tokens?account=acc_…` | the tokens with that account (without `account`: all) |
| `POST /viewer-tokens` `{name, accountIds, days}` | create; `201 {item, token, link}` |
| `POST /viewer-tokens/:id/validity` `{days}` | valid for `days` from now (also after revoke or expiry) |
| `POST /viewer-tokens/:id/revoke` | revoke (idempotent) |
| `PUT /viewer-tokens/:id/accounts` `{accountIds, version}` | set the accounts (≥ 1) |
| `POST /viewer-tokens/:id/copy` `{what: "token" \| "link" \| "qr"}` | `{token, link}`, `Cache-Control: no-store`, audited |
| `DELETE /viewer-tokens/:id` | revoke and remove |
| `GET /diag/viewer-tokens` | the list without token or fingerprint (diag token) |

`days` ∈ {1, 7, 30, 90, 365}; name 1–64 characters, no control characters;
at most 50 valid tokens per account and 64 accounts per token. An item is
`{id, name, accounts: [{id, name, displayName}], days, createdAt, createdBy,
expiresAt, revokedAt, revokedBy, lastUsedAt, state, fingerprintPrefix,
version}`; never the token. Operations tokens (`cao_`, scope `tokens`) may
call **revoke** only (incident response from a script); the rest is
session-only (`test/ops-auth.test.ts` walks the router).

## UI (cams-admin)

Users tab: the users table as today, then **Tokens** (`data-testid`
`vt-*`): name, accounts, valid until, status chip, last used, and buttons
**Copy**, **QR code**, **Validity**, **Accounts**, **Delete**. **Add token**:
name, a select of 1 day / 1 week / 30 / 90 / 365 days (1 week preselected),
and the accounts as checkboxes (this account checked). After create, the
QR window opens. **Validity** opens a small window with the same select
and **Revoke**; **Accounts** a window with the checkboxes; **Delete** asks
first. The QR window draws the code as SVG (`qrcode-generator`, MIT, no
dependencies, level M, quiet zone 4) with **Copy link** and the link's host
in words.

## Audit

`viewer-token-create`, `-validity`, `-revoke`, `-accounts`, `-delete`,
`-copy`. Detail: `fingerprintPrefix` (8 hex), `days`, `expiresAt`, account
ids (added / removed), `what` (copy). `accountId` is the token's account when
it has one, else null (the ids are in the detail). Never the token, the
fingerprint in full or the ciphertext (`test/viewer-tokens.test.ts` scans
the audit log for them).

## Threats and mitigations

- **Leaked link or QR photo**: anyone holding it is a viewer until revoked or
  expired. Short default (1 week), viewer-only, revoke reaches viewers in
  about a minute, every copy and QR view is audited, "last used" shows use.
  The fragment keeps it out of server logs, proxies, `Referer` and link
  previews; the `/token` page loads nothing third-party and removes the
  fragment before anything else runs.
- **Shared device**: the session is a cookie for this browser until the
  token expires; About shows "Signed in as <name>" and **Sign out**. A
  revoke ends it everywhere.
- **Brute force**: 131 bits; nothing to guess. Still, cams limits failed
  token sign-ins (the existing `tokenFailureLimit` plus a global bucket) and
  answers one error for unknown, revoked and expired tokens. cams-admin's
  routes are behind its session and write limits (never per address).
- **Login CSRF**: no silent sign-in; the post is a same-origin JSON request
  (cams's `requireSameOrigin`), started by the person's click.
- **Copy abuse in cams-admin**: copy needs a system-admin session (no ops or
  diag token), is rate-limited per session and audited; `no-store`.
- **Database or backup leak**: ciphertext only; the key lives in a Secret.
- **Snapshot or Pi cache leak**: fingerprints only.

## 9. The cams side (next PR, built from this)

1. **Contract**: re-vendor `contract/cams-v1`; `snapshot.ts` parses
   `viewerTokens` (absent = `[]`; a bad entry fails that account part like
   a bad user); the fleet keeps `{id, name, fingerprint, expiresAt,
   accounts}` per token, joined across accounts by id.
2. **`/token` page** (Svelte, public route): reads `location.hash`
   (`#t=`), calls `history.replaceState(null, '', '/token')` first, then
   `POST /auth/viewer-token/check {token}` → `{name, expiresAt}` or one
   `invalid_token`; shows "Sign in as '<name>'?" and one **Sign in** button
   → `POST /auth/viewer-token {token}` → cookie, then `/app`. Paste field
   (trimmed). Scanner only when `window.isSecureContext`: getUserMedia
   (rear camera), BarcodeDetector `qr_code` when present, else jsQR (pinned,
   lazy-loaded chunk); a scanned value is accepted only if it is the
   same-origin `/token#t=` link or a bare `cav_` token. A query `?t=` /
   `?token=` is refused (400 `token_in_url`) and never read.
3. **Routes**: both POSTs JSON, `requireSameOrigin`, the token failure
   limiter, 4 KiB body; the token is compared by fingerprint (a map lookup
   on the hash; no timing leak of the token). "check" returns only name and
   expiry, so it doesn't sign in.
4. **Session**: `signViewerTokenSession(id, fp16)` with `via:
   'viewer-token'`, `vt: <id>`, `tf: <16 hex of the fingerprint>`, JWT
   `exp` = the token's `expiresAt` (cookie `maxAge` the same). `authState`
   looks the token up in the current fleet on every request: id present,
   fingerprint prefix equal, `expiresAt > now`, and (answer 2) last good pull
   within 24 h (else the session ends and a new sign-in is refused with the
   one `invalid_token` answer; the Pi's `CAMS_LOGIN_TOKEN` is not affected); memberships = its accounts with role **viewer**; one account
   → in, several → the existing account picker (`acc` in the cookie). No
   ALLOWED_EMAILS. MCP tokens can't be made from it (viewer).
5. **Pi fixed token**: `via: 'token'` (CAMS_LOGIN_TOKEN) unchanged; the
   `/signin` page shows its form as today and the "Sign in with a token"
   link besides.
6. **Last used**: per token id the last request time, rounded to the minute,
   in memory; the report carries `viewerTokens: [{id, lastUsedAt}]` for ids
   used since the last report (≤ 200).
7. **About**: "Signed in as" `email` (Google), or "<name>, valid until
   <date>" (viewer token), or the token user (Pi token). `/api/me` gains
   `{via, name?, validUntil?}`.
8. **Logs**: never the token or its fingerprint; `viewer_token_login` with
   the token id only.
9. **Tests**: vectors (fingerprint, link), snapshot parse (absent, valid,
   bad), sign-in (paste, link, query refused, unknown/expired/revoked one
   answer, rate limit), session ends after the fleet drops the token
   (simulated pull), shorter validity, picker for two accounts, About,
   fake admin serving `viewerTokens`; e2e at desktop and phone: open the
   link, confirm, see cameras, revoke in the fake admin, next request
   signed out.

## Tests (cams-admin, this PR)

Unit: token format, base62 distribution bounds, fingerprint vector, AES-GCM
round trip, wrong key and moved ciphertext refused, link length ≤ 65 and QR
version 5. Store: create (days set, default 7, others refused), copy,
validity (extend, shorten, re-validate after revoke and expiry, same
token), revoke, accounts, delete, per-account limit, revision bumps,
journal replay. API: every route, CSRF, ops token may only revoke, diag
view, no-key 503, audit (and no secret in it). Snapshot: `viewerTokens`
in strict, only valid tokens, only served accounts, guard against the
token and ciphertext. Contract: `make` output committed, fixtures, vectors.
e2e (desktop and phone): add a token, copy, QR window, validity, revoke,
accounts, delete.

## PR split

1. **cams-admin** (this): migration, store, crypto, APIs, diag, contract
   (snapshot format 4, report field, vectors), UI, e2e, this design.
2. **cams**: re-vendor + §9, with e2e. Until it ships, tokens can be made but
   don't sign anyone in.
3. Deployment (below) before the first token is created in production.

## Deployment (agreed with the kube-setup session, 2026-11-05)

- **Secret** `cams-admin-viewer-token-key`, key `key`: 32 random bytes as
  base64. Klaus makes it with `scripts/create-secrets.sh --only viewer-key`
  (also part of `--only all`) from the file named by
  `VIEWER_TOKEN_KEY_FILE_LOCAL` in his `.env` (mode 600). When that file is
  missing, the script makes it (`openssl rand -base64 32`, mode 600) and
  prints its path, never the key: that file is Klaus's copy; without it,
  existing tokens can't be copied after a Secret loss.
- **Mount**: `/etc/cams-admin/viewer` (a memory emptyDir, filled by an init
  container from the optional Secret), file `/etc/cams-admin/viewer/key`,
  env `VIEWER_TOKEN_KEY_FILE=/etc/cams-admin/viewer/key`. The file must have
  no group or other permission bits (0600 or 0400; the pod's uid 1000 may
  own it).
- **Before the Secret exists** the file is missing: cams-admin starts, logs
  `viewer_token_key_missing` once, and tokens are off (create, Copy and QR
  answer 503). An empty or malformed file, or one readable by group or
  others, stops the start.
- `VIEWER_LINK_URL` needs no setting (the default is the cluster viewer).
- No network exposure changes.
