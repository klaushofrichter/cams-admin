# cams-admin phase 1: fleet registry, proxy channel, dashboard (design)

**Status:** approved by Klaus (2026-10-06, "The spec is ok"), with his answers
to the open questions folded in (§13, §15.4, §17, §18). Nothing is built yet.
**Repos touched by phase 1:** cams-admin (new), cam-proxy (one optional
addition, §9). cams and cam-sim are unchanged in phase 1.

## Requirements (Klaus, 2026-10-06), binding

1. cams-admin is a separate app at `cams-admin.skylar.technology` for account
   and configuration management only. It never shows or relays video.
2. A system administrator signs in with Google OAuth. The allowlist is in the
   environment.
3. The administrator creates, edits and deletes **accounts**. An account is
   one cams setup, identified by an account name (not an email). An account's
   cams data belongs to that account only.
4. Each account has **users**, each with a profile and a role (`admin` or
   `viewer` to start). **The same email may be in several accounts.** One cams
   hostname may serve several accounts; after login the user picks an
   account when their email is in more than one. Phase 1 only stores users and
   roles and defines the interface cams will use later (§12, P4).
5. Accounts have **proxies** and **cameras**; cameras are associated with
   proxies. cams-admin records everything configured today: where a proxy
   runs (local cluster, a local host such as the Pi or a PC, a public cloud),
   its DNS name when it has one, its site-CA fingerprint, and so on.
6. cams-admin manages tokens. Phase 1 stores and issues the proxy enrollment
   credential; the cams↔proxy client tokens come in phase 2 (ruling R2, §2).
7. **Live status** of proxies and their cameras when cams-admin is not on the
   LAN: proxies connect outbound to cams-admin. Later phases reuse that
   channel for signed, audited commands; phase 1 defines the message envelope
   and implements status only. Camera passwords never pass through cams-admin.
8. **Simulated cameras:** phase 1 records cam-sim instances per account and
   shows their status through their proxy. Creating or deploying sims comes
   later.
9. **Database:** SQLite, backed up continuously (Litestream) to AWS S3, plus a
   daily `VACUUM INTO` snapshot; a written restore procedure and a tested
   restore (Klaus 2026-10-06: "We can use S3 for backup").
10. **Tech and standards like cams:** Node/TypeScript, Express, Svelte, a
    Docker image, a release workflow that deploys to the cluster, public
    ingress and certificate through kube-setup (requested in a doc, never
    changed from here), badge row, Dependabot, branch protection, CodeQL,
    tests, Playwright e2e.
11. **Testing:** several accounts with proxies and simulated cameras on the
    Mac (a local-stack script). The Pi and the cluster's proxy are enrolled as
    the `home` account right after phase 1 ships (Klaus 2026-10-06; he allows
    reconfiguring the Pi for it).
12. **Testing emphasis** (Klaus 2026-10-06): "Make sure to have good testing
    for the proxy monitoring and metric that go to the cams-admin." §15.4 is
    that test plan.

## 1. Goals and non-goals

### Goals (phase 1)

- A registry of accounts, users with roles, proxies, cameras and simulated
  cameras, editable by the system administrator.
- Proxy enrollment with a one-time code, and a per-proxy key that only the
  proxy holds.
- One outbound channel from each enrolled proxy to cams-admin, carrying a
  heartbeat with cam-proxy's existing health summary every 30 s.
- A live dashboard: every account, proxy and camera with its state, problems
  and age of the last heartbeat. A proxy shows as offline 90 s after its last
  heartbeat.
- An audit log of every administrator action and every enrollment and key
  event.
- A backup to S3 that survives losing the cluster, and a restore that CI
  exercises.
- A versioned message envelope that later phases extend with commands,
  without changing the connection or the enrollment.

### Non-goals (phase 1)

- No video, stills, clips or events. cams-admin is not in any data path.
- No commands to proxies or cameras: no settings, actions, restarts or token
  pushes (P2, P3).
- No change to cams: it keeps its `cameras.json` and its `ALLOWED_EMAILS`
  until P4.
- No sign-in for account users. Only the system administrator signs in to
  cams-admin. Account users are records that cams will read in P4.
- No creating or deploying cam-sim instances or proxies (P5).
- No storage of camera passwords, cam-proxy client/admin tokens, FTP
  passwords or PoE-switch passwords, now or later (§10).

### Fit with cam-proxy's "no proxy of proxies" rule

The multi-camera spec (cam-proxy `2026-10-05-multi-camera-host-design.md`
§13.1) rejects a middle tier that collects proxies, because it would add a
single point of failure and a second place for tokens and pins. cams-admin
keeps to that: it is a **control plane**, not a data plane. cams keeps
talking to every proxy directly. When cams-admin is down, nothing a camera
user does changes. The dashboard goes stale, and enrollment waits.
cams-admin holds no credential that reaches a proxy or a camera (the proxy
connects to it, never the reverse).

## 2. Rulings (with reasons)

**R1. Transport: one WebSocket per proxy (`wss://…/proxy/v1/connect`), not
SSE + POST.**

- *NAT:* both work outbound through NAT. The connection starts on the proxy's
  side, so the Pi and a mini PC behind the home router need no port opened.
- *Bidirectional:* phase 3 needs server→proxy commands and proxy→server
  results on the same authenticated session. SSE + POST would be two
  channels, and each POST would have to authenticate again (and be checked
  against replay). The WebSocket gets one challenge per connection. Every
  message after that is bound to the connection.
- *Node support:* Node 26 (cam-proxy's `engines`) has a global `WebSocket`
  client, so cam-proxy gains **no dependency**. cams-admin uses `ws`
  (maintained, small) on the server. An SSE client in Node would need either
  a dependency or a hand-written parser, plus a separate POST path.
- *The cluster's ingress:* Traefik passes WebSocket upgrades. Home Assistant
  already runs WebSockets through it. Knative is a different matter: it caps
  a request at the revision's `timeoutSeconds` (the Home Assistant ksvc sets
  300), which would cut a long-lived connection whichever transport we use.
  So cams-admin runs as a plain Deployment behind Traefik, not as a ksvc
  (§14).
- *Reconnects:* the design survives a cut at any moment anyway. The
  reconnect uses backoff with jitter, offline is judged by the heartbeat age
  and not by the socket, and a reconnect's first heartbeat restores the
  status within seconds. A proxy behind an ingress or a mobile link that
  drops idle connections loses nothing but a reconnect.
- *Browsers* talk to cams-admin over SSE (`GET /api/v1/live`). They only
  receive, they already have a session cookie, and SSE needs no upgrade
  handling in the UI.

**R2. Tokens: phase 1 issues the enrollment credential only. cams↔proxy
client tokens are phase 2.**

- Today the client, admin and audit tokens live in each proxy's environment
  (`CAMPROXY_TOKENS`, `CAMPROXY_ADMIN_TOKEN`, `CAMPROXY_AUDIT_TOKEN`) and in
  cams's `cams-cameras` Secret.
- If cams-admin issued them, it would have to deliver them to both sides. The
  proxy side needs a signed command over the channel (P3 machinery), and the
  cams side needs cams to read its configuration from cams-admin (P4).
- Issuing tokens in P1 would only create a third copy of each secret with no
  consumer. That is exactly the "second place for tokens" that §13.1 warns
  about.
- P2 builds the first signed command (`tokens.apply`) and a cams export. It
  can also send the proxy only token **hashes**, since cam-proxy compares
  digests anyway (`tokenMatches` in `src/api/auth.ts`), so the plaintext goes
  to cams alone.

**R3. The per-proxy key is an Ed25519 key pair made on the proxy, not a bearer
secret stored as a hash.**

- The coordinator's design stores a hash of a long-lived secret. A key pair is
  strictly better:
  - The private key never leaves the proxy, not even at enrollment.
  - cams-admin stores only the public key, so a leaked database or backup
    lets nobody act as a proxy.
  - The proxy proves possession by signing a fresh server nonce, so nothing
    reusable crosses the wire.
- The same key signs P3 command results. cams-admin's own Ed25519 key (the
  proxy pins its public key at enrollment) signs the challenge now, and P3
  commands later. Each side therefore authenticates the other even on the one
  plain-HTTP path that is allowed (the cluster-internal URL, §8.9).
- Node's `crypto` does Ed25519 natively, with no dependency on either side.
- The enrollment **code** stays as the coordinator designed it: one-time,
  stored as a hash, and short-lived.

**R4. Backup: Litestream to AWS S3, plus a daily `VACUUM INTO` snapshot to the
same bucket under its own prefix.**

- A local S3 (SeaweedFS in Docker; MinIO no longer publishes images) is the only local and CI test target.
- The details, the IAM policy and the restore procedure are in §13. The bucket
  and IAM setup is a request (`docs/kube-setup-request.md`).

**R5. The config key in cam-proxy is `camsAdmin`, not `admin`.**

- cam-proxy already uses "admin" for the admin token, the admin UI and the
  admin session (`CAMPROXY_ADMIN_TOKEN`, `requireAccess('admin')`). A key
  named `admin.url` would read as the admin UI's URL.

## 3. Architecture

```
  browser (sysadmin) ──HTTPS── Traefik ── cams-admin pod ──────────── S3 bucket
     Google OAuth, SSE live                 ├─ app (Express, Svelte UI,   (Litestream WAL
                                            │   ws server, SQLite)         + daily snapshot)
                                            └─ litestream (sidecar)
                                                   ▲
         outbound WSS, one per proxy ──────────────┘
   ┌──────────────┬──────────────────┬───────────────────┐
   Pi cam-proxy   mini-PC cam-proxy   cluster cam-proxy    Mac test proxies
   (home LAN)     (home LAN)          (svc URL, §8.9)      (local stack)
```

- **App:** one Node process. It runs:
  - Express 5 with the JSON API (§11) and the static Svelte build;
  - the WebSocket endpoint for proxies (`ws`, `noServer` mode on the same
    HTTP server);
  - the liveness checker, a 10 s tick;
  - the daily snapshot job;
  - the SSE fan-out to browsers.
- **Database:** one SQLite file opened with `node:sqlite` (`DatabaseSync`), as
  cam-proxy's catalog does: no native module. WAL mode, `foreign_keys=ON`,
  `busy_timeout=5000`, `synchronous=NORMAL`, STRICT tables. Migrations are
  numbered and kept in code, with the version in `PRAGMA user_version`.
  Checkpoint settings follow Litestream's guidance, which the implementation
  plan pins against the Litestream release we use.
- **One replica, by construction.** The live connections and the SQLite file
  belong to one process. The Deployment has `replicas: 1` and
  `strategy: Recreate`. Horizontal scale is not a goal: tens of proxies send
  one small message per 30 s each.
- **In-memory state:** the open connections (`proxyId → connection`), the
  per-proxy rate counters, and the live status of every proxy. Meaningful
  changes are written at once and the rest every 10 min to `proxy_status`
  (§13.3, S3 cost), so a restart shows the last known state, marked stale
  until the proxies reconnect.

## 4. Data model

All ids are text: a type prefix plus 20 characters of Crockford base32
(about 100 random bits), e.g. `acc_7Q2M…`, `prx_…`, `cam_…`, `usr_…`, `key_…`,
`enr_…`, `aud_…`. Times are integer milliseconds since the epoch (UTC).
Every editable row has `version INTEGER NOT NULL DEFAULT 1` for optimistic
concurrency (PATCH sends it; a mismatch answers 409 `conflict`). Tables are
`STRICT`.

### 4.1 Tables

**`accounts`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `acc_…` |
| `name` | TEXT NOT NULL UNIQUE | `^[a-z0-9][a-z0-9-]{1,31}$`. This is the account name users may type at login later (P4). Renaming it is allowed, with a warning, because cams refers to `id` |
| `display_name` | TEXT NOT NULL | 1–80 chars |
| `notes` | TEXT | ≤ 2000 chars |
| `created_at`, `updated_at`, `version` | INTEGER | |

**`account_users`** (a user is a membership: one row per account and email)

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `usr_…` |
| `account_id` | TEXT NOT NULL | FK → accounts ON DELETE CASCADE |
| `email` | TEXT NOT NULL | normalised: trimmed, lower-cased; ≤ 254 chars; one `@`; no whitespace, `,`, `;`, `"` or `\` (the same character rules as cams's login hint) |
| `display_name` | TEXT | ≤ 80 |
| `role` | TEXT NOT NULL | `CHECK (role IN ('admin','viewer'))` |
| `disabled` | INTEGER NOT NULL DEFAULT 0 | 0/1. A disabled user stays listed but gets no membership (§12 P4) |
| `created_at`, `updated_at`, `version` | INTEGER | |
| | | **`UNIQUE (account_id, email)`**; index on `email` (for the P4 lookup "accounts and roles for this email") |

The same email in several accounts is several rows, one per account, each
with its own role and profile. Klaus listed only a role for the profile;
phase 1 adds `display_name` and `disabled` and nothing else.

**`proxies`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `prx_…` |
| `account_id` | TEXT NOT NULL | FK → accounts ON DELETE CASCADE; **`UNIQUE (account_id, id)`** so that cameras can reference the pair (below) |
| `name` | TEXT NOT NULL | `^[a-z0-9][a-z0-9-]{0,31}$`; `UNIQUE (account_id, name)` |
| `display_name` | TEXT NOT NULL | ≤ 80 |
| `runs_on` | TEXT NOT NULL | `CHECK IN ('cluster','local-host','cloud')`: where it runs |
| `host_kind` | TEXT | `CHECK IN ('pi','mini-pc','pc','mac','vm','container','other')` or NULL |
| `url` | TEXT | how cams reaches it, `^https?://` with no credentials, query or hash (cams's `proxy.url` rule) |
| `admin_ui_url` | TEXT | its admin UI (cam-proxy `server.publicUrl`), when different from `url` |
| `dns_name` | TEXT | its DNS name when it has one; NULL otherwise (e.g. a LAN host reached by IP) |
| `tls_site` | TEXT | cam-proxy `tls.site` for a host with a site CA; NULL otherwise |
| `tls_servername` | TEXT | `proxy.<site>.internal` (cams's `proxy.tlsServername`) |
| `ca_fingerprints` | TEXT | a JSON array of 0–2 entries, each normalised to `SHA256:` + 64 upper-case hex characters. Two entries are allowed during a CA rotation, as in cams. Entered by the administrator from the proxy's Certificates card, **never taken from the channel**: it is cams's trust anchor. The channel's report is only compared with it (§8.6) |
| `notes` | TEXT | ≤ 2000 |
| `state` | TEXT NOT NULL | `CHECK IN ('pending','enrolled','revoked')`. `pending`: no key yet |
| `created_at`, `updated_at`, `version` | INTEGER | |

**`proxy_keys`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `key_…`; the proxy sends it in `hello` |
| `proxy_id` | TEXT NOT NULL | FK → proxies ON DELETE CASCADE |
| `public_key` | TEXT NOT NULL UNIQUE | Ed25519 SPKI DER, base64 (44 bytes) |
| `fingerprint` | TEXT NOT NULL | `SHA256:` hex of the DER, shown in both UIs so a person can match them |
| `created_at` | INTEGER NOT NULL | |
| `enrollment_id` | TEXT | the code that created it |
| `last_seen_at` | INTEGER | the last successful `hello` |
| `revoked_at` | INTEGER | NULL while active |
| `revoked_reason` | TEXT | `admin`, `re-enrolled`, `proxy-deleted`, `unenrolled` |
| | | at most **one active key per proxy**: a partial unique index `ON proxy_keys(proxy_id) WHERE revoked_at IS NULL` |

**`enrollment_codes`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `enr_…` |
| `proxy_id` | TEXT NOT NULL | FK → proxies ON DELETE CASCADE; the code enrolls this proxy record only |
| `code_hash` | TEXT NOT NULL UNIQUE | SHA-256 of the normalised code (the code has 100 bits of entropy, so a fast hash is enough) |
| `created_by` | TEXT NOT NULL | the administrator's email |
| `created_at`, `expires_at` | INTEGER NOT NULL | the default lifetime is 24 h; the UI offers 1 h, 24 h or 7 d |
| `used_at` | INTEGER | set on redemption; the code is dead from then on |
| `cancelled_at` | INTEGER | |
| | | at most one live code per proxy: creating a new one cancels the old one |

**`cameras`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `cam_…` |
| `account_id` | TEXT NOT NULL | FK → accounts ON DELETE CASCADE |
| `proxy_id` | TEXT | NULL = a camera cams reaches directly with no proxy (no live status). **`FOREIGN KEY (account_id, proxy_id) REFERENCES proxies(account_id, id) ON DELETE SET NULL (proxy_id)`**: a camera can only belong to a proxy of its own account (enforced by the database, not just the API) |
| `cams_id` | TEXT NOT NULL | cams's camera id, `^[a-z0-9][a-z0-9-]{0,31}$`; `UNIQUE (account_id, cams_id)` (cams ids are unique across proxies, §13.2) |
| `proxy_camera_id` | TEXT | the proxy's id for the camera (cams `proxy.camera`); `UNIQUE (proxy_id, proxy_camera_id)`. Required when `proxy_id` is set |
| `name` | TEXT NOT NULL | ≤ 80 |
| `kind` | TEXT NOT NULL | `CHECK IN ('camera','sim')` |
| `model` | TEXT | e.g. RLC-1224A, as reported or entered |
| `host` | TEXT | cams's `host`: an address, a name or `from-proxy` |
| `protocol` | TEXT | `https`/`http` |
| `tls_servername` | TEXT | |
| `camera_user` | TEXT | the cams camera user's **name** only. The password is never stored (§10) |
| `web_ui_url`, `web_ui_note` | TEXT | cams's fields (≤ 120 for the note) |
| `notes` | TEXT | |
| `created_at`, `updated_at`, `version` | INTEGER | |

Together with `proxies`, these columns are a superset of what cams's
`cameras.json` and `scripts/cameras-config.ts`'s input hold today, minus the
secrets. That lets P2 and P4 produce those files.

**`sims`** (one row per camera of kind `sim`)

| column | type | rules |
|---|---|---|
| `camera_id` | TEXT PK | FK → cameras ON DELETE CASCADE; that camera must be of kind `sim` (checked by a trigger) |
| `runs_on` | TEXT NOT NULL | `CHECK IN ('mac','cluster','pi','pc','cloud','other')` |
| `control_url` | TEXT | its control API (no token: P5) |
| `ui_url` | TEXT | its web UI |
| `image` | TEXT | image or release tag, for information |
| `notes` | TEXT | |

**`proxy_status`** (the latest state; one row per proxy)

| column | type | rules |
|---|---|---|
| `proxy_id` | TEXT PK | FK → proxies ON DELETE CASCADE |
| `connected` | INTEGER NOT NULL | 0/1: a socket is open right now |
| `connected_since`, `last_hello_at`, `last_heartbeat_at` | INTEGER | server times |
| `closed_reason` | TEXT | the last close code and reason, or `bye:<reason>` |
| `proxy_version` | TEXT | from `hello` |
| `clock_skew_ms` | INTEGER | the proxy's `ts` minus server time, from `hello` and from each heartbeat |
| `summary` | TEXT | the last health summary, as JSON, ≤ 192 KiB |
| `summary_at` | INTEGER | its `generatedAt` |
| `ok`, `problem_count` | INTEGER | copied out of the summary for the list views |
| `reported` | TEXT | a JSON object: what the proxy reports about itself and its cameras (§8.6) |

**`status_events`** (state changes, for the history view; no per-heartbeat rows)

| column | type | rules |
|---|---|---|
| `id` | INTEGER PK | |
| `proxy_id` | TEXT NOT NULL | FK → proxies ON DELETE CASCADE |
| `camera_ref` | TEXT | the proxy's camera id, for camera-level events |
| `at` | INTEGER NOT NULL | |
| `kind` | TEXT NOT NULL | `connected`, `disconnected`, `online`, `offline`, `stopped`, `problems-changed`, `camera-online`, `camera-offline`, `version-changed`, `pin-mismatch`, `pin-match` |
| `detail` | TEXT | a small JSON object (≤ 2 KiB) |
| | | an index on `(proxy_id, at)`; rows older than 90 days are pruned daily |

**`audit_log`**

| column | type | rules |
|---|---|---|
| `id` | TEXT PK | `aud_…` (sortable: a time prefix) |
| `at` | INTEGER NOT NULL | |
| `actor_type` | TEXT NOT NULL | `sysadmin`, `proxy`, `system` |
| `actor` | TEXT NOT NULL | an email, a proxy id or `system` |
| `action` | TEXT NOT NULL | from a closed list in code (§11.4), like cam-proxy's `AUDIT_ACTIONS` |
| `account_id` | TEXT | **no FK**: records outlive deleted accounts |
| `target_type`, `target_id` | TEXT | |
| `target_label` | TEXT | the name at the time (e.g. the account name), so a record of a deleted account still says what it was |
| `outcome` | TEXT NOT NULL | `ok`, `refused`, `failed` |
| `detail` | TEXT | JSON ≤ 4 KiB: changed field **names** and non-secret values; never a code, a key, a token or a client IP |
| | | indexes on `at`, `(account_id, at)` and `(action, at)`; pruned after 400 days |

**`sessions`** (system administrator sessions; server-side, §7)

| column | type | rules |
|---|---|---|
| `id_hash` | TEXT PK | SHA-256 of the cookie value (32 random bytes) |
| `email` | TEXT NOT NULL | |
| `created_at`, `expires_at`, `last_seen_at` | INTEGER NOT NULL | |

**`jobs`** (the snapshot job's record): `name` TEXT PK, `last_run_at`,
`last_ok_at`, `last_outcome`, `last_detail`. The dashboard's backup card
reads it.

**`meta`** (one row): `write_epoch` INTEGER, bumped by every write
transaction (restore detection, §11.4). The schema version is kept in
`PRAGMA user_version`, not here.

### 4.2 Deleting

- **Account:** the UI makes the administrator type the account name. The
  delete cascades to users, proxies, keys, codes, cameras, sims, status and
  status events. Before the rows go, every live connection of its proxies is
  closed (4403 `revoked`), and the audit record keeps the account name. A
  restore from backup (§13) is the undo.
- **Proxy:** its keys are revoked, its connection is closed, and its cameras
  stay in the account with no proxy (`proxy_id` NULL), so their cams ids are
  kept.
- **User:** the row is deleted.

## 5. Identity and lookups for later phases

The P4 question "accounts and roles for this email" is one indexed query:

```sql
SELECT a.id, a.name, a.display_name, u.role
FROM account_users u JOIN accounts a ON a.id = u.account_id
WHERE u.email = :normalisedEmail AND u.disabled = 0
ORDER BY a.name;
```

Phase 1 implements it as a tested function (`memberships(email)`). The HTTP
contract for cams is defined in §12 (P4) but not exposed in P1, because
nothing would use it and an unused authenticated endpoint is attack surface.

## 6. Account and role semantics (what P1 records for P4)

- **Account `admin`:** in cams (P4), it may change that account's camera
  settings and use the proxies' admin links. In a later phase, not planned
  yet, it may also manage that account's users in a cams-admin view scoped
  to the account.
- **Account `viewer`:** in cams (P4), it may watch live video, recordings and
  the archive, and change nothing.
- **System administrator:** not a role in any account. It is whoever is in
  `ALLOWED_EMAILS`. A system administrator who also uses cams needs a row in
  each account, like anyone else.
- An account with no `admin` user is allowed; the UI warns about it.

## 7. Authentication of the system administrator

- **Google OAuth** (authorization code flow, scope `openid email`) with its
  own OAuth client, separate from cams's. The redirect URI is
  `https://cams-admin.skylar.technology/auth/google/callback`, plus
  `http://localhost:8090/auth/google/callback` for development. The code
  reuses cams's proven pieces:
  - the state nonce in an httpOnly cookie, compared in constant time;
  - `prompt=select_account`, so that Logout really logs out;
  - the email from the ID token, with `email_verified` required.
- **Allowlist:** `ALLOWED_EMAILS`, comma-separated, normalised like account
  emails. It is re-read and **re-checked on every request** (cams's
  `getAllowedEmails` pattern), so removing an email ends that person's
  access at the next request. A refused sign-in is audited (`signin-refused`)
  without the email, which may be anyone's: the record carries only a
  SHA-256 prefix of it.
- **Session:**
  - **Cookie:** `__Host-cams_admin` (no Domain attribute, `Path=/`, Secure,
    httpOnly, `SameSite=Lax`). It holds 32 random bytes; the database stores
    their hash.
  - **Why `__Host-`:** the prefix stops a sibling `*.skylar.technology` app
    from setting or shadowing the cookie.
  - **Why `Lax`:** the OAuth callback is a top-level redirect, and links from
    Slack must open signed in.
  - **Lifetime:** 12 hours absolute, with no silent renewal; a new Google
    sign-in after that (Klaus 2026-10-06: OK). Logout deletes the row.
  - **Bulk end:** `sessions` rows can be deleted in bulk; the `sessions-ended`
    action does it on demand.
- **CSRF:**
  - Every state-changing request (POST, PUT, PATCH, DELETE under `/api/`)
    must carry `Content-Type: application/json` and the header
    `X-Cams-Admin: 1`. Its `Origin` header, when present, must equal
    `PUBLIC_URL`'s origin (cams's `requireSameOrigin`).
  - A cross-site form can't set the custom header, and a cross-site `fetch`
    with it triggers a CORS preflight that cams-admin never answers.
  - GETs change nothing.
- **Rate limits never key on the client IP** (kube-setup 2026-10-06, a
  binding code requirement with tests). Proxies on the home LAN reach the
  public name by hairpin NAT and all arrive as the router's address, and the
  in-cluster cam-proxy could set any `X-Forwarded-For`. So an address-keyed
  limit would either lock out every LAN proxy at once or be bypassed by a
  forged header. Every limit is keyed on an identity the server has
  validated, or is global:
  - sign-in callbacks: 60 per 15 min **in total** (there is no identity yet;
    the OAuth `state` cookie makes each callback single-use anyway);
  - API writes: 120 per minute **per session**;
  - the proxy-side limits of §8.2 and §8.7: per code hash, per claimed
    `proxyId`, per connection, and global budgets.

  `TRUST_PROXY=1` stays (Traefik), but only for `req.secure` and the
  protocol; the client address is never a limiter key and is never logged. A
  test sends requests with rotating `X-Forwarded-For` values and asserts the
  same budget applies, and another asserts that two "addresses" share no
  budget split.
- **Headers:** a strict CSP (`default-src 'self'`, no inline script),
  `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and HSTS (the
  ingress sets it too).
- **Logging:** never log codes, keys, cookies, tokens or client IPs (cams's
  rule). Detailed payloads go at debug level only.

## 8. The proxy channel protocol (version 1)

### 8.1 Endpoints and versions

| | |
|---|---|
| Enrollment | `POST /proxy/v1/enroll` (HTTPS, JSON) |
| Channel | `GET /proxy/v1/connect` with the WebSocket upgrade, subprotocol `cams-admin.v1` |

- The **path** version (`/proxy/v1/`) changes only if the enrollment or the
  handshake changes incompatibly.
- The **subprotocol** names the envelope version, so a proxy can offer
  `cams-admin.v2, cams-admin.v1` and the server picks the newest it knows. An
  upgrade with no subprotocol the server knows is refused (HTTP 426 with
  `{"error":"unsupported_protocol","supported":["cams-admin.v1"]}`).
- **Within a version, changes are additive:**
  - Receivers ignore unknown fields.
  - An unknown message `type` is answered with `error` `unsupported_type` and
    does not close the connection.
- **Browsers are refused:** an upgrade that carries an `Origin` header is
  refused (403). Node's WebSocket client sends none, so this check rejects
  browsers outright, which closes off cross-site WebSocket tricks.

### 8.2 Enrollment

1. The administrator creates the proxy record (state `pending`), then clicks
   **Create enrollment code**. cams-admin shows the code **once**, together
   with the cams-admin URL and the cam-proxy command to run (§9.2). The code
   looks like `CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B`: a format tag, then 20 Crockford
   base32 characters (100 bits). Input is case-insensitive and ignores
   dashes.
2. The proxy generates an Ed25519 key pair and sends:

   ```json
   POST /proxy/v1/enroll
   { "v": 1,
     "code": "CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B",
     "publicKey": "<base64 SPKI DER>",
     "proof": "<base64 Ed25519 signature over 'cams-admin enroll v1\n' + code + '\n' + publicKey>",
     "proxy": { "version": "v2026.10.06.1", "cameraIds": ["cam1"] } }
   ```

   The body is at most 8 KiB. The proof shows the sender holds the private key
   that matches the public key it registers.
3. cams-admin checks, in one transaction:
   - the code's hash exists, is unused, not cancelled and not expired;
   - its proxy is not `revoked` (a revoked record can't be revived by a stale
     code);
   - the proof verifies.

   It then:
   - marks the code used;
   - revokes any active key of that proxy (`re-enrolled`);
   - stores the new key;
   - sets the proxy to `enrolled`;
   - closes the old key's live connection (4401);
   - writes the audit record (`proxy-enrolled`, actor `proxy`, with the key
     fingerprint).
4. The answer is `201`:

   ```json
   { "v": 1, "proxyId": "prx_…", "keyId": "key_…", "account": "home",
     "connectUrl": "wss://cams-admin.skylar.technology/proxy/v1/connect",
     "serverKeys": ["<base64 SPKI DER of cams-admin's Ed25519 key>"],
     "heartbeatS": 30 }
   ```

- **Errors:** every failure about the code answers the same way, so the
  answer reveals nothing about which codes exist:
  - 400 `bad_request` for a malformed body (also `unsupported_version` when
    `v` is unknown);
  - **401 `invalid_code`** for an unknown, used, cancelled or expired code;
  - 400 `bad_proof` when the proof does not verify;
  - 413 when the body is too large;
  - 429 with `retryAfterS`.

  Each refusal is audited as `enroll-refused`. Unknown codes are throttled in
  the audit log, as cam-proxy throttles `auth-refused`.
- **Rate limits** (never per client address, §7):
  - 5 attempts per normalised code hash per 15 min (a retrying proxy with a
    real code; a typo is a different hash);
  - 100 per 15 min in total. At 100 bits per code, guessing is hopeless
    anyway; the limits keep the audit log readable.
- **Lifetime:** 24 h by default, 7 days at most.

### 8.3 Connection and handshake

```
proxy                                         cams-admin
  ── WSS upgrade, subprotocol cams-admin.v1 ──▶
  ◀── challenge {connId, nonce, serverTime, serverKeyId, sig} ──
  ── hello {proxyId, keyId, connId, nonce, ts, version, capabilities, sig} ──▶
  ◀── welcome {heartbeatS, offlineAfterS, maxMessageBytes, serverTime} ──
  ── heartbeat … (every heartbeatS) ──▶
  ◀── ack {re, nextInS} ──
```

- **`challenge`** (server → proxy, at once):
  - `nonce` is 32 random bytes and `connId` is a fresh id.
  - `sig` is cams-admin's Ed25519 signature over
    `"cams-admin/v1 challenge\n" + connId + "\n" + nonce + "\n" + serverTime`.
  - The proxy checks `sig` against the `serverKeys` it pinned at enrollment.
    A wrong signature closes the connection, and the proxy logs
    `admin_server_untrusted` and backs off (§8.8).
- **`hello`** (proxy → server, within 10 s):
  - `sig` is the proxy's signature over
    `"cams-admin/v1 hello\n" + connId + "\n" + nonce + "\n" + proxyId + "\n" + keyId + "\n" + ts`.
  - **The server checks:**
    - the nonce is the one it sent on **this** connection, less than 10 s
      ago (this is the replay protection: a recorded `hello` is useless on
      any other connection);
    - the key is active, belongs to `proxyId`, and the proxy is `enrolled`;
    - the signature verifies.
  - **The clock is not checked:** `ts` is recorded as skew and is never
    grounds for refusal. A Pi has no real-time clock, and refusing it before
    NTP has synced would keep it dark when it most needs watching. A skew
    over 60 s shows on the dashboard as a problem.
  - `capabilities` is `["status"]` in P1; P3 adds command families.
- **`welcome`** (server → proxy): the connection is live, and the server
  writes `connected` and `status_events` (`connected`; `online` if the proxy
  was offline). It carries `heartbeatS` (30), `offlineAfterS` (90) and
  `maxMessageBytes` (262144).
- **One connection per proxy:** a successful `hello` for a proxy that already
  has a connection closes the older one with 4409 `replaced`, after the new
  one is authenticated, so a stranger can't kick a proxy off.
- **Failures** close the connection with a code:
  - 4400 `bad_message` (malformed JSON, missing fields, a bad `seq`);
  - 4401 `unauthorized` (unknown or revoked key, bad signature, nonce
    mismatch: one code, no detail on the wire; the audit record has the
    reason);
  - 4403 `revoked` (the key was revoked or the account deleted while
    connected);
  - 4408 `timeout` (no `hello` within 10 s);
  - 4409 `replaced`;
  - 4413 `too_large`;
  - 4429 `rate_limited` (with `retryAfterS` in a preceding `error` message);
  - 1001 `going_away` (cams-admin shutting down);
  - 1011 `internal_error`.

### 8.4 The envelope (every message, both directions)

```json
{ "v": 1,
  "type": "heartbeat",
  "id": "01J9Z…",
  "seq": 7,
  "ts": 1791273600000,
  "re": "01J9Y…",
  "body": { },
  "sig": "…" }
```

| field | meaning |
|---|---|
| `v` | the envelope version (integer). A receiver refuses a major version it doesn't know: 4400 for the server; for the proxy, log and reconnect with backoff |
| `type` | the message type (below) |
| `id` | a ULID, unique per sender. For logs and correlation, and the replay key for commands (P3) |
| `seq` | per connection and per direction, starting at 1 and increasing by exactly 1. A gap or a repeat closes the connection (4400) |
| `ts` | the sender's clock, in ms. Informational in P1 |
| `re` | the `id` this message answers (`ack`, `error`, and P3 `result`) |
| `body` | the type's payload, an object |
| `sig` | **required for command-family types** (P3) and for `challenge` and `hello` (whose body carries the signature fields above); absent otherwise in P1 |

**Message types**

- **Phase 1 (implemented):**
  - `challenge`, `hello`, `welcome`;
  - `heartbeat` (proxy → server);
  - `ack` (server → proxy);
  - `error` (both ways: `{code, message, retryAfterS?}`);
  - `bye` (both ways: `{reason}`, e.g. `shutdown`, `restart`, `unenrolled`,
    `server-shutdown`).
- **Reserved for P2/P3 (defined, not implemented):**
  - `command` (server → proxy);
  - `result` (proxy → server);
  - `event` (proxy → server: e.g. an audit record or a config change made on
    the proxy itself);
  - `key.rotate` (proxy → server: a new public key, signed with the old key
    and the new one).

  A P1 proxy answers any of these with `error` `unsupported_type`. A P1
  server answers them with the same error.

**Signed commands (P3; the shape is fixed now)**

- `sig` is the cams-admin key's signature over the canonical JSON (RFC 8785,
  JCS) of the envelope without `sig`.
- The body carries:
  - `proxyId` and `connId` (binding the command to this proxy and this
    connection);
  - `exp` (≤ 60 s after `ts`);
  - `actor` (the email of whoever caused the command, for both audit logs);
  - `command` and `args`.
- **The proxy runs a command only when all of these hold:**
  - the signature verifies against a pinned server key;
  - `proxyId` and `connId` match;
  - `id` is unseen since the connection opened;
  - the command is in the proxy's local allowlist (`camsAdmin.allowCommands`,
    empty by default);
  - `exp` is not past by the proxy's clock (with ±120 s slack).
- Because a command is bound to `connId`, its freshness doesn't rely on clocks
  alone: a replay onto a later connection fails the `connId` check.

### 8.5 Heartbeat

- **When:**
  - right after `welcome`;
  - then every `heartbeatS` (30 s, ±2 s jitter);
  - early when the summary's `ok`, its `problemCount`, or any camera's
    `online` flag changes. An early heartbeat waits for at least 10 s since
    the last one.
- **Body:**

  ```json
  { "summary": { "schema": 1, "generatedAt": …, "version": "…", "ok": true, "problemCount": 0,
                 "items": [ … ], "cameras": [ … ], "disk": { … }, "host": { … }, … },
    "proxy": { "startedAt": …, "uptimeS": …, "configSchema": <n>,
               "tls": { "site": "garage", "caFingerprint": ["SHA256:…"] } | null,
               "publicUrl": "https://…" | null },
    "truncated": false }
  ```

  - `summary` is exactly what `GET /api/local/health` returns (cam-proxy
    `src/health/summary.ts`, `schema: 1`), built by the same function. It is
    the one place with the problem rules, so the dashboard, the proxy's own
    Status page and the Pi's e-paper display never disagree.
  - It already holds no tokens, passwords, FTP settings, PoE-switch host or
    camera serial (its own contract).
  - **`proxy.tls.caFingerprint`** lists the site CA fingerprints as the
    proxy computes them: one entry, or two during a CA rotation. They are
    for comparison only (§8.6).
- **Size:**
  - The proxy keeps a heartbeat under 192 KiB. If the summary is larger, it
    sends `items`, `cameras[].camera` and `cameras[].items` only, with
    `truncated: true`. The summary is a few KiB per camera; the plan measures
    it on the four-camera e2e fixture.
  - The server's `maxPayload` is 256 KiB; a larger frame closes the
    connection with 4413.
- **Validation:**
  - cams-admin checks the summary against its schema-1 shape: types, string
    lengths (≤ 200 characters per text field), and array bounds (≤ 64
    cameras, ≤ 64 items).
  - It stores the result as JSON, and the UI renders every field as text
    (Svelte escapes; no `{@html}`). A compromised proxy can only put wrong
    words on its own card.
  - An unknown `schema` number is stored as "unreadable summary (schema N)"
    and shown as a problem.
- **`ack`:** `{re, nextInS}`. `nextInS` lets the server slow a proxy down
  (30–300), e.g. under load. The proxy uses `max(nextInS, 10)`. The server
  also uses `ack` to confirm the heartbeat was stored. A proxy that sees no
  `ack` for 3 heartbeats in a row closes and reconnects, which catches
  half-open connections. WebSocket ping/pong (every 25 s from the server) is
  a second check.

### 8.6 What the server derives

- **Proxy liveness (server time only):**
  - `online` while a heartbeat arrived within `offlineAfterS` (90 s);
  - `offline` after that, whether or not a socket is still open;
  - `stopped` after a `bye` with `shutdown`/`restart`, until the next
    `hello` (a deliberate stop is not an outage);
  - `never connected` for an enrolled proxy with no `hello` yet;
  - `pending` for a proxy without a key;
  - `revoked`.

  A socket that closes without `bye` marks `connected=0` at once, but the
  proxy stays `online` until 90 s after its last heartbeat. A reconnect within
  that window shows no outage.
- **Camera state:** taken from the last summary's `cameras[]` while the proxy
  is online. While it is offline, every camera behind it shows `unknown`
  (grey), never its last value.
- **Reconciliation (shown, never applied automatically):**
  - *Reported, not registered:* a camera the proxy lists that has no
    `cameras` row with that `proxy_camera_id`. **Add to account** creates the
    row; it proposes `cams_id` = the proxy's id if free, else
    `<proxy name>-<id>`.
  - *Registered, not reported:* a camera row whose `proxy_camera_id` the
    proxy no longer lists.
  - *Pin:*
    - the registered `ca_fingerprints` vs the reported `proxy.tls.caFingerprint`.
      A mismatch is a problem (`pin-mismatch`) and means cams will refuse
      that proxy. The administrator fixes the registry, or the proxy.
    - A proxy with a site CA but no registered pin is shown as a hint.
  - *Version:* the reported `version`; a change is recorded as
    `version-changed`.
- **Transitions** (connected, offline, problems-changed, camera online and
  offline, pin mismatch) go to `status_events`. The browsers learn of them
  over SSE.

### 8.7 Limits (server side)

| limit | value |
|---|---|
| frame size (`maxPayload`) | 256 KiB |
| inbound bytes per connection | 1 MiB per minute, then 4429 |
| messages per connection | 20 per minute. Heartbeats arriving faster than one per 10 s are dropped (counted, not stored); 3 drops in a minute close with 4429 |
| `hello` attempts per proxy id | 6 per minute |
| failed handshakes | 300 per 10 min **in total** (never per source address, §7), then the upgrade answers 429 for 60 s; a failed `hello` also counts against the claimed `proxyId`'s 6 per minute |
| open sockets without a completed `hello` | 50 in total; each must finish within 10 s |
| connections | one per proxy (newest wins after authenticating) |

### 8.8 Reconnect (proxy side)

- **Backoff:** exponential with full jitter: `delay = random(0, min(cap,
  1 s × 2^attempt))`, with a cap of 5 min. `attempt` resets after a
  connection has stayed up for 60 s.
- **By close code:**

  | close | reaction |
  |---|---|
  | 1001, 1012, 1013, network errors | normal backoff |
  | 4409 `replaced` | wait 30 s first. Two proxies sharing one key would otherwise flap, and the log says so (`admin_replaced`) |
  | 4429 | wait `retryAfterS` (default 60 s), then normal backoff |
  | 4401, 4403, server untrusted | state `rejected`; retry every 15 min only, logged once per state change. The proxy's UI says "rejected by cams-admin: re-enroll" |
  | HTTP 426 `unsupported_protocol` | state `incompatible`; retry every 6 h (an upgrade of either side fixes it) |

- **Nothing is queued while disconnected.** Only the latest state matters,
  and the first heartbeat after `welcome` carries it.

### 8.9 Transport security

- `connectUrl` and the enrollment URL must be `https`/`wss`, with normal
  WebPKI verification. cams-admin has a Let's Encrypt certificate through
  cert-manager.
- **Exceptions:** plain `http`/`ws` only for loopback (the Mac test stack)
  and for host names ending in `.svc.cluster.local`.
  - The cluster's cam-proxy has no internet egress (its NetworkPolicy allows
    only cam2 and DNS), so it reaches cams-admin over the cluster Service.
  - Authenticity still holds both ways through the signed challenge and
    `hello`.
  - Confidentiality rests on the cluster network and the NetworkPolicy. The
    heartbeat carries no secrets.
  - **Stated plainly:** the in-cluster path
    `http://cams-admin.cams-admin.svc.cluster.local:8080` is plain HTTP, so
    the cluster proxy's **enrollment code crosses in clear** there, once.
    That is accepted (kube-setup 2026-10-06): the path stays inside the
    cluster behind NetworkPolicies on both ends, the code is one-time and
    short-lived, and what it buys is bounded. Someone who sniffed and
    redeemed it first would make the real proxy's enrollment fail visibly
    (§8.10). After enrollment nothing reusable crosses: every session is
    authenticated by the Ed25519 challenge and `hello` signatures, which a
    sniffer can't replay on another connection.
- Any other plain URL is a config error in cam-proxy.

### 8.10 Revocation and rotation (P1)

- **Revoke** (proxy page → Keys → Revoke):
  - sets `revoked_at` and closes the live connection with 4403;
  - the proxy goes to `rejected`;
  - the proxy record stays `enrolled` with no active key until it is
    re-enrolled, or is set to `revoked` with **Block proxy**, which also
    makes any outstanding code useless.
- **Rotate = re-enroll:** create a new code for the same proxy record. The
  proxy redeems it (§9.2) and gets a new key, and the old key is revoked in
  the same transaction. This is also the fix for a lost key file (a
  reinstalled Pi).
- **Proxy-initiated rotation** over the channel (`key.rotate`) is reserved for
  P3.
- **A leaked enrollment code** is one-time, bound to one proxy record, and
  expires. An attacker who redeems it first gets a key that can only report
  fake status for that one proxy, which:
  - would be visible: the real proxy fails with `invalid_code`, the audit log
    shows the enrollment, and the dashboard shows the key fingerprint, which
    the real proxy's UI would not match;
  - can't receive anything useful in P1.

  From P3 on, the command allowlist on the proxy limits what a hijacked
  record could be told to do, and commands never carry camera passwords.

### 8.11 Threat summary

| threat | answer |
|---|---|
| a database or backup leak | public keys, code hashes (dead codes), emails, roles and status. No secret that reaches a proxy, a camera or cams. The server signing key is in a Secret, not in the database |
| cams-admin compromised (P1) | it can show wrong status and refuse proxies. It can't connect to any proxy (outbound only), and proxies run no commands in P1 |
| cams-admin compromised (P3+) | it can send allow-listed commands to proxies. That is why the list is local to each proxy and empty by default, and why commands are audited on both sides |
| a forged proxy | needs the private key, which only the proxy holds, mode 600 |
| replay | `hello` is bound to a per-connection nonce; `seq` per connection; P3 commands are bound to `connId` plus a seen-id set plus `exp` |
| a proxy flooding cams-admin | the frame, rate and connection limits of §8.7 |
| hostile content in a summary | schema check, length bounds, rendered as text |

## 9. cam-proxy changes

### 9.1 Principle: off unless configured, never in the way

- With no `camsAdmin.url`, cam-proxy behaves exactly as today:
  - no outbound connection;
  - no `data/admin/` folder;
  - no new health item;
  - the Status page's cams-admin card reads "not enrolled".

  The Pi is therefore unchanged until someone enrolls it.
  `test/pi-compat.test.ts` gains this assertion.
- The client is a **leaf module** (`src/fleet/`):
  - It reads the health summary through the same function that serves
    `GET /api/local/health`, at most once per heartbeat. It never calls the
    camera.
  - It holds one socket, one timer and one serialized heartbeat at a time,
    with no queue. Its memory is bounded by the 192 KiB cap.
  - Every handler is wrapped. A thrown error or rejected promise is logged
    (`admin_client_error`, with the stack at debug level only) and turns into
    a reconnect with backoff. It never reaches the process's
    `unhandledRejection` path.
  - DNS, connect and handshake have hard timeouts: 10 s for connect and 10 s
    for `hello`.
- **Shutdown:** on stop, the client sends `bye {reason: 'shutdown'|'restart'}`
  if connected, waits at most 1 s, and closes. It sits in the shutdown order
  before the HTTP server, inside the existing 15 s budget, and does not
  extend it.
- **Failure behaviour:** cams-admin down, slow, unreachable, refusing, or
  answering garbage affects only the cams-admin card and the log lines. The
  stills, events, FTP, SSE and client API carry on. A test (§15.2) runs the
  normal suite with a hostile fake cams-admin attached.
- **Logs:** `admin_connected`, `admin_disconnected`, `admin_rejected` and
  `admin_incompatible` at info, once per state change. Retries and individual
  heartbeats go at debug.

### 9.2 Configuration

```jsonc
"camsAdmin": {
  "url": "https://cams-admin.skylar.technology", // unset = off (the default)
  "keyFile": "admin/key.json",                    // relative to server.dataDir
  "enabled": true,                                // false: keep the key, don't connect
  "allowCommands": []                             // P3; must stay empty in P1 (a load error otherwise)
}
```

- The keys join `SETTINGS` in `src/config/schema.ts` as host-wide settings.
  `npm run schema` regenerates `config.schema.json`, and the config schema
  version bumps.
- They apply at once: changing them restarts the client only.
- `url` must be `https://` (or `http://` for loopback and `*.svc.cluster.local`,
  §8.9).
- The **key file** (`<dataDir>/admin/key.json`, mode 600, folder 700):

  ```json
  { "v": 1, "url": "…", "connectUrl": "…", "proxyId": "prx_…", "keyId": "key_…",
    "privateKey": "<base64 PKCS#8 DER>", "publicKey": "<base64 SPKI DER>",
    "serverKeys": ["…"], "account": "home", "enrolledAt": … }
  ```

  - It is written atomically (temp file + rename). The proxy refuses to use
    it when it is group- or world-readable, or owned by another user (the
    same rule cams applies to `proxy-tls.json`).
  - It is never printed, logged, served or copied into a backup that the UI
    offers for download. `data/admin/` joins the "never print" list in
    cam-proxy's CLAUDE.md, next to `data/tls/ca.key`.
  - Losing it means re-enrolling.

**Enrolling: two ways, same code path (`src/fleet/enroll.ts`)**

- **CLI:**

  ```
  docker compose exec cam-proxy node dist/src/cli.js admin-enroll --url https://cams-admin.skylar.technology
  ```

  - It prompts for the code on stdin, or reads it from a pipe. **Never as an
    argument**, which would leave it in shell history and the process list.
  - It generates the key, redeems the code, writes the key file, and sets
    `camsAdmin.url` in overrides.json (as the Settings page would).
  - The running proxy picks up the change at once.
  - It prints the proxy id, the account and the key fingerprint.
  - `admin-unenroll` reverses it: it sends `bye unenrolled` if connected (the
    server then revokes the key with reason `unenrolled`), deletes the key
    file, and clears the override.
- **Admin UI:** the Status page gets a **cams-admin** card, a sibling of the
  Health and Certificates cards. It shows:
  - the state (off / not enrolled / connecting / connected / rejected /
    incompatible);
  - the URL, the account, the proxy id and the key fingerprint;
  - the last heartbeat sent and the last error.

  Its actions:
  - **Enroll:** a URL field and a code field (a password-type input), sent
    as `POST /control/admin/enroll`;
  - **Reconnect:** `POST /control/admin/reconnect`;
  - **Unenroll:** `POST /control/admin/unenroll`.

  All three need the admin session and the CSRF header (`x-camproxy-ui: 1`),
  like every control write, and go through `can(principal, 'admin')`.
  `GET /control/admin` returns the card's data, with no key material.
- **Audit (cam-proxy):** two new actions in `AUDIT_ACTIONS`, `admin-enroll` and
  `admin-unenroll` (with the outcome; never the code). State changes of the
  connection are log lines, not audit records: they would flood the log
  during an outage.

### 9.3 What it sends, and what it never sends

- **Sends:**
  - the health summary (schema 1, unchanged);
  - `proxy.startedAt`, `uptimeS`, `configSchema`, `publicUrl`;
  - the site CA's fingerprint and site name (public values: cams users copy
    the fingerprint today);
  - its version.
- **Never sends:**
  - tokens (client, admin, audit);
  - camera, FTP or PoE-switch passwords;
  - the CA or leaf private keys;
  - the Vision key;
  - overrides content;
  - clips or stills;
  - event payloads beyond the summary's counters.
- **The guard test:** it sets every secret environment variable to a known
  marker, builds a heartbeat with a fully configured multi-camera fixture, and
  asserts that no marker appears in the serialized JSON. Any future field
  that leaks a secret fails it.

### 9.4 The cluster's proxy

- It is enrolled with `camsAdmin.url`
  `http://cams-admin.cams-admin.svc.cluster.local:8080`.
- This needs kube-setup to add egress from `cam-proxy` to the cams-admin
  pod on 8080, and ingress to cams-admin from `cam-proxy`
  (`docs/kube-setup-request.md`).
- It comes right after the first deployment, as part of enrolling `home`
  (Klaus 2026-10-06).

## 10. Secrets: where they live

| secret | where | in cams-admin? |
|---|---|---|
| camera passwords, cams camera user password | cams Secret / cam-proxy env | **never** |
| cam-proxy client/admin/audit tokens | cam-proxy env, cams Secret | not in P1 (P2: issued here, ruling R2) |
| proxy private key | the proxy's `data/admin/key.json` | never (public key only) |
| enrollment code | shown once | SHA-256 hash only |
| cams-admin signing key (Ed25519) | Secret `cams-admin-signing`, file `SERVER_SIGNING_KEY_FILE` | process memory only; **not** in the database |
| Google OAuth client secret | Secret `cams-admin-oauth` | env |
| S3 credentials | Secret `cams-admin-backup` | env (app snapshot + Litestream) |

- **Signing-key rotation:** `serverKeys` is a list. A new key is added to
  `serverKeys` in a later heartbeat `ack` (P3 detail). In P1 there is one
  key, and replacing it means re-enrolling every proxy, which is acceptable at
  this fleet size and is stated in the runbook.

## 11. API (browser ↔ cams-admin)

All routes are JSON under `/api/v1`, need a system-administrator session, and
answer `{"error": "<code>"}` with 400/401/403/404/409/413/429. Writes follow
§7's CSRF rules. Lists are paged with `?limit=` (≤ 200) and a `cursor`.

### 11.1 Session and live

| method | path | |
|---|---|---|
| GET | `/auth/google/login`, `/auth/google/callback`; POST `/auth/logout` | sign-in and out |
| GET | `/api/v1/me` | `{email, expiresAt}` |
| GET | `/api/v1/dashboard` | every account with its proxies (state, last heartbeat age, ok, problems, version, pin check) and cameras (state, reconciliation), plus the backup card |
| GET | `/api/v1/live` | SSE: `status` events (`{proxyId, state, ok, problemCount, lastHeartbeatAt, cameras:[{ref, online}]}`) on every change and at least every 30 s per online proxy; `registry` events (`{type, id}`) when a row changes, so other open tabs reload it. Heartbeat comment every 25 s. At most 5 streams per session |

### 11.2 Registry

| method | path | |
|---|---|---|
| GET, POST | `/api/v1/accounts` | |
| GET, PATCH, DELETE | `/api/v1/accounts/:accountId` | DELETE needs `{"confirmName": "<name>"}` |
| GET, POST | `/api/v1/accounts/:accountId/users` | POST `{email, displayName?, role}`; 409 `duplicate_email` for the same email in this account |
| PATCH, DELETE | `/api/v1/accounts/:accountId/users/:userId` | |
| GET | `/api/v1/users?email=` | every membership of one email across accounts (the P4 view, for the administrator) |
| GET, POST | `/api/v1/accounts/:accountId/proxies` | |
| GET, PATCH, DELETE | `/api/v1/accounts/:accountId/proxies/:proxyId` | |
| POST | `…/proxies/:proxyId/enrollment-codes` | `{lifetimeH}` → 201 `{code, expiresAt, command}`. **The only time the code is returned** |
| DELETE | `…/proxies/:proxyId/enrollment-codes/:codeId` | cancel |
| GET | `…/proxies/:proxyId/keys` | fingerprints, created, last seen, revoked |
| POST | `…/proxies/:proxyId/keys/:keyId/revoke` | |
| POST | `…/proxies/:proxyId/block` | state `revoked` (§8.10) |
| GET | `…/proxies/:proxyId/status` | the stored summary + derived state |
| GET | `…/proxies/:proxyId/status-events` | paged |
| POST | `…/proxies/:proxyId/adopt` | `{proxyCameraId, camsId?, name?, kind}`: add a reported camera |
| GET, POST | `/api/v1/accounts/:accountId/cameras` | |
| GET, PATCH, DELETE | `/api/v1/accounts/:accountId/cameras/:cameraId` | |
| PUT, DELETE | `…/cameras/:cameraId/sim` | the sim details (camera kind `sim` only) |
| GET | `/api/v1/audit` | filters `account`, `actorType`, `action`, `from`, `to`; newest first |

- Every write is validated with the column rules of §4.
- Errors name the field: `{"error": "invalid", "field": "email"}`.
- Every write records one audit entry in the same transaction.

### 11.3 Proxy-facing and service routes

| method | path | |
|---|---|---|
| POST | `/proxy/v1/enroll` | §8.2 |
| GET (upgrade) | `/proxy/v1/connect` | §8.3 |
| GET, HEAD | `/health` | `{status, version, backup: {lastReplicationAt, lastSnapshotAt}}` (ms or null); no counts and no other database detail. For the release smoke test, the probes and kube-setup's Grafana dead-man alert. **`HEAD /health` answers 200** with no body (UptimeRobot), which a test asserts |

### 11.4 Audit actions (closed list)

| group | actions |
|---|---|
| sign-in | `signin`, `signin-refused`, `signout`, `sessions-ended` |
| registry | `account-create`, `account-update`, `account-delete`, `user-create`, `user-update`, `user-delete`, `proxy-create`, `proxy-update`, `proxy-delete`, `proxy-block`, `camera-create`, `camera-update`, `camera-delete`, `camera-adopt`, `sim-update`, `sim-delete` |
| enrollment and keys | `enrollment-code-create`, `enrollment-code-cancel`, `proxy-enrolled`, `enroll-refused`, `key-revoke`, `proxy-auth-refused` |
| backup and system | `backup-snapshot`, `restore-detected` |
| throttling | `audit-throttled` |

- `proxy-auth-refused` and `enroll-refused` are throttled to one record per
  proxy id (or per source class) per 10 min, with a count, like cam-proxy's.
- `restore-detected` is written at start when the app can tell that the
  database went back in time. Every write transaction bumps a counter in a
  one-row `meta` table, and the app mirrors it into a small file next to the
  database (`cams-admin.epoch`). A database whose counter is lower than the
  file's has been restored. On a fresh volume there is no file and no
  record.

## 12. Phases

**P1 (this spec):** the registry, enrollment, the channel with heartbeats, the
dashboard, the audit log, the backup. In cam-proxy: the `camsAdmin` client,
the CLI and the UI card.

**P2: tokens.**
- cams-admin issues and rotates each proxy's client, admin and audit tokens.
- The first signed command, `tokens.apply`, sends the proxy token hashes over
  the channel. cam-proxy keeps them in a token file it reloads, and keeps the
  old ones for an overlap window (default 24 h). `CAMPROXY_TOKENS` already
  accepts a list.
- cams receives the plaintext through an export of
  `scripts/cameras-config.ts`'s input (download as a file, mode-600
  instructions; the camera passwords stay out) until P4.
- Token plaintext at rest is AES-256-GCM, with a key from a Secret.
- This builds the generic command machinery of §8.4: the allowlist, the
  seen-id set and the double audit.

**P3: remote configuration.**
- `command` types map to cam-proxy's existing control API:
  - `config.get` / `config.set` (whole-object sets, as the real-camera rule
    requires, re-read after writing);
  - `camera.action` (the list of §6.3 in the multi-camera spec);
  - `proxy.restart`;
  - `key.rotate`.
- Each type is allowed per proxy in `camsAdmin.allowCommands`, and audited on
  both sides with the same id and the acting email.
- The UI gets a settings editor per proxy and camera.
- Camera passwords still never pass through.

**P4: cams reads from cams-admin.**
- **API:** a cams service credential (the same Ed25519 pattern: cams enrolls
  with a code) and:
  - `GET /api/service/v1/memberships?email=` →
    `{email, memberships: [{accountId, accountName, displayName, role}]}`;
  - `GET /api/service/v1/accounts/:accountId/config`, which returns
    cameras.json-shaped data without camera passwords.
- **Camera credentials** stay where they are: in cams's Secret, keyed by cams
  camera id. Another option for P4 is cams reaching cameras only through
  their proxies, decided then.
- **Login and roles:**
  - cams caches a snapshot (refreshed every 5 min and on each login), so a
    cams-admin outage never blocks a cams login.
  - After Google sign-in, cams shows an **account picker** when the email has
    more than one membership; the session then carries `accountId` and
    `role`.
  - An account name at login can come later.
  - Roles are enforced in cams (viewer: read-only).
  - Per-account preferences and archive views.
- P1 doesn't block this:
  - memberships are rows keyed by (account, email);
  - accounts have stable ids and names;
  - cameras carry every cams field except secrets.

**P5: deployment.**
- Create and deploy cam-sim instances for an account: in the cluster through a
  kube-setup-approved controller, or on a host through its proxy.
- An installer wizard for a new proxy host:
  - render `host.json` (cam-proxy `scripts/host/render.ts`) from the registry;
  - create the enrollment code;
  - produce the install steps.

## 13. Backup and restore (AWS S3)

### 13.1 Layout

- **Bucket** (kube-setup 2026-10-06): a dedicated bucket
  `klaushofrichter-k3s-cams-admin-backups` in **`us-east-1`**, where the
  cluster's other buckets and the S3 cost alert live. It is never Velero's
  bucket or the hostpath-backups bucket. Klaus creates the bucket, the IAM
  user and its key himself, and the key goes straight into a file. The AWS
  account id never appears in this public repository. The bucket has:
  - **Block Public Access:** all four settings on;
  - **versioning:** on;
  - **default encryption:** SSE-S3 (AES-256). SSE-KMS is possible but adds a
    key policy and per-request cost for no gain here, since access is already
    limited to one IAM principal;
  - **bucket policy:** deny any request with `aws:SecureTransport = false`.
- **Prefixes per environment:**

  ```
  cams-admin/prod/litestream/…           Litestream replica (its own layout)
  cams-admin/prod/snapshots/2026/10/06/cams-admin-20261006T081500Z.sqlite.gz
  cams-admin/dev/…                         optional: a cluster or cloud test instance
  ```

  Local and CI runs use a local S3 (SeaweedFS) and never touch this bucket;
  the first real-bucket check happens at the first deploy, coordinated with
  Klaus.
- **Snapshot retention (Klaus 2026-10-06):** **30 days**, configurable with
  `BACKUP_SNAPSHOT_RETENTION_DAYS` (1–3650). After each successful snapshot
  the app lists `snapshots/` and deletes the objects older than the retention,
  never the newest one, whatever its age.
- **Lifecycle rules:**
  - `snapshots/`: current objects expire after 30 days, the same number as
    the app's default. Raising the retention means raising this rule in the
    same change (Klaus, in the AWS console); the app's pruning alone can't
    keep a snapshot longer than the rule;
  - noncurrent versions (whole bucket): expire 30 days after becoming
    noncurrent;
  - expired object delete markers: removed;
  - incomplete multipart uploads: aborted after 7 days.

  Litestream's own retention (Litestream 0.5.17's top-level `snapshot:`
  block: `interval: 24h`, `retention: 720h`, i.e. 30 days like the
  snapshots; coordinator 2026-10-06) prunes its prefix. With versioning on, a deletion only leaves a noncurrent version
  for 30 days, so a bad or compromised client can't destroy history outright.

### 13.2 IAM (least privilege)

- One IAM user, `cams-admin-backup-prod`, for the cluster now. Later, in a
  cloud, it becomes an IAM role (an instance or workload identity) with the
  same policy and no long-lived keys.
- **Policy** (`BUCKET` stands for the bucket name):

```json
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["cams-admin/prod/", "cams-admin/prod/*"] } } },
    { "Sid": "ObjectsInPrefix", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                 "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::BUCKET/cams-admin/prod/*" } ] }
```

- `BUCKET` is `klaushofrichter-k3s-cams-admin-backups`. The multipart actions
  let Litestream and the SDK clean up an interrupted upload (kube-setup
  2026-10-06).
- The deletes Litestream needs for retention create only delete markers,
  because of versioning.
- No `s3:GetObjectVersion`, `s3:DeleteObjectVersion` or `s3:PutLifecycle*`:
  restoring an old **version** is a manual, Klaus-only operation with his
  own AWS credentials.
- **Credentials** go only in the cluster Secret `cams-admin-backup` (keys
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
  `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`). They are never in the repo or a
  ConfigMap.
- **Rotation:** every 90 days, following kube-setup's
  `docs/api-token-rotation.md`. Two access keys per user allow a gap-free
  swap.
- The same variables drive Litestream and the app's snapshot uploader
  (`@aws-sdk/client-s3`), so a move to a cloud changes the Secret and nothing
  else.

### 13.3 Continuous replication (Litestream)

- Litestream runs as a **native sidecar** (an init container with
  `restartPolicy: Always`; the cluster runs Kubernetes 1.36), pinned by
  digest, with `litestream replicate -config /etc/litestream.yml`. The order
  is: the `restore` init container, then the `litestream` sidecar, then the
  app. Kubernetes stops a native sidecar after the app, so Litestream sees the
  app's last writes; `terminationGracePeriodSeconds: 60` leaves time for its
  final sync. It replicates
  `/var/lib/cams-admin/cams-admin.db` to `s3://klaushofrichter-k3s-cams-admin-backups/cams-admin/prod/litestream`.
- **The window of loss (RPO)** is up to 1 h: Litestream's
  `sync-interval: 1h` (Klaus 2026-10-06: not mission critical yet; S3 cost),
  compactions every 1 h and 24 h (`deploy/litestream.yml`, configurable
  there). That window applies only when the volume itself is lost: a
  graceful stop (Recreate, a node drain) uploads everything, because the
  native sidecar stops after the app and syncs on SIGTERM (checked with
  0.5.17, 2026-10-06). The daily snapshot is independent of it.
- **Writes and S3 cost** (PUTs at $0.005 per 1000; the account alerts at
  $5/month; kube-setup 2026-10-06):
  - The live status (heartbeats, last seen, the current summary) is kept
    **in memory**. SQLite is written only for meaningful changes (a proxy or
    camera going online or offline, problems, version, pin, connect, stop,
    enrollment, registry and audit writes) and by a coarse snapshot of the
    status every 10 min (`STATUS_SNAPSHOT_S`) for the dashboard after a
    restart. A steady fleet writes about 6 transactions an hour.
  - `test/write-budget.test.ts` runs 20 proxies × 4 cameras for a simulated
    hour and asserts at most 8 write transactions.
  - Expected with the hourly sync: under 2,000 PUTs a month (Litestream at
    most 24 syncs a day plus compactions, the daily snapshot and its
    pruning), a few cents.
- **An init container** runs
  `litestream restore -if-db-not-exists -if-replica-exists -o /var/lib/cams-admin/cams-admin.db s3://…`,
  so a fresh volume, such as a new node or a cloud move, comes up with the
  latest state automatically. An existing database is never overwritten. The
  flag names are checked against the pinned Litestream release in the plan.
- Litestream exposes Prometheus metrics on its own port (`addr: ":9090"`).
  The pod carries `k8s.grafana.com/scrape: "true"`,
  `k8s.grafana.com/metrics.portNumber: "9090"` (not `prometheus.io/*`), so
  the cluster's Grafana collects them.
- The app polls the same endpoint over localhost every 30 s
  (`LITESTREAM_METRICS_URL`). It records `lastReplicationAt`: the last time
  it saw Litestream's replication counter advance. The plan pins the metric
  name against the Litestream release. `/health` reports it, together with
  the last successful snapshot, so kube-setup's Grafana dead-man alert can
  watch the backup from outside. The dashboard's backup card shows the same
  numbers.

### 13.4 Daily snapshot

- **When:** at 03:15 in `TZ`, plus on demand from the dashboard.
- **Steps** (run by the app):
  1. `VACUUM INTO '/var/lib/cams-admin/snap/cams-admin-<UTC>.sqlite'`;
  2. open the result read-only and run `PRAGMA integrity_check`, which must
     return `ok`;
  3. gzip it;
  4. PutObject it to the `snapshots/` prefix, with the object's
     `x-amz-checksum-sha256`;
  5. delete the local file;
  6. record the run in `jobs` and in the audit log (`backup-snapshot`, with
     its outcome).
- **Why both:** the snapshot is independent of Litestream's format and
  version, so it is the fallback if a replica is unusable. It is a single
  file Klaus can open with `sqlite3`.
- **Alerts:** a failed snapshot, or none in 26 h, shows red on the dashboard.
  A failed Litestream (lag over 5 min) does too.

### 13.5 Restore procedure (also in `docs/restore.md`, written with the code)

1. **Stop the app:** scale the Deployment to 0 (the release workflow's
   account can't; Klaus or kube-setup does).
2. **Point in time from Litestream:**
   - run `litestream restore -o /tmp/r.db [-timestamp 2026-10-06T08:00:00Z] s3://BUCKET/cams-admin/prod/litestream`
     from a workstation or a one-off pod with the backup Secret;
   - run `sqlite3 /tmp/r.db 'PRAGMA integrity_check'`;
   - move the result into the volume, and remove the old `-wal` and `-shm`
     files.
3. **From a snapshot** (if Litestream's replica is unusable):
   - download the newest `snapshots/…/*.sqlite.gz`, `gunzip` it, run the
     integrity check, and place it the same way;
   - Litestream starts a new generation on the next start.
4. **Start the app.** At start it:
   - checks `user_version` against its migrations; a newer database than the
     code refuses to start;
   - runs the integrity check;
   - logs a `restore-detected` audit entry when it notices one (the epoch
     file, §11.4).
5. **After a restore:**
   - Proxies enrolled after the restore point fail `hello` (unknown key). The
     dashboard lists "refused proxy ids" from the in-memory handshake log, and
     each one needs a new enrollment code.
   - Sessions from before the restore may come back; `sessions-ended` clears
     them.

### 13.6 Tested restore

- **In CI (every PR):** a `restore` step starts a local S3 (SeaweedFS in
  Docker, pinned by digest: MinIO no longer publishes images, checked
  2026-10-06; never the real bucket),
  then runs `scripts/backup/restore-test.sh`:
  1. Start the built app with a Litestream binary (pinned) against
     `s3://restore-test/cams-admin/ci/` on the local S3.
  2. Create accounts, users, proxies and an enrollment through the API.
  3. Trigger a snapshot.
  4. Kill both processes.
  5. Restore into an empty directory, (a) from Litestream and (b) from the
     snapshot.
  6. Compare row counts and a content hash per table with the values recorded
     before the kill, and run the integrity check.
  7. Start the app on each restored copy, and check that a fake proxy with the
     enrolled key passes `hello`.

  It runs as a step of the required `test` job.
- **Against the real bucket:** `scripts/backup/restore-drill.sh` restores the
  production replica to a temporary directory on a workstation and prints the
  same table counts. It only reads from the bucket, and it uses Klaus's own
  AWS credentials, not the app's. Klaus runs it quarterly, or the session runs
  it with his OK. No AWS credentials ever go into GitHub Actions for this
  public repo.

### 13.7 Velero

The cluster's Velero backs up volumes file by file. A live SQLite file copied
that way is not guaranteed consistent, so the cams-admin volume is **not**
annotated for Velero. Litestream and the snapshots are the backup. The
request says so, so that kube-setup doesn't add it by habit.

## 14. Deployment

- **Image:** `ghcr.io/klaushofrichter/cams-admin`, multi-stage, Node 26, user
  1000:1000, read-only root filesystem, `/var/lib/cams-admin` on a PVC. It
  is public on ghcr, like the others, and has no secrets.
- **Workflows** (copied from cams's three-workflow pattern):
  - `production-checks.yml`: `test` (unit + integration + restore test +
    `lint:types` + build), `e2e` (Playwright on GitHub runners, desktop and
    phone) and `codeql`, on every PR to the default branch or `production`.
  - `build-push.yml`: the default branch → `:main`, never deployed.
  - `deploy-production.yml`: a merge to `production` runs on the in-cluster
    runner. It pins the image digest, patches the Deployment, waits for the
    rollout by polling the Deployment's status (the runner may only get,
    watch and patch, so no `kubectl rollout status`; as in cam-sim and
    cam-proxy), and polls `https://cams-admin.skylar.technology/health` until
    it serves the new version. It then holds a WebSocket through the public
    ingress for at least 5 minutes (`scripts/release/ws-hold.ts`, with a canary
    proxy key from a runner Secret; skipped with a warning until that Secret
    exists), which proves that Traefik keeps a long-lived connection. It then
    cuts `vYYYY.MM.DD.N` with notes from
    `## [Unreleased]` in CHANGELOG.md and clears that section, as cams does.
- **Cluster shape** (requested from kube-setup, `docs/kube-setup-request.md`):
  - **Namespaces:** `cams-admin` and `cams-admin-runner`.
  - **Deployment** `cams-admin`: `replicas: 1`, `strategy: Recreate`, the
    restore init container and the Litestream native sidecar (§13.3),
    `terminationGracePeriodSeconds: 60`, and an `emptyDir` `/tmp` (Memory,
    16Mi, as cam-proxy) for the read-only root filesystem.
  - **Not a Knative service:** a WebSocket would be cut at `timeoutSeconds`,
    and scale-to-zero or two revisions would break the single-writer SQLite.
  - **Service:** port 8080.
  - **Volume:** a 1Gi `local-path` PVC; kube-setup patches its PV to
    `Retain` after the first bind.
  - **Ingress:** its own Traefik Ingress in namespace `cams-admin` (not the
    shared knative-gateway Ingress) for `cams-admin.skylar.technology`, with
    a cert-manager Let's Encrypt certificate over HTTP-01
    (`issue-temporary-certificate`). WebSocket upgrades pass through Traefik
    unchanged.
  - **Timeouts:** Traefik's entrypoint `readTimeout` is 60 s. The server
    pings every proxy socket every 25 s and proxies send a heartbeat every
    30 s, so no connection is ever idle for 60 s.
  - **Secrets:**
    - `cams-admin-oauth`: Google client, `ALLOWED_EMAILS`;
    - `cams-admin-signing`: the Ed25519 key;
    - `cams-admin-backup`: S3.

    A `scripts/create-secrets.sh` creates them from a local `.env` without
    printing them.
  - **NetworkPolicy:**
    - ingress from Traefik on 8080, and from the `cam-proxy` pod on 8080;
    - with default-deny ingress, also Traefik (`kube-system`,
      `app.kubernetes.io/name=traefik`) to pods labelled
      `acme.cert-manager.io/http01-solver=true` on 8089, or the certificate
      never issues;
    - egress to DNS, and to TCP 443 at `0.0.0.0/0` except `10.42.0.0/16`,
      `10.43.0.0/16` and `192.168.1.0/24` (Google OAuth and token endpoints,
      S3; NetworkPolicy can't name hosts);
    - in `cam-proxy`: egress to the cams-admin pod on 8080.
  - **Runner:** a repo-scoped `cams-admin-runner` with a `deploy-sa` that may
    get, watch and patch `deployments/cams-admin` only.
- **Public exposure:** cams-admin is internet-facing by design. The proxies
  on the home LAN and in a cloud must reach it. Klaus already approved that
  with the DNS name; the ingress itself goes through kube-setup.
- **Later in a public cloud:**
  1. the same image and Secrets (IAM role instead of keys), any container
     host with one instance and a volume;
  2. the init container restores from the bucket;
  3. DNS moves;
  4. proxies reconnect to the same hostname with the same keys. The server
     signing key moves with its Secret.
- **Environment:**

| variable | default | |
|---|---|---|
| `PORT` | 8080 | |
| `PUBLIC_URL` | required | origin for CSRF, OAuth and `connectUrl` |
| `PROXY_CONNECT_URL` | from `PUBLIC_URL` | override (e.g. the cluster Service URL is given to the cluster proxy by hand) |
| `DB_FILE` | `/var/lib/cams-admin/cams-admin.db` | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | required | |
| `ALLOWED_EMAILS` | required | comma-separated |
| `SERVER_SIGNING_KEY_FILE` | required | PKCS#8 PEM, mode 600; `scripts/gen-signing-key.ts` makes one |
| `TRUST_PROXY` | 1 | |
| `HEARTBEAT_S`, `OFFLINE_AFTER_S` | 30, 90 | the tests set 1 and 3 |
| `ENROLL_CODE_DEFAULT_H` | 24 | |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | unset = no snapshot upload (dev) | |
| `S3_ENDPOINT` | unset | the local S3 (SeaweedFS) for local and CI only |
| `BACKUP_SNAPSHOT_AT` | `03:15` | in `TZ` |
| `BACKUP_SNAPSHOT_RETENTION_DAYS` | 30 | snapshots older than this are deleted after each successful snapshot (§13.1) |
| `LITESTREAM_METRICS_URL` | unset | `http://127.0.0.1:9090/metrics` in the pod; unset = `lastReplicationAt` stays null (dev) |
| `LOG_LEVEL` | info | |

## 15. Testing

### 15.1 cams-admin

- **Unit (vitest):**
  - validation of every column rule;
  - normalisation (emails, fingerprints, codes);
  - `UNIQUE (account_id, email)` and the composite camera→proxy FK, at the
    database level;
  - code lifetime and one-time use, under parallel redemption (two
    concurrent redeems → exactly one 201);
  - Ed25519 sign/verify with fixed test vectors;
  - the handshake state machine (nonce reuse, a nonce from another
    connection, a revoked key, timeouts, `seq` gaps);
  - liveness with a fake clock (offline at exactly `OFFLINE_AFTER_S`; a
    reconnect within the window shows no outage);
  - the rate and size limits;
  - summary validation against hostile input;
  - audit completeness: every write route writes exactly one record (a table
    test over the route list);
  - migrations from an empty database and from each previous version.
- **Integration:**
  - a scripted fake proxy (`test/fakeProxy.ts`) speaks the protocol against
    the real server: enroll, connect, heartbeat, replace, revoke mid-session,
    oversize, flood, `bye`;
  - the restore test (§13.6).
- **Contract test with the real cam-proxy** (see also §15.4 for the shared
  schema), on GitHub Actions only, as cams does with its pinned image:
  - start a cam-sim and the cam-proxy image pinned by tag and digest;
  - enroll it with the CLI against the test server;
  - assert the dashboard API shows its camera online;
  - stop cam-sim and see the camera go offline;
  - stop the proxy and see it go offline.

  It is skipped until the first cam-proxy release with the client exists.
  After that, the pin bump keeps the contract honest.
- **e2e (Playwright)**, desktop 1440×900 and phone 390×844, every element
  with a `data-testid`:
  - the test inserts a `sessions` row and sets the cookie (the
    `dev:session` helper), and a `fakeGoogle` answers the OAuth redirect
    for the sign-in specs, as in cams; real Google is never used;
  - flows: sign-in refused / allowed; create an account, add users
    (duplicate email refused in one account, allowed in another), add a
    proxy, create a code (shown once), a fake proxy enrolls, the dashboard
    turns green live (SSE), the fake proxy stops, it turns grey and then
    offline within `OFFLINE_AFTER_S` (3 s in tests), adopt a reported camera,
    a pin mismatch shows red, revoke a key, delete the account with the typed
    name, and the audit log lists all of it.

### 15.2 cam-proxy

- **Unit:**
  - the key file (mode checks, atomic write, refusal when readable by
    others);
  - enrollment against a fake cams-admin (`test/helpers/fake-admin.ts`);
  - the client's states and backoff with a fake clock and every close code;
  - early heartbeats on a state change, with the 10 s floor;
  - truncation above 192 KiB;
  - the secret-marker guard (§9.3);
  - `allowCommands` non-empty is a load error in P1;
  - any `command` gets `unsupported_type`.
- **Isolation:** the existing stills, events and FTP integration tests run
  with the client attached to a hostile fake cams-admin. Variants: a server
  that accepts and then never reads, one that sends garbage, one that closes
  every second, and one that answers 4401. They pass unchanged, and the
  proxy's event loop lag stays under the existing test budget.
- **Pi compatibility:** `test/pi-compat.test.ts` asserts no `camsAdmin` means
  no socket, no timer and no `data/admin/`.
- **e2e:** the Status page's cams-admin card: enroll, connected, unenroll.

### 15.3 Local stack on the Mac (`scripts/localstack/`)

- **One command** starts:
  - cams-admin (built) on :29000, with a local S3 (SeaweedFS) in Docker as the S3 target;
  - and three accounts:
    - `alpha`: one cam-proxy with two cam-sims;
    - `beta`: two cam-proxies, one with one cam-sim and one with three;
    - `gamma`: one proxy enrolled but stopped (so it shows offline).
- **Processes:** cam-sims run as processes from the cam-sim release tarball.
  cam-proxies run with `node` from a local cam-proxy checkout or its release
  build, on separate ports and data directories.
- **Setup:** it creates the accounts through the API with a local-only
  session. `npm run dev:session -- <email>` inserts a `sessions` row straight
  into the local database file and prints the cookie value. The script
  refuses unless `NODE_ENV=development`, `PUBLIC_URL` is loopback, and the
  email is in `ALLOWED_EMAILS`. The server has no such route. It enrolls each proxy with the CLI, piping in the code.
- **Afterwards** it prints the URLs. `--down` stops everything; its work
  directory is outside the repo, as in cams's livestack.
- **Never on the Mac:** the real camera, the Pi or the cluster.
- **Right after phase 1 ships** (Klaus 2026-10-06): the `home` account,
  enrolling the Pi and the cluster proxy. Klaus allows reconfiguring the Pi
  for it. The Pi needs a cam-proxy release with the client and one enrollment
  (CLI or UI). The cluster proxy needs the kube-setup egress (§9.4).

### 15.4 Proxy monitoring and metrics: the test plan (Klaus's emphasis)

Klaus, 2026-10-06: "Make sure to have good testing for the proxy monitoring
and metric that go to the cams-admin." This section is binding for both
repos. Every test below names the repo it lives in.

**The shared contract (both repos).**
- The wire format is written down once, as JSON Schema (draft 2020-12), in
  cams-admin `contract/v1/`:
  - `envelope.schema.json` (§8.4), one schema per message type
    (`challenge`, `hello`, `welcome`, `heartbeat`, `ack`, `error`, `bye`),
    `enroll-request.schema.json` and `enroll-response.schema.json` (§8.2);
  - `health-summary.schema.json`: cam-proxy's summary, schema 1, every field
    of `HealthSummary` in `src/health/summary.ts` with its type and bounds;
  - `fixtures/`: valid and invalid example messages, one file each, named
    for what they show (`heartbeat-4cam.json`, `heartbeat-truncated.json`,
    `hello-bad-sig.json`, …), plus `vectors.json`: fixed Ed25519 keys,
    nonces and the exact signed strings with their signatures (§8.2, §8.3).
- Each schema has a **strict** variant (`additionalProperties: false`
  everywhere) for tests. The server stays lenient at run time (§8.1: unknown
  fields are ignored), so the strict variant is what catches drift.
- **cams-admin** tests: the server's validator accepts every valid fixture
  and refuses every invalid one with the documented close code or error; the
  validator and the schema agree on a generated corpus (property test: random
  mutations of the valid fixtures, the validator's verdict equals the strict
  schema's for the bound checks it shares); the signature code reproduces
  `vectors.json` byte for byte.
- **cam-proxy** keeps a copy in `test/contract/cams-admin-v1/` (vendored, the
  source commit in a `SOURCE` file) and tests that:
  - the heartbeat it builds from the four-camera fixture, the one-camera Pi
    fixture and a truncated one validates against the **strict** schema. A
    new summary field in cam-proxy therefore fails cam-proxy's own test until
    the contract in cams-admin gains it, and cams-admin then shows it;
  - its `hello`, enrollment request and signatures reproduce `vectors.json`.
- **Drift check:** a cam-proxy CI step fetches `contract/v1/` from
  cams-admin's `main` and fails when the vendored copy differs from it
  without a newer `SOURCE`. cams-admin's CI runs the reverse: a job fetches
  cam-proxy's `main` and builds a heartbeat with its real `buildHealth` from
  its fixture, then validates it against the strict schema. Neither side can
  change the payload alone.

**Protocol conformance (cams-admin, integration, the real server and the
protocol test client of §15.5).**
- Envelope: missing `v`/`type`/`id`/`seq`/`body`; wrong types; an unknown `v`
  (4400); an unknown `type` (`error unsupported_type`, connection stays up);
  unknown extra fields (ignored); `seq` starting at 0, a gap, a repeat
  (4400).
- Versioning: no subprotocol, only unknown ones (426 with the supported
  list), `cams-admin.v2, cams-admin.v1` (server picks v1); a browser
  `Origin` (403).
- Enrollment: valid; used; expired (fake clock at exactly `expires_at`);
  cancelled; a code of a `revoked` proxy; a bad proof; a proof for another
  key; an oversize body (413); `v: 2`; two concurrent redemptions (exactly
  one 201); re-enrollment revokes the old key and closes its live socket
  (4401).
- Key signature: a `hello` signed with the wrong key, a revoked key, another
  proxy's key, a key of a deleted proxy; a challenge signature the client
  must refuse (the test client checks it like cam-proxy will).
- Replay: a recorded `hello` replayed on a new connection; a `hello` with a
  nonce older than 10 s; a `hello` for connection A sent on connection B.
  All 4401, each with the audit reason.
- Size and rate limits: a frame of 256 KiB + 1 (4413); 1 MiB + 1 per minute
  (4429); heartbeats faster than one per 10 s (dropped and counted, the
  third drop in a minute 4429); 7 `hello`s for one `proxyId` in a minute;
  51 sockets that never say `hello`; 301 failed handshakes in 10 min (429).
  **No limit keys on the client address:** the same tests run with
  rotating `X-Forwarded-For` values and get the same results.

**Heartbeat and metric correctness, end to end (cams-admin integration and
e2e).**
- **Every field arrives, is stored and is shown.** A table test walks the
  strict health-summary schema: for every leaf field it sends a heartbeat in
  which that field has a distinctive value, then asserts the value is in
  `proxy_status.summary`, in `GET …/proxies/:id/status`, and (e2e) on the
  proxy page's Live status. A field in the schema with no assertion fails
  the test, so a new field can't be left unshown.
- **Derived values:** `ok`, `problemCount`, per-camera `online`, `version`,
  `clock_skew_ms`, the reconciliation badges and the pin check, from
  heartbeats built to produce each one.
- **Ageing out:** with `OFFLINE_AFTER_S` = 3 and a fake clock (unit) and a
  real one (integration): online at 2.9 s, offline at 3.0 s; cameras turn
  `unknown`, never their last value; an `offline` status event and an SSE
  `status` event arrive; the stored summary stays for the detail page,
  marked stale.
- **Reconnect and backoff:** a socket closed without `bye` keeps the proxy
  online until 90 s (3 s in tests) after its last heartbeat; a reconnect
  inside the window shows no outage and writes `connected` but no
  `offline`; a `bye restart` shows `stopped`, not offline. On the client
  side (the test client here, cam-proxy's client there, §15.2): full-jitter
  backoff bounds, the reset after 60 s up, and the reaction to each close
  code of §8.8.
- **Clock skew:** a proxy 10 minutes behind and 10 minutes ahead is still
  accepted; its skew is stored and shown; over 60 s is a problem on the
  dashboard; `ts` never changes liveness (server time only).
- **Restart of cams-admin:** the stored status survives; proxies show stale
  until they reconnect; then live again without a page reload.

**Fault injection (cams-admin integration and the local stack).**
- cams-admin down, then started: proxies reconnect within the backoff cap
  (test cap: 5 s) and the dashboard recovers on its own.
- cams-admin restarting mid-heartbeat (`1001 going_away`, then gone).
- A network drop (a TCP proxy in the test that blackholes traffic): the
  client notices by the missing `ack` after 3 heartbeats and reconnects;
  the server marks offline by age. A half-open socket is reaped by the
  server's ping/pong.
- A slow link (the same TCP proxy adding 2 s latency and 32 KiB/s): the
  heartbeat still arrives within its interval and nothing is dropped.
- Malformed messages: invalid JSON, a binary frame, a valid envelope with a
  hostile summary (64 KiB strings, 1000 cameras, nested depth 1000, HTML
  and control characters). The server refuses or clamps; the UI renders
  text only (e2e asserts no element was injected).
- A revoked key while connected (4403, then the client's `rejected` state);
  a blocked proxy; a deleted account while its proxies are connected.
- Two proxies with the same key: the newest wins (4409), the other waits
  30 s; over two minutes the dashboard shows at most the expected flaps and
  an audit trail of replacements.

**Load (local, on the Mac; numbers go in the PR).**
- `npm run load -- --proxies 50 --cameras 4 --duration 60m` runs 50
  simulated proxies with 4 cameras each (realistic four-camera summaries,
  heartbeats every 30 s with jitter, and 1 % of heartbeats changing a
  camera's state) against a built cams-admin with a real SQLite file.
- **Pass criteria:** every heartbeat acknowledged; no proxy shown offline
  while it was sending; p99 heartbeat→ack latency under 50 ms; server RSS
  under 200 MiB and flat over the last 30 minutes; the database under
  50 MiB; SSE status events delivered to two dashboard streams for every
  state change; the event loop lag p99 under 20 ms.
- A short variant (`--duration 2m`) runs in CI as part of `test`, with the
  same criteria scaled down.

**The real cam-proxy (once its client is released).** The contract test of
§15.1 (pinned cam-proxy image + cam-sim on GitHub Actions), and the local
stack of §15.3 running real cam-proxies against cams-admin.

### 15.5 Protocol test client (cams-admin)

cams-admin ships its own client of the protocol in `test-client/` (also the
engine of the load test and the release WebSocket check): enroll with a
code, keep the key file, connect, verify the challenge, `hello`, send
heartbeats from a configurable summary generator (N cameras, faults on
demand), honour `ack.nextInS`, reconnect with the §8.8 backoff, and send
`bye`. It is written against the contract, not the server's code, so it is
a second, independent implementation of the protocol.

## 16. UI

Svelte 5 + Vite, with cams's look: its theme tokens are copied and every
colour comes from them. It is desktop-first and usable at phone width.

- **Sign-in page:** the Google button only.
- **Dashboard** (home):
  - **Summary strip:** accounts, proxies online/total, cameras online/total,
    problems, and the backup state (last snapshot age, replica lag).
  - **One card per account:**
    - a row per proxy, with its state chip (online, offline, stopped, never
      connected, pending, rejected), the age of its last heartbeat (ticking),
      its version and problem count;
    - its cameras as small chips (online, offline, unknown, sim marked);
    - badges for "reported, not registered", "registered, not reported" and
      "pin mismatch".
  - A filter for "only problems". Live over SSE, without polling.
- **Accounts list:** name, display name, user, proxy and camera counts, a
  status roll-up, and **New account**.
- **Account page**, in tabs:
  - **Overview:** details (edit), counts, and a warning when there is no
    admin user.
  - **Users:** a table (email, name, role, disabled) with inline add, edit
    and delete. A note shows the other accounts an email belongs to.
  - **Proxies:** a list, and **Add proxy** (the form of §4: runs on, host
    kind, URL, DNS, site, TLS name, fingerprints).
    - **Proxy detail:**
      - the registry fields;
      - **Enrollment:** create a code, shown once in a copy box with the
        CLI command and the UI path, plus its expiry and Cancel;
      - **Keys:** fingerprint, created, last seen, Revoke, and Block proxy;
      - **Live status:** the summary's items rendered like cam-proxy's
        Health card (label, text, problem mark) and per-camera blocks;
      - **Reconciliation**, with **Add to account**;
      - **History:** status events.
  - **Cameras:** a table (cams id, name, kind, proxy, proxy id, live state)
    with add and edit (the §4 fields) and an assign-to-proxy select limited
    to the account's proxies.
  - **Sims:** cameras of kind `sim` with where they run, the control and UI
    URLs, and their live state through their proxy.
- **Audit log:** a paged table with filters (account, actor type, action,
  time); detail JSON in an expandable row.
- **Confirmations:** delete account (typed name), delete proxy, revoke key,
  and block proxy.

## 17. Repository standards (set up with the first code PR)

- **README badge row:** release, PR checks, image build (`?branch=main`),
  deploy (`?branch=production`), and a static Dependabot badge. No version
  numbers in the text.
- **Dependabot:**
  - alerts and security updates turned on via `gh api`;
  - `.github/dependabot.yml` copied from cams (npm, GitHub Actions, Docker);
  - the `dependencies` and `ci` labels.
- **CodeQL** in `production-checks.yml`.
- **Branch protection on `production`:**
  - required checks `test`, `e2e` and `codeql`, strict;
  - `enforce_admins: false`, like cams and cam-proxy (Klaus allows the
    owner's override; it is never flipped without his asking);
  - no force pushes or deletions;
  - no required reviews.
- **Default branch: `main`** (renamed from `develop` on 2026-10-06, Klaus),
  unprotected, as in the Obsidian note *Cluster/Building a New Service*:
  feature branch → PR → `main` → promotion PR → `production` → deploy.
  Repository setting `delete_branch_on_merge: true`.
- **`production`** is created from `main` together with the release workflow
  (the first promotion), and protected as above in the same step. Until then
  there is nothing to protect and no deploy.
- **Repository files:** `CLAUDE.md`, `CHANGELOG.md` (`## [Unreleased]`) and
  `.env.example` (names only). `.superpowers/` is gitignored.
- **Public repo:**
  - no secrets or real tokens;
  - no home addresses, MACs, serial numbers or LAN IP plans;
  - test fixtures use RFC 5737 / RFC 2606 names and addresses;
  - no clips or media.

## 18. Open questions

None. Resolved on 2026-10-06: the default branch is `main` (§17); snapshot
retention is 30 days, configurable (§13.1); the 12-hour session stays (§7);
`home` is enrolled right after phase 1 ships (§15.3); the bucket, region and
IAM additions came from the kube-setup session (§13.1, §13.2).
