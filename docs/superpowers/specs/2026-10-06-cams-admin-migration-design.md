# cams-admin phases 2–4: moving the hard-coded configuration into cams-admin (design)

**Status:** draft for Klaus's review (2026-10-06). Klaus asked: "We will need
to convert the existing hardcoded configuration with the data managed by
cams-admin?" Yes. He pre-approved spec, plan, implementation and deployment;
the open questions (§16) are few and each has a recommended default.
**Builds on:** `2026-10-06-cams-admin-phase1-design.md` (cited as **P1 §n**),
which defines the registry, the proxy channel and the envelope, and sketches
P2–P5 in P1 §12. This spec replaces that sketch for P2, P3 and P4 and
refines it where noted (§3, rulings M1–M9).
**Repos touched:** cams-admin, cam-proxy, cams. cam-sim is unchanged (sims
stay P5). Cluster changes are requests to kube-setup (§12.5).

This repository is public. Nothing below names a LAN address plan, a secret
or a real token; examples use RFC 5737 / RFC 2606 values.

---

## 0. Summary

- Today the fleet's configuration lives in **six kinds of places**: cams's
  `cameras.json` (a Secret in the cluster, a file on the Pi), cams's
  environment (`.env` / Secret `cams-oauth`), cams's data files
  (preferences, proxy switch, TLS pins), cam-proxy's `config.json` +
  `overrides.json`, cam-proxy's environment (`.env` / Secret
  `cam-proxy-secrets`) and the cluster manifests (kube-setup). §1 lists
  **47 items** with file and line.
- After the migration, **cams-admin is the source of truth for who and
  what**: accounts, users and roles, proxies, cameras, the cams↔proxy
  mapping, URLs, TLS names and pins, and the cams↔proxy client tokens (as
  hashes only). **Each proxy stays the source of truth for how it runs**:
  its settings live in its own files; cams-admin edits an allow-listed part
  of them through signed commands. **Secrets that reach a camera, a third
  party or a private key stay local forever** (§2).
- **P2** builds the command machinery (signed, versioned, idempotent,
  audited on both sides, allow-listed on the proxy, with a local kill
  switch) and its first command, `tokens.apply`. **P3** adds remote
  configuration (`config.get`, `config.set` with dry-run and conflict
  check, `config.rollback`, allow-listed camera actions). **P4** makes cams
  read its configuration from cams-admin: a signed service API, a
  per-instance credential, multi-account sessions with an account picker,
  roles, and a signed local cache so cams starts and runs without
  cams-admin (the Pi demo kit offline).
- An **importer** turns today's files into registry rows (dry-run diff,
  idempotent), and a **cut-over** moves each deployment with a one-switch
  rollback (§11). The old files end as a credentials-only file plus an
  on-demand export (§11.6).

## 1. Inventory: every piece of configuration today

Paths are relative to each repo at the commits read on 2026-10-06 (cams
`b453030`, cam-proxy `3eddca1`, cam-sim main, kube-setup main). "Writer" is
who creates or changes the value; "reader" is the code that uses it.

### 1.1 cams

| # | item | where | writer | reader (file:line) | secret? |
|---|---|---|---|---|---|
| C1 | camera list: `id`, `name`, `host` (address, name, or `from-proxy`), `protocol`, `tlsServername`, `webUiUrl`, `webUiNote` | `cameras.json` via `CAMERAS_FILE`; cluster: Secret `cams-cameras` mounted at `/etc/cams` (kube-setup `manifests/cams/cams-ksvc.yaml`); Pi: `/srv/cam-proxy/cams/cameras.json` (`deploy/pi/compose.cams.yaml:32,39`) | Klaus, `scripts/cameras-config.ts` (generator), `scripts/create-camera-user.sh` | `server/cameraRegistry.ts:10-35,57-74,78-134` | no |
| C2 | camera user and password (the `cams` camera user) | the same entries, `user`, `password` | `scripts/create-camera-user.sh`, generator input | `server/cameraRegistry.ts:20-21,123-124` | **yes** |
| C3 | proxy `url` per camera | `cameras.json` `proxy.url` | generator, Klaus | `server/cameraRegistry.ts:37,165-201` | no |
| C4 | proxy client `token` | `cameras.json` `proxy.token` | copied from the proxy's `CAMPROXY_TOKENS` | `server/cameraRegistry.ts:37,184`; group key `server/proxy/groupKey.ts` | **yes** |
| C5 | proxy `adminToken` (sign-in links, camera rename) | `cameras.json` `proxy.adminToken` | copied from `CAMPROXY_ADMIN_TOKEN` | `server/routes/proxy.ts:89-94`, `server/routes/name.ts:26-29,80` | **yes** |
| C6 | proxy `camera` (the proxy's id for the camera) | `cameras.json` `proxy.camera` | generator | `server/cameraRegistry.ts:186` | no |
| C7 | proxy `caFingerprint` (site-CA pins, 1–2) and `tlsServername` | `cameras.json` `proxy.*` | Klaus, copied from the proxy's Certificates card | `server/cameraRegistry.ts:187-193`, group check `:140-163` | no (integrity-critical) |
| C8 | `host: "from-proxy"` (address reported by the proxy) | `cameras.json` | Klaus | `server/cameraRegistry.ts:94,113-116,212-250` | no |
| C9 | generator input: proxies, tokens, camera user per proxy, prefixes | `cameras-config.json` (mode 600, workstation) | Klaus | `server/cameraImport.ts:23-34,110` | **yes** (or `{env}`/`{file}` refs) |
| C10 | `ALLOWED_EMAILS` (who may sign in) | env; cluster Secret `cams-oauth` (`scripts/create-secrets.sh:18-24`) | Klaus | `server/allowedEmails.ts:3-8`, re-checked per request `server/middleware/requireAuth.ts:15-26` | no (personal data) |
| C11 | `COOKIE_SECRET` (signs sessions) | env; Secret `cams-oauth`; Pi `config/.env` (`compose.cams.yaml:29`) | `create-secrets.sh:15-16` keeps an existing one | `server/session.ts:16-22`, `server/config.ts:9` | **yes** |
| C12 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | env; Secret `cams-oauth` | `create-secrets.sh:18-21` | `server/routes/auth.ts:73-75`, `server/googleLogin.ts:26-27`, `server/loginConfig.ts:15-21` | secret: yes |
| C13 | `CAMS_LOGIN_TOKEN` / `CAMS_LOGIN_TOKEN_FILE`, `CAMS_TOKEN_USER` (token sign-in, the Pi) | Pi `config/.env` (`compose.cams.yaml:27-28`) | Klaus | `server/loginConfig.ts:29-71` | **yes** |
| C14 | `COOKIE_SECURE` | env (`false` on the Pi, `compose.cams.yaml:31`) | compose | `server/loginConfig.ts:87-96` | no |
| C15 | per-user preferences (default camera, quality, filters, zoom, keep-alive, notifications), keyed by **email** | `PREFS_FILE` (cluster PVC `cams-data` at `/var/lib/cams`; Pi `./data`) | the app (Settings page) | `server/preferences.ts:44,104-120` | no |
| C16 | the per-camera "use cam-proxy" switch, keyed by camera id | `PROXY_STATE_FILE` or `proxy-state.json` next to prefs | the app (Settings) | `server/proxyState.ts:5-37` | no |
| C17 | verified site CAs and fallback leaf pins, keyed by fingerprint and camera id | `PROXY_TLS_FILE` or `proxy-tls.json` next to prefs | the app (learned over pinned channels) | `server/tls/store.ts:8-50` | no (integrity-critical) |
| C18 | clip cache location and size | `CACHE_DIR`, `CACHE_MAX_BYTES` | manifests / compose | `server/recordings/service.ts:922` | no |
| C19 | runtime knobs: `PORT`, `LOG_LEVEL`, `FFMPEG_PATH`, `WEB_DIST`, retry/probe timings | env | manifests / compose | `server/server.ts:14`, `server/logger.ts:12`, `server/recordings/*` | no |

### 1.2 cam-proxy

| # | item | where | writer | reader (file:line) | secret? |
|---|---|---|---|---|---|
| P1 | host settings (server, go2rtc, stills, previews, events, retention, storage, composition, sse, recordings, ftp, health, host, archive, analytics limits, tls, ntp, camsAdmin) | `config.json` (`CAMPROXY_CONFIG`); cluster: ConfigMap `cam-proxy-config` from `deploy/cluster/config.json`; Pi: `/srv/cam-proxy/data/config.json` | Klaus; ConfigMap applied by kube-setup | schema `src/config/schema.ts:111-251`, load `src/config/load.ts:221-245` | no |
| P2 | per-camera settings (`cameras` list: id, name, host, protocol, tlsName, webUiUrl, user, ports, statusPollS, poeSwitch.port, ftp, stills, storage share, analytics, events) | `config.json` `cameras` | Klaus, `scripts/host/render.ts` (mini PC) | `src/config/schema.ts:63-100,122` | no |
| P3 | overrides of P1/P2 (the Settings page; cameras added in overrides) | `<dataDir>/overrides.json` (mode 600) | the admin UI `PUT/DELETE /control/config` (`src/api/control-api.ts:440-470`), `admin-enroll` (`camsAdmin.url`) | `src/config/load.ts:233-237,171-172` | no |
| P4 | `camsAdmin.url`, `keyFile`, `enabled`; `allowCommands` (must be empty today) | `config.json` / `overrides.json` | `admin-enroll` CLI or Status card | `src/config/schema.ts:243-251`, `src/config/load.ts:157-163` | no |
| P5 | `CAMERA_HOST` (camera address), `PI_ADDRESS` (FTP public host, `server.publicUrl`) | Pi `config/.env` via `CAMPROXY_ENV_FILE`; env wins over every file | Klaus; "Use this address" rewrites `CAMERA_HOST` | `src/config/env.ts:14-15,36-68`, applied `src/config/load.ts:194-208` | no |
| P6 | `CAMPROXY_TOKENS` (client tokens, a list) | env (Pi `config/.env`; cluster Secret `cam-proxy-secrets`) | `scripts/sync-secrets.sh` | `src/config/secrets.ts:31-37`; compared by digest `src/api/auth.ts:6-14,60-66` | **yes** |
| P7 | `CAMPROXY_ADMIN_TOKEN` (admin UI and control API) | env, same places | `sync-secrets.sh` | `src/config/secrets.ts:38-41` | **yes** |
| P8 | `CAMPROXY_AUDIT_TOKEN` (read-only audit) | env, optional | Klaus | `src/config/secrets.ts:56-60` | **yes** |
| P9 | `CAMPROXY_CAMERA_PASSWORD` and per-camera `CAMPROXY_CAMERA_PASSWORD_<ID>` (the proxy's camera user) | env | `sync-secrets.sh`, Klaus | `src/config/secrets.ts:42-51`, `src/config/password-env.ts` | **yes** |
| P10 | `CAMPROXY_FTP_PASSWORD` (camera → proxy FTP login) | env | `sync-secrets.sh` | `src/config/secrets.ts:52-55` | **yes** |
| P11 | `CAMPROXY_GOOGLE_VISION_KEY` (+ runtime override `PUT /control/secrets/google-vision-key`, memory only) | env; runtime | Klaus | `src/config/secrets.ts:61`, `src/api/control-api.ts:392-403` | **yes** |
| P12 | `CAMPROXY_POE_SWITCH_PASSWORD`; switch model, host, ports (`poeSwitch`, `cameras[].poeSwitch.port`) | env; `config.json` | Klaus | `src/config/secrets.ts:62`; `src/config/schema.ts:104-109,125` | password: **yes** |
| P13 | site CA and leaf keys (`tls.site` set) | `<dataDir>/tls/ca.key` and leaves | the proxy itself | multi-camera spec §10.1 | **yes** (private keys) |
| P14 | the proxy's cams-admin key (Ed25519) and pinned server keys | `<dataDir>/admin/key.json` (mode 600) | `admin-enroll` | `src/fleet/keyfile.ts` | **yes** (private key) |
| P15 | `CAMPROXY_TARGET`, `CAMPROXY_LOG_LEVEL`, `CAMPROXY_WEB_DIR`, `CAMPROXY_GOOGLE_VISION_URL` | env / compose | compose, manifests | `src/proxy.ts:82,87`, `src/log.ts:91`, `src/config/secrets.ts:63` | no |
| P16 | host setup for the mini PC (addresses, subnet, DHCP, nftables) | `deploy/host/host.example.json` → rendered files | Klaus, `scripts/host/render.ts` | `deploy/host/*` | no |
| P17 | cluster workload: Deployment, Service, PVC, NetworkPolicy, ingress, certificate | kube-setup `manifests/cam-proxy/*` | kube-setup | Kubernetes | no |
| P18 | cluster Secret `cam-proxy-secrets` (P6, P7, P9, P10) | cluster | the cam-proxy session, `sync-secrets.sh --env-file .env.cluster --only kube` (`deploy/cluster/REQUEST.md:40-43`) | Deployment `envFrom` | **yes** |

### 1.3 cam-sim (unchanged by this spec; listed for completeness)

| # | item | where | reader | secret? |
|---|---|---|---|---|
| S1 | `CAMSIM_USERS` (camera users and passwords) | env / Secret `cam-sim-secrets` | `src/config.ts:109-117` | **yes** |
| S2 | `CAMSIM_CONTROL_TOKEN` | env | `src/config.ts:171` | **yes** |
| S3 | `CAMSIM_FTP_SERVER`, `_USER`, `_PASSWORD`, `_DIR` | env | `src/config.ts:145-154` | password: **yes** |
| S4 | identity and media: `CAMSIM_NAME`, `_FIRMWARE`, `_TZ`, `_MEDIA`, `_VIDEO`, sizes, ports, TLS files | env | `src/config.ts:123-204` | no |
| S5 | the simulated camera's own settings (written through its camera API, like a real camera) | `<CAMSIM_DATA_DIR>/settings.json` | `src/engine/engine.ts:90` | no |
| S6 | cam2 workload and cert-push CronJob | kube-setup `manifests/cam-sim/*` | Kubernetes | — |

### 1.4 Elsewhere

| # | item | where | secret? |
|---|---|---|---|
| E1 | cams cluster workload: ksvc (min = max = 1 scale), PVC `cams-data`, domain mapping | kube-setup `manifests/cams/*` | no |
| E2 | cams's Secrets `cams-oauth`, `cams-cameras`; runner PAT | cluster | **yes** |
| E3 | camera cert pushes (`cam1-cert-push`, `cam2-cert-push`), camera admin credentials Secret | reolink `push_cert.py`, `create-cam-secret.sh`; kube-setup | **yes** |
| E4 | cams-admin's own config (OAuth, `ALLOWED_EMAILS`, signing key, S3) | Secrets `cams-admin-*` | **yes** |
| E5 | the cams-admin registry itself (P1 §4): accounts, users, proxies, cameras, sims, keys | SQLite + S3 | no |
| E6 | the Pi e-paper display: none (it reads `GET /api/local/health`) | — | — |

**Count:** 19 cams items, 18 cam-proxy items, 6 cam-sim items, 6 elsewhere:
**49 rows**, of which 47 are configuration (E5 is the target and E6 holds
none). 23 of them hold secrets.

### 1.5 How secrets flow today

- A proxy's client and admin tokens are **made once** (`sync-secrets.sh`),
  live in the proxy's environment, and are **copied by hand** into cams's
  `cameras.json` (or the generator input), so each one exists in two
  places, plus Klaus's workstation. Rotating one is a manual edit on both
  sides and a restart of both.
- The camera password of the `cams` user lives only in `cameras.json`; the
  proxy's own camera user's password only in the proxy's environment.
- Site-CA pins are copied by a person from the proxy's Certificates card
  into `cameras.json` (never read over the network, on purpose).
- Sign-in: Google + `ALLOWED_EMAILS` in the cluster, a login token on the Pi.
  Everyone allowed sees every camera (there are no accounts or roles).

## 2. Source of truth after the migration

**Rule:** a value lives in cams-admin when it says *who* may do *what* with
*which* camera and proxy, and holds no secret. It stays with the proxy when
it says *how that host runs*. It stays local forever when it is a secret
that reaches a camera, a third party or a private key, or when the Pi must
have it offline.

| value | source of truth | copies | why |
|---|---|---|---|
| accounts, users, roles, memberships | **cams-admin** | cams's signed cache | P1 requirement 4 |
| proxies: name, URL, admin UI URL, TLS name, CA pins | **cams-admin** | cams's cache | one registry; pins entered by a person in cams-admin (P1 §4) |
| per-cams-instance proxy URL (loopback on the Pi) | **cams-admin** (route table, §9.6) | cams's cache | the Pi's cams reaches its proxy at loopback, the cluster's over the LAN |
| cameras: cams id, name, proxy, proxy camera id, `host`, protocol, TLS name, web UI link/note, camera **user name** | **cams-admin** | cams's cache | replaces `cameras.json` minus secrets |
| cams↔proxy client tokens and the cams "managed admin" tokens | **cams-admin** issues and revokes; stores **hashes only** | proxy `data/admin/tokens.json` (hashes); plaintext only in the cams instance that uses it | M1, M2 |
| proxy settings (P1, P2, P3 of §1.2) | **the proxy** (`config.json` + `overrides.json`) | cams-admin keeps the last reported copy and its own command history | the proxy must run stand-alone; cams-admin edits a remote-settable subset (§8.2) |
| `CAMERA_HOST`, `PI_ADDRESS` | **local** (env file) | reported, read-only | "Find camera" on the road must work without internet |
| the proxy's local admin token `CAMPROXY_ADMIN_TOKEN` | **local forever** | none | the break-glass login to a proxy when cams-admin is down or compromised (M2) |
| audit token | **local** | none | no fleet consumer |
| camera passwords (cams user in cams, proxy user in the proxy), cam-sim users | **local forever** | none | P1 requirement 7 |
| FTP password, PoE-switch password | **local forever** | none | they reach a device |
| Google Vision key | **local forever** | none | a paid third-party credential; cams-admin never holds one (M3) |
| site-CA and leaf private keys, the proxy's cams-admin key, cams's instance key | **local forever** | none | private keys never leave their host |
| `COOKIE_SECRET`, Google OAuth client of cams, `CAMS_LOGIN_TOKEN` | **local** per cams instance | none | instance secrets; the Pi's token login must work offline |
| preferences, proxy switch, TLS store | **local** in cams, now keyed by account (§9.5) | none | per-instance state, not configuration |
| cluster workloads, Secrets, NetworkPolicies | **kube-setup** | — | binding rule |
| sims | P5 | — | out of scope |

## 3. Rulings (with reasons)

**M1. cams-admin never stores a token in plaintext.** P1 §12 planned
AES-256-GCM plaintext at rest. This spec drops that:

- In P2 (before cams has an API), cams-admin **generates** a token, shows it
  **once** (like an enrollment code), and keeps only its SHA-256 hash.
- From P4 on, **the cams instance generates** its own token for each proxy
  and registers only the hash. cams-admin relays the hash to the proxy.
- The proxy needs only the hash: it already compares SHA-256 digests in
  constant time (`src/api/auth.ts:6-14`). Tokens are 256 random bits, so a
  plain SHA-256 is enough.
- A database or backup leak then yields no usable token, and there is no
  encryption key to manage. The cost: a lost token is re-issued, never
  re-shown. That is the rotation path anyway.

**M2. The proxy's admin token splits into a local one and managed ones.**

- `CAMPROXY_ADMIN_TOKEN` stays required, local, and unknown to cams-admin:
  Klaus's break-glass login to each proxy.
- cams needs admin rights on a proxy for two things (sign-in links,
  camera rename; §1.1 C5). It gets a **managed admin token** of its own,
  issued like a client token, kind `admin`, separately allow-listed on the
  proxy (`tokens.apply.admin`).
- Revoking cams's managed admin token never locks Klaus out of a proxy.

**M3. The Google Vision key stays local.** cams-admin may set the Vision
*limits* (`analytics.googleVision.*`, §8.2), never the key. A cams-admin
that holds a paid third-party key becomes a target worth attacking, and the
proxy already has a local runtime path for the key.

**M4. Proxy settings stay on the proxy; cams-admin is an editor, not a
store.** cams-admin sends changes as commands and keeps the reported state.
There is no "desired state" loop that re-applies cams-admin's view over
local edits: a local edit wins until someone changes it again, and the
conflict check (§8.4) stops cams-admin from silently overwriting it. This
keeps the Pi correct offline and leaves one writer per file.

**M5. A deny list, compiled into cam-proxy, of things cams-admin can never
change.** It is not a setting, so no command can widen it: `camsAdmin.*`,
every address, port, file path, TLS and trust setting, camera users and
the PoE switch (§8.2). These are the settings a compromised cams-admin
would use to redirect a camera login or open a port.

**M6. Trust-relevant changes from cams-admin are held in cams until an
account admin confirms them** (open question Q1). A proxy URL, a CA pin, a
camera `host` or a TLS name decides where cams sends a camera password.
The first import is confirmed as a whole at cut-over.

**M7. cams↔cams-admin requests and answers are signed** (Ed25519 both
ways), because the cluster path is plain HTTP inside the cluster (as the
proxy channel's, P1 §8.9), and because a signed answer can be cached and
re-verified at every start. The answers carry no secrets (M1), so
confidentiality needs nothing more than the cluster network.

**M8. A cams instance is a registry object** (`cams_instances`), enrolled
with a one-time code like a proxy, and serves a listed set of accounts. The
cluster's cams serves the accounts on `cams.skylar.technology`; the Pi's
cams serves `home`.

**M9. Tokens are per (cams instance, proxy).** The Pi's cams and the
cluster's cams each hold their own token for the Pi's proxy, so revoking one
instance never breaks the other, and the proxy's audit log tells them apart
(token label).

## 4. Architecture after the migration

```
                 cams-admin (cluster)
       registry ─ commands ─ service API ─ audit ─ S3 backup
          ▲  outbound WSS (P1)            ▲  signed HTTPS / in-cluster HTTP (P4)
          │  commands ⇄ results (P2/P3)   │  config pull, token-hash registration
   ┌──────┴───────┬───────────────┐       │
 Pi cam-proxy  mini-PC proxy  cluster proxy   cams (cluster)   cams (Pi)
   ▲   token hashes in data/admin/tokens.json      ▲ signed cache   ▲ signed cache
   └──────────── cams → proxy, direct, client token (unchanged data plane) ──┘
```

- cams-admin is still **not in any data path** (P1 §1). cams talks to every
  proxy directly, as today.
- **When cams-admin is down:** proxies run on their files and token store;
  cams runs on its signed cache. Nothing a camera user does changes. Only
  edits wait.

## 5. Data model additions (cams-admin)

Same conventions as P1 §4 (prefixed ids, ms times, `version`, STRICT).
Migrations are numbered after P1's.

**`commands`** (one row per command, kept 400 days like the audit log)

| column | rules |
|---|---|
| `id` | `cmd_…`; the idempotency key (§7.3), stable across retries |
| `account_id`, `proxy_id` | FKs (proxy ON DELETE SET NULL; the row survives as history) |
| `actor` | sysadmin email, or `system`, or a cams instance id (token registration) |
| `command`, `args` | name from the closed list (§7.6); args JSON ≤ 16 KiB, never a secret (a guard test, §14.1) |
| `dry_run` | 0/1 |
| `state` | `queued`, `sent`, `received`, `done`, `refused`, `failed`, `expired`, `unknown` |
| `outcome_code`, `result` | from the proxy's signed `result` (§7.4), JSON ≤ 64 KiB |
| `result_sig` | the proxy's signature, kept as evidence |
| `created_at`, `sent_at`, `finished_at`, `attempts` | |

**`proxy_tokens`**

| column | rules |
|---|---|
| `id` | `tok_…`; also the label the proxy shows |
| `proxy_id`, `account_id` | FKs; `(account_id, proxy_id)` pair as in `cameras` |
| `kind` | `client` or `admin` |
| `holder` | `manual` (P2, shown once) or a `cams_instance` id (P4) |
| `hash` | `sha256:` + 64 hex; `UNIQUE` |
| `state` | `pending` (not yet on the proxy), `active`, `retiring` (still accepted until `retire_at`), `revoked`, `external` (imported: a token that exists only in the proxy's environment; recorded so the dashboard can show it, never sent, §10.3) |
| `retire_at`, `created_at`, `created_by`, `applied_revision` | |

**`proxy_token_state`** (per proxy): `revision` INTEGER, increased on every
change to the proxy's token set; `applied_revision` as last confirmed by the
proxy.

**`proxy_config`** (per proxy, the last reported configuration):
`revision` (the proxy's `configRevision`, §8.4), `view` (the redacted
`GET /control/config` answer, ≤ 256 KiB), `fetched_at`.

**`cams_instances`**

| column | rules |
|---|---|
| `id` | `cms_…` |
| `name`, `display_name` | as proxies |
| `base_url` | where people open it (`https://cams.skylar.technology`, the Pi's LAN URL); informational |
| `state` | `pending`, `enrolled`, `revoked` |
| `created_at`, `updated_at`, `version` | |

with `cams_instance_keys` (as `proxy_keys`: Ed25519 public key, fingerprint,
one active), `cams_enrollment_codes` (as `enrollment_codes`),
`cams_instance_accounts (instance_id, account_id)` (which accounts it
serves; M8), `cams_instance_routes (instance_id, proxy_id, url)` (a
per-instance proxy URL, §9.6), and `cams_instance_status` (last pull, last
applied revision, held changes, version; in memory with the P1 write
budget).

**`config_revision`** (one row per account): an integer bumped by every
registry write that changes what cams sees (accounts, users, proxies,
routes, cameras, tokens). It is the `ETag` of §9.2.

**Audit actions added** (P1 §11.4's closed list): `command-create`,
`command-result`, `command-expired`, `token-issue`, `token-retire`,
`token-revoke`, `cams-instance-create`, `cams-instance-update`,
`cams-instance-delete`, `cams-enrolled`, `cams-enroll-refused`,
`cams-key-revoke`, `cams-auth-refused`, `route-update`, `import-run`,
`import-apply`, `export-run`. The detail never holds a token, a hash prefix
longer than 8 hex characters, a code or a key.

## 6. Two channels, two directions

| | proxy channel (P1, extended) | cams service API (new, P4) |
|---|---|---|
| who connects | the proxy, outbound WSS | the cams instance, outbound HTTPS (in-cluster HTTP for the cluster's cams) |
| auth | Ed25519 key from enrollment; signed challenge/hello | Ed25519 key from enrollment; every request signed, every answer signed |
| carries | status up; signed commands down; signed results up | registry snapshot down; token hashes and reports up |
| secrets | none (hashes only) | none (hashes only) |

## 7. The command machinery (P2)

### 7.1 Versioning and capabilities

- The envelope stays **v1**: `command`, `result` and `event` were reserved
  in P1 §8.4, so their use is an additive change. The subprotocol stays
  `cams-admin.v1`.
- Each command has its own **args version**: `args.v` (integer). A proxy
  refuses an unknown `args.v` with `unsupported_version`.
- `hello.capabilities` gains `"commands"` from a P2 proxy. The heartbeat's
  `proxy` block gains (contract first, P1 contract rules):

  ```json
  "commands": { "enabled": true, "paused": false, "allow": ["config.get", "tokens.apply"],
                "seenWindow": 1000 },
  "tokens": { "revision": 7 },
  "configRevision": "sha256:…"
  ```

  cams-admin greys out what a proxy doesn't allow, and never sends a
  command to a proxy without the capability (it would only get
  `unsupported_type`).
- New schemas in `contract/v1/`: `command.schema.json`,
  `result.schema.json`, `event.schema.json`, and `commands/<name>.args.json`
  / `commands/<name>.result.json` per command; strict variants and
  fixtures as today. `vectors.json` gains signed command and result
  examples (JCS input, signature) so both sides test the exact bytes.

### 7.2 The command (server → proxy)

```json
{ "v": 1, "type": "command", "id": "01JA…", "seq": 12, "ts": 1791273600000,
  "body": { "proxyId": "prx_…", "connId": "…", "cmdId": "cmd_…", "exp": 1791273660000,
            "actor": "admin@example.org", "command": "config.set",
            "args": { "v": 1, "dryRun": false, "baseRevision": "sha256:…", "set": { … } } },
  "sig": "<Ed25519 over JCS(envelope without sig)>" }
```

- `id` is new per send; `cmdId` is the stable idempotency key (§7.3).
- The proxy runs a command only if **all** of P1 §8.4's checks hold
  (signature against a pinned server key, `proxyId` and `connId` match,
  `id` unseen, `exp` with ±120 s slack, allow-listed) **and**:
  - commands are not paused (§7.7);
  - the rate limits allow it (§7.8);
  - `args` passes the command's strict schema.
- `actor` is copied into the proxy's audit record. It is cams-admin's claim,
  not a proxy-verified identity, and the proxy's UI says "by cams-admin
  (on behalf of …)".

### 7.3 Idempotency

- The proxy keeps a **command journal**, `data/admin/commands.json` (mode
  600): the last 1000 `cmdId`s with their final `result`, for at least 7
  days. It is written before the result is sent.
- A command whose `cmdId` is in the journal is **not run again**: the proxy
  answers with the stored result and `duplicate: true`.
- cams-admin retries a command that got no `received` within 10 s, on the
  same or a later connection, with the same `cmdId` and a fresh envelope
  (new `id`, `connId`, `exp`). After 15 min without a final result the row
  is `unknown`, and the UI says to check the proxy's audit log.
- **Declarative commands are idempotent by content too:** `tokens.apply`
  carries the full token set and a revision; `config.set` carries a base
  revision (§8.4). A replay after a lost journal does no harm.

### 7.4 Results: ack and nack

The proxy answers each command with one or two `result` messages, each
signed with the proxy's key over JCS (as commands are, P1 R3):

1. **`received`** within 2 s, or a **nack**:
   `{cmdId, phase: "received"}` or
   `{cmdId, phase: "done", status: "refused", code}` with `code` one of
   `bad_signature`, `wrong_target`, `expired`, `replayed`, `not_allowed`,
   `paused`, `rate_limited`, `invalid_args`, `unsupported_version`, `busy`.
2. **`done`**: `{cmdId, phase: "done", status: "ok" | "failed" | "conflict",
   code?, result}`, at once for short commands, later for long ones
   (inventory). A `done` that can't be sent because the socket closed is
   sent after the next `welcome` as an `event` `{kind: "command.done", …}`,
   signed the same way.

cams-admin verifies each result's signature against the proxy's active key
and stores it with the signature (`commands.result_sig`).

### 7.5 Allow-list on the proxy

- `camsAdmin.allowCommands`: a list of command names (§7.6), **empty by
  default**. P2 removes P1's "must be empty" load error
  (`src/config/load.ts:157-163`) and replaces it with validation against
  the known names.
- It is set **only locally**: in `config.json`, or in `overrides.json` by
  the admin UI (Status → cams-admin card → "Allowed commands", checkboxes
  with a sentence per command saying what it can change) or the CLI
  (`admin-commands allow config.get tokens.apply`). `camsAdmin.*` is on the
  compiled deny list (M5), so `config.set` can never touch it.
- The cams-admin card on the proxy shows the allow-list, the pause switch,
  and the last 20 commands (time, actor, command, outcome), linking to the
  audit log.

### 7.6 The command list (closed, in code on both sides)

| command | phase | maps to (cam-proxy) | changes |
|---|---|---|---|
| `tokens.apply` | P2 | the token store (§10.2) | managed **client** token hashes |
| `tokens.apply.admin` | P2 | the token store | managed **admin** token hashes (a separate allow entry, M2) |
| `config.get` | P3 | `GET /control/config` (`control-api.ts:427`), redacted | nothing |
| `config.set` | P3 | `PUT /control/config` (`control-api.ts:440`) via `applyOverrides` | remote-settable paths only (§8.2) |
| `config.unset` | P3 | `DELETE /control/config/:path` (`:461`) | remote-settable paths only |
| `config.rollback` | P3 | restores the overrides saved by a given `cmdId` (§8.5) | the same paths that command changed |
| `camera.action` | P3 | `POST /control/cameras/:cam/actions/:name` (`:741-742`) | per action, §8.6 |
| `camera.name.set` | P3 | `PUT /control/cameras/:cam/name` (`:382-383`) | the camera's own name (the proxy's existing whole-object path) |
| `proxy.restart` | P3 | the `restart-proxy` action | a restart |

`key.rotate` stays a **proxy → server** message (P1 §8.10), signed with the
old and the new key; it is not a command.

### 7.7 Kill switch

Three local ways to stop every command at once. None of them can be undone
by cams-admin:

- **Pause** (admin UI button, or `admin-commands pause`): writes
  `camsAdmin.commandsPaused: true` to `overrides.json`. Status keeps
  flowing; commands are refused with `paused`.
- **Environment:** `CAMPROXY_ADMIN_COMMANDS=off` wins over every file (the
  env layer of `src/config/env.ts`). For an incident on a host whose files
  you don't trust.
- **Empty allow-list** or `camsAdmin.enabled: false` (no connection at all).

The pause and its reason are in the heartbeat, so the dashboard shows
"commands paused on this proxy".

### 7.8 Rate limits

On the proxy (never keyed on addresses; per proxy, as P1 §7):

- 30 commands per minute and 300 per day in total;
- `config.set` / `config.unset` / `config.rollback`: 6 per minute;
- `tokens.apply*`: 6 per hour;
- `proxy.restart`: 2 per hour;
- `camera.action`: the proxy's existing per-action limiters
  (`actionLimit`, `trustLimit`, `control-api.ts:475-478`) apply unchanged,
  because the command goes through the same handler.

On cams-admin: 60 commands per minute per proxy and the P1 write limit per
session. A command refused for rate limits is `refused` with
`retryAfterS`.

### 7.9 Audit on both sides

- **cam-proxy:** a new action `admin-command` in `AUDIT_ACTIONS`
  (`src/audit/actions.ts:4`), one record per final outcome, with `cmdId`,
  command, `actor`, outcome and the changed setting **names** (values as the
  existing `config-change` record redacts them). Commands that already
  write their own record (a config change, a camera action in `OWN_AUDIT`,
  `control-api.ts:271`) write it too, with `user: "cams-admin"` and the
  `cmdId` in the details, so the existing views show them.
- **cams-admin:** `command-create` when queued, `command-result` when done,
  with the same `cmdId`.
- A refused command (nack) is audited on the proxy (`admin-command`,
  outcome `failure`), throttled like `auth-refused`.

## 8. Remote configuration (P3)

### 8.1 Reading

- `config.get` returns the proxy's `GET /control/config` answer (values,
  sources per path, restart needs) with secrets redacted by the proxy (it
  already redacts by setting name). cams-admin stores it in `proxy_config`.
- It runs on enrollment, after every cams-admin write, and whenever the
  heartbeat's `configRevision` differs from the stored one (a local edit),
  at most once a minute.

### 8.2 What cams-admin may set (remote-settable paths)

A compiled list in cam-proxy (`src/fleet/remote-settable.ts`), mirrored in
the contract so cams-admin's editor shows only these. Everything else is
refused with `not_remote_settable`, whatever the allow-list says.

| may set | never (deny list, M5) |
|---|---|
| `stills.*`, `previews.*` | `server.*` (port, dataDir, logLevel, trustProxy, publicUrl, tls.port) |
| `events.*` | `go2rtc.*` (binary, url, ports) |
| `retention.*` | `ftp.port`, `ftp.passive`, `ftp.tls`, `ftp.publicHost`, `ftp.certFile`, `ftp.keyFile` |
| `storage.*` | `tls.*` (site, cameraCerts, cameraSubnet, proxyAddresses) |
| `composition.concurrent` | `composition.font` (a file path) |
| `sse.*`, `recordings.*`, `health.*`, `host.stats` | `ntp.server` (where cameras get their time) |
| `ftp.enabled`, `ftp.stream`, `ftp.stalledHours`, `ftp.maxGB` | `poeSwitch.*` |
| `archive.*` | `camsAdmin.*` |
| `analytics.kinds.*`, `analytics.googleVision.*` (limits; never the key) | cameras: `host`, `protocol`, `tlsName`, `user`, `onvifPort`, `rtspPort`, `baichuanPort`, `poeSwitch.*`, `ftp.user`, `webUiUrl`; adding or removing a camera |
| cameras: `name`, `statusPollS`, `stills.*`, `ftp.enabled`, `ftp.stream`, `storage.sharePercent`, `analytics.kinds.*`, `events.*` | any path whose source is `env` (refused with `held_by_env`) |

Reason for the right column: each one changes where the proxy connects,
what it trusts, which files it reads, or which ports it opens. A
compromised cams-admin could use them to send a camera login to another
host. Adding a camera stays a local step (it needs a password, which never
passes through cams-admin).

### 8.3 Writing real camera settings

- cams-admin never talks to a camera, and P3 adds **no new camera write**
  to cam-proxy. The only commands that change a camera are the existing
  proxy functions behind `camera.name.set` and the camera actions of §8.6
  (`camera-ftp-setup`, `camera-ntp-set`, `camera-cert-push`).
- Those functions already follow the camera rule: read the whole object,
  change it, **Set the whole object**, **re-read and compare**, **log
  out**. Their `done` result carries the re-read outcome (`verified: true`
  or the mismatching keys). A later camera setting (e.g. a motion zone)
  would be a new proxy function with the same rule and a new command name,
  never a generic "Set" passthrough.

### 8.4 Dry run, diff and conflicts

- **`configRevision`:** the SHA-256 of `overrides.json`'s canonical JSON
  (JCS), reported in every heartbeat and in `config.get`.
- **Dry run:** `config.set` / `config.unset` with `dryRun: true` runs
  `applyOverrides` on a copy and returns the change list the proxy's
  `recordChanges` builds (`control-api.ts:432-439`: path, from, to, restart
  need), writing nothing. The cams-admin editor always runs the dry run
  first and shows the diff with "needs a restart" marks; **Apply** sends the
  same args with `dryRun: false`.
- **Conflict:** every write carries `baseRevision`. If the proxy's current
  revision differs (someone changed a setting locally since cams-admin read
  it), the proxy answers `conflict` with its current revision and the paths
  that differ, and writes nothing. cams-admin reloads (`config.get`) and
  shows the local change next to the intended one; the administrator
  re-applies or drops it. Local edits always win until a person decides
  (M4).
- A path held by the environment (`sources[path] === 'env'`, e.g.
  `CAMERA_HOST`) is refused with `held_by_env` even when dry-running, so the
  diff never promises a change that can't happen.

### 8.5 Rollback

- Before each cams-admin write the proxy saves the previous
  `overrides.json` as `data/admin/overrides.bak-<cmdId>.json` (mode 600,
  the last 20).
- `config.rollback {cmdId}` restores the **paths that command changed** to
  their previous values (not the whole file, so local edits made since are
  kept), with the same conflict check: if any of those paths changed again
  since, it answers `conflict` naming them.
- Locally, the proxy's admin UI lists cams-admin's changes on the cams-admin
  card with **Undo** (the same operation), and the Settings page's
  existing per-setting "reset to default" keeps working.

### 8.6 Camera actions allowed remotely

`camera.action` carries `{camera, action}`. The proxy checks `action`
against a compiled list (independent of the allow-list, which then decides
per entry `camera.action:<name>`):

- **Remote-allowed:** `camera-test`, `onvif-resubscribe`, `camera-ftp-test`,
  `poe-switch-read`, `inventory`, `inventory-cancel`, `retention-run` (dry
  run only), and, as separate allow entries because they disrupt service:
  `restart` (a camera worker), `camera-reboot`, `camera-powercycle`,
  `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`.
- **Never remote:** `find-camera` and `camera-address` (they rewrite
  `CAMERA_HOST`), `camera-trust-clear`, `tls-ca-rotate`,
  `tls-ca-drop-previous`, `archive-clear`, `inventory-repair`,
  `camera-poe-on`. They change trust, delete data, or
  depend on someone standing next to the hardware.

### 8.7 cams-admin UI (P3)

- **Proxy → Settings tab:** the reported settings grouped as on the proxy's
  own Settings page, each with its source (default, file, override, env).
  Remote-settable fields are editable; the rest read-only with the reason.
  "Review changes" shows the dry-run diff; "Apply" sends it; the command
  row then shows received/done.
- **Proxy → Commands tab:** the command history with outcome, actor,
  diff, and **Roll back** for config writes.
- **Camera page:** the remote-allowed actions as buttons (disabled when the
  proxy doesn't allow them), each with a confirmation naming the effect.

## 9. cams reads from cams-admin (P4)

### 9.1 Enrollment of a cams instance

- The sysadmin creates a cams instance in cams-admin (name, served
  accounts, routes) and an enrollment code, as for a proxy (P1 §8.2).
- On the cams host: `node dist/server/cli.js admin-enroll --url <cams-admin>`
  (code on stdin, never an argument). It makes an Ed25519 key pair, redeems
  the code at `POST /cams/v1/enroll`, and writes
  `<data>/admin/key.json` (mode 600, folder 700; refused when readable by
  others, as `proxy-tls.json`). The answer pins cams-admin's server keys.
- In the cluster the command runs once inside the cams pod (`kubectl exec`,
  done by Klaus or kube-setup; the key lands on the `cams-data` PVC). On
  the Pi: `docker compose exec cams …`.
- Loss of the key file = re-enroll (and new tokens, M9).

### 9.2 The service API

All routes under `/cams/v1/`, JSON, ≤ 1 MiB answers.

| method | path | |
|---|---|---|
| POST | `/cams/v1/enroll` | as P1 §8.2, with a `cms_` record |
| GET | `/cams/v1/config` | the snapshot (§9.3); `If-None-Match: <revision>` → 304 |
| POST | `/cams/v1/tokens` | `{proxyId, kind, hash}` → `{tokenId, state: "pending"}`; issues a `tokens.apply` (§10) |
| POST | `/cams/v1/tokens/:tokenId/retire` | old token after a rotation |
| POST | `/cams/v1/report` | `{appliedRevision, held: [...], version, problems: [...]}` for the dashboard, at most every 60 s |

**Request signing** (every call but enroll):

```
X-Cams-Instance: cms_…        X-Cams-Key: key_…
X-Cams-Ts: <ms>               X-Cams-Nonce: <16 random bytes, base64url>
X-Cams-Sig: Ed25519 over "cams-admin/v1 request\n" + method + "\n" + path+query + "\n" + ts + "\n" + nonce + "\n" + sha256(body)
```

- cams-admin checks the key is active and belongs to the instance, the
  signature, `|ts − now| ≤ 300 s`, and that the nonce is unseen within 10
  min. A clock error answers 401 `clock_skew` with a signed `serverTime`,
  and cams retries once with the measured offset (the Pi has no RTC).
- **Every answer is signed:** `X-Cams-Admin-Sig` over
  `"cams-admin/v1 response\n" + status + "\n" + requestNonce + "\n" + sha256(body)`
  with cams-admin's key. cams refuses an unsigned or mismatching answer.
- The `config` body additionally carries its own `sig` over its JCS
  (without `sig`), so the **cached copy** can be verified at every start
  without the request nonce.
- Rate limits: 60 requests per minute per instance; failed signatures 300
  per 10 min in total (as P1 §8.7); never per address.
- **Transport:** `https://cams-admin.skylar.technology` from the Pi; the
  in-cluster Service URL from the cluster's cams (plain HTTP inside the
  cluster, accepted with the same reasoning as P1 §8.9; it needs a
  NetworkPolicy entry, §12.5).

### 9.3 The snapshot

```json
{ "v": 1, "instance": "cms_…", "revision": 42, "generatedAt": …,
  "accounts": [ {
    "id": "acc_…", "name": "home", "displayName": "Home",
    "users": [ { "email": "user@example.org", "role": "admin", "disabled": false } ],
    "proxies": [ { "id": "prx_…", "name": "pi", "url": "http://127.0.0.1:8480",
                   "adminUiUrl": "http://192.0.2.20:8480", "tlsServername": null,
                   "caFingerprints": [], "tokens": [ { "id": "tok_…", "kind": "client", "state": "active" } ] } ],
    "cameras": [ { "id": "cam_…", "camsId": "cam1", "name": "Backyard", "proxyId": "prx_…",
                   "proxyCameraId": "cam1", "host": "from-proxy", "protocol": "https",
                   "tlsServername": "cam1.example.net", "cameraUser": "cams",
                   "webUiUrl": null, "webUiNote": null } ] } ],
  "sig": "…" }
```

- Only the accounts this instance serves. `url` is the route for this
  instance (§9.6), else the proxy's registered URL.
- **No secrets:** no passwords, no tokens, no hashes (token ids and states
  only, so cams knows which of its local tokens are live).
- cams validates the snapshot with the same rules `parseCameras` applies
  today (`server/cameraRegistry.ts:78-134`, group checks `:140-163`), per
  account. A snapshot that fails is not applied, the last good one stays,
  and the problem is reported (`/cams/v1/report`).

### 9.4 The cache and starting without cams-admin

- `CONFIG_SOURCE` = `file` (today's `CAMERAS_FILE`, the default until
  cut-over), `cams-admin`, or `shadow` (reads both, uses the file, logs and
  reports the differences; the cut-over rehearsal, §11).
- In `cams-admin` mode cams keeps the last applied snapshot **verbatim with
  its signature** in `<data>/admin/config-cache.json` (mode 600). At start
  it verifies the signature against the pinned server keys and loads it;
  then it pulls. A cache that fails verification is ignored and logged
  (`config_cache_untrusted`).
- **Pull:** every 60 s with `If-None-Match`, at once after a login, and on
  a `/cams/v1/report` answer that says "changed". A failed pull keeps the
  current snapshot and backs off (as P1 §8.8, cap 5 min).
- **Start with neither cams-admin nor a cache:** cams starts with no
  cameras and says so on the sign-in page; token sign-in still works. That
  happens only on a fresh install that never enrolled.
- **Staleness:** the snapshot is used however old it is (stand-alone
  operation, Klaus's requirement); from 24 h without a successful pull the
  top bar shows "configuration not refreshed since …" to admins (Q2).
- **The Pi demo kit offline:** cams serves `home` from its cache; the
  login token works; the proxy's address on the road still comes from
  cam-proxy (`from-proxy`), which comes from the proxy's local `CAMERA_HOST`
  ("Find camera"). Nothing in the road workflow needs cams-admin.

### 9.5 Multi-account sessions, picker, roles

- **Membership** = a user row of a served account with that email, not
  disabled (P1 §5's query, evaluated on the cached snapshot).
- **After Google sign-in:**
  - no membership → "not authorised" (as an unknown email today);
  - one → signed in to that account;
  - several → the **account picker** (`/app/accounts`): account display
    names and roles; the choice is remembered per browser (a cookie with
    the account id) and offered first next time. "Switch account" sits in
    the user menu.
- **Session cookie:** the signed JWT (`server/session.ts`) gains `acc` (the
  account id). The role is **not** in the cookie: `currentUser()`
  (`server/middleware/requireAuth.ts:15`) re-checks `(email, acc)` against
  the snapshot on every request and takes the role from there, exactly as
  it re-checks `ALLOWED_EMAILS` today. Removing a user or changing a role
  takes effect at the next applied snapshot.
- **Token sign-in (the Pi):** `CAMS_TOKEN_ACCOUNT` (account name; default:
  the only served account, an error when several) and role `admin`. The
  token stays local (§2).
- **Roles in cams:**
  - `viewer`: live video, recordings, Timeline, archive, still checks
    *reading*, own preferences. Nothing else.
  - `admin`: everything cams offers today: camera settings, rename, the
    proxy switch, archive edits, sign-in links into the proxies' admin UIs,
    held-change confirmation (§9.7).
  - Enforcement: every route declares `need: 'viewer' | 'admin'` in one
    table; a test fails for any mutating route (non-GET) or proxy admin
    route without `admin`, and for any route without a declaration.
- An account name typed at login comes later (P1 requirement 4).

### 9.6 Multi-tenancy isolation in cams

cams ids are unique **per account** (P1 §4 `UNIQUE (account_id, cams_id)`),
so two accounts may both have `cam1`. cams today keys everything by camera
id. P4 changes that:

- **Every registry lookup takes the account:** `getCamera(acc, id)`,
  `allCameras(acc)`, and the internal key is `acc/camsId` (or the
  cams-admin `cam_…` id where no URL shows it). Browser URLs keep the cams
  id; the server resolves it within the session's account only.
- **Every file and folder is keyed by account:** preferences
  `{acc: {email: prefs}}` (C15), proxy switch `{acc: {camsId: false}}`
  (C16), fallback leaf pins by `acc/camsId` (C17; CA PEMs stay keyed by
  fingerprint, they are content-addressed), clip cache
  `CACHE_DIR/<acc>/…` (C18).
- **Proxy connections, SSE streams and the browser relay** are per
  account; a relay message carries the account and is delivered only to
  sessions of that account.
- **A proxy in two accounts** is allowed by the registry only if a person
  registers it twice; cams then holds two independent groups (two
  tokens).
- **Tests:** a two-account fixture where both accounts have `cam1` on
  different proxies; every API route is called from each account's session
  and must return only its own data; a source scan fails on a registry or
  store call without an account argument; SSE fan-out is checked with two
  sessions.
- **Routes** (`cams_instance_routes`): a proxy URL for one cams instance,
  e.g. the Pi's cams reaches the Pi's proxy at `http://127.0.0.1:8480`
  while the cluster's cams uses the LAN URL. cams's existing rule applies
  to the result: plain HTTP with a pin only on loopback
  (`server/cameraRegistry.ts:189`).

### 9.7 Held trust changes (M6)

- When a new snapshot changes, for an existing proxy or camera, the proxy
  `url`, `caFingerprints`, `tlsServername`, a camera's `host` or
  `tlsServername`, cams **keeps the old values** for those fields and
  applies everything else.
- Account admins see a banner: "cams-admin changed where cams connects for
  <proxy/camera>: old → new. Confirm / Keep old." Confirm is audited in the
  cams log and reported to cams-admin (`/cams/v1/report`); "Keep old" is
  reported too, and the dashboard shows the instance as diverged.
- New proxies and cameras (no old value) apply at once but stay **without
  credentials** until an admin enters the camera password locally (§9.8),
  which is the confirmation.
- Q1 asks Klaus whether to keep this hold or auto-apply.

### 9.8 Camera credentials in cams

- Camera passwords never come from cams-admin. cams reads them from a
  local **credentials file**, `CAMERA_CREDENTIALS_FILE` (mode 600; cluster:
  the reshaped `cams-camera-credentials` Secret, §12.5):

  ```json
  { "v": 1, "home/cam1": { "user": "cams", "password": "…" } }
  ```

  keyed by `<account name>/<cams id>`. During the transition cams falls
  back to `user`/`password` of the same id in `CAMERAS_FILE` (account
  `home` only).
- An account admin can set a missing password in cams (Settings → Camera →
  "Camera login"), written to the credentials file when it is writable
  (the Pi; a mounted Secret in the cluster is read-only, so the cluster
  shows the command to update the Secret instead).
- The camera user **name** comes from cams-admin (`cameraUser`); a mismatch
  with the credentials file is shown, not guessed.

## 10. Tokens (P2, completed in P4)

### 10.1 Lifecycle

```
issue ──▶ pending ──tokens.apply ok──▶ active ──rotate──▶ retiring ──retire_at──▶ revoked
                └──────────────── revoke ────────────────────────────────▶ revoked
```

- **P2, manual holder:** "Issue client token" on the proxy page →
  cams-admin generates 32 random bytes (base64url, 43 characters), stores
  the hash, shows the token **once** with copy instructions ("put it in
  `cameras-config.json` as this proxy's `token`"), and sends
  `tokens.apply`. It becomes `active` when the proxy confirms.
- **P4, cams holder:** cams generates the token for each proxy of each
  served account that has no active token for this instance, stores it in
  `<data>/admin/tokens.json` (mode 600), registers the hash
  (`POST /cams/v1/tokens`) and uses it once the snapshot lists it `active`.
  Until then it keeps using the old token (from `CAMERAS_FILE` or its
  previous one).
- **Rotation:** issue a new token, wait for `active`, switch, then retire
  the old one (`retiring` for 24 h, configurable 1 h–7 d), then `revoked`.
  cams rotates its tokens every 90 days by itself (configurable), and on
  "Rotate now" in cams-admin (a flag in the snapshot).
- **Revoke:** removes the hash in the next `tokens.apply`; the proxy rejects
  the token from then on.

### 10.2 `tokens.apply` and the proxy's token store

```json
"args": { "v": 1, "revision": 8,
          "tokens": [ { "id": "tok_…", "kind": "client", "hash": "sha256:…", "label": "cams cluster",
                        "retireAt": null } ] }
```

- **Declarative:** the full managed set for this proxy. The proxy applies it
  only if `revision` is higher than its stored one, else answers `ok` with
  `stale: true` and its current revision (idempotent; a replay can't bring
  back a revoked token).
- `kind: "admin"` entries need `tokens.apply.admin` in the allow-list, else
  the whole command is refused with `not_allowed` (all or nothing).
- **Store:** `data/admin/tokens.json` (mode 600, atomic write), hashes,
  ids, labels, kinds, `retireAt`. Reloaded on change; no restart.
- **Auth:** `accessOf` (`src/api/auth.ts:60-66`) accepts, in this order, the
  local admin token, managed admin hashes, local client tokens
  (`CAMPROXY_TOKENS`), managed client hashes, the audit token. A
  `retiring` entry past `retireAt` no longer matches. The audit record of a
  request names the managed token's label, never the hash.
- **Guards:** the proxy refuses a set that contains the digest of its local
  admin, client or audit token (a managed token must never shadow a local
  one), more than 64 entries, or a malformed hash.
- `CAMPROXY_TOKENS` becomes **optional** when the store holds at least one
  active managed client token; it stays accepted (and is the rollback).
  `CAMPROXY_ADMIN_TOKEN` stays required (M2).

### 10.3 Imported and external tokens

The importer (§11.2) records the hash of each token it finds in
`cameras.json` as state `external`: a token cams-admin knows exists but
didn't issue and never sends. It lets the dashboard show "this proxy is
still used with an unmanaged token" until the cut-over retires it (the
proxy's environment value goes away in §11.6).

## 11. Import and cut-over

### 11.1 The export side (cams and cam-proxy)

- **cams** gets `node dist/server/cli.js export-config` (also
  `scripts/export-config.ts`). It loads `CAMERAS_FILE` with the existing
  parser and prints a **redacted** JSON: every field of every camera
  except `password`, with `proxy.token` and `proxy.adminToken` replaced by
  `{"sha256": "…"}`, plus the preference, proxy-switch and TLS-store
  **counts** (not contents). It never prints a secret, so the output may
  leave the host. It runs where the file is: `kubectl exec` in the cams pod
  (Klaus or kube-setup), `docker compose exec cams` on the Pi.
- **cam-proxy** needs nothing new: `config.get` (P3) and the heartbeat
  provide its settings, cameras and pins.

### 11.2 The importer (cams-admin)

`npm run import -- --account home --instance <cms name> --file export.json`
(also an upload on the account page).

- **Dry run by default.** It prints and shows a diff against the registry:
  proxies (matched by registered URL, else by a route, else new), cameras
  (matched by `(account, cams_id)`), routes, `external` token hashes,
  pins. `--apply` writes it in one transaction with an `import-apply`
  audit record.
- **Proxy groups** follow cams's rule: entries with the same `url` and
  token hash are one proxy (`server/proxy/groupKey.ts`).
- **Cross-checks with the live proxies:** each camera's `proxy.camera` must
  be in the proxy's reported camera list, and each pin must equal the
  proxy's reported fingerprint (P1 §8.6). A mismatch is shown and blocks
  `--apply` unless `--accept-mismatch` names it.
- **Idempotent:** a second run with the same file shows "no changes". A run
  never deletes a registry row; a camera missing from the file is listed
  as "in the registry, not in the file".
- The cluster file and the Pi file are imported **separately** into the
  same account `home`: both describe the same cameras (cam1 via the Pi's
  proxy, cam2 via the cluster's proxy) with different proxy URLs, which
  become routes for the Pi's instance.

### 11.3 Rehearsal on the Mac (before any real step)

1. Klaus runs `export-config` in the cluster pod and on the Pi; the
   redacted outputs (no secrets) are copied to the Mac.
2. The local stack (P1 §15.3) starts cams-admin, two cam-proxies and
   cam-sims, and a local cams in `shadow` mode with a **rehearsal
   credentials file** (fake passwords for the cam-sims).
3. The exports are rewritten to point at the local proxies
   (`scripts/rehearse/localize.ts`: URLs → loopback ports, pins → the local
   test CAs) and imported (dry run, apply, apply again = no changes).
4. cams in shadow mode must report **zero differences** between its file
   and the snapshot; then it switches to `cams-admin` mode, restarts with
   cams-admin stopped (cache start), and the cams livestack checks pass
   (`docs/livestack.md` in cams, extended with the multi-account checks).
5. Token rotation end to end on the local proxies; rollback of every step
   of §11.4.
6. Optionally, a restore of the production snapshot into the local stack
   (the tested restore of P1 §13.6) so the import runs against the real
   registry; the AWS credentials stay in `.env`, never printed.

### 11.4 Cut-over, one deployment at a time

Each step has a check and a one-switch rollback. Nothing is removed until
§11.6. Order: proxies first (P2/P3 change nothing for users), then cams.

| step | deployment | what | check | rollback |
|---|---|---|---|---|
| 1 | cluster proxy | release with P2; allow `tokens.apply`, `tokens.apply.admin`; issue a manual client + admin token for the cluster cams; put them in the cluster `cams-cameras` Secret (Klaus / kube-setup) | cams works with the new tokens; proxy audit shows the token label | remove the new tokens from the Secret (the env tokens never stopped working) |
| 2 | Pi proxy | the same for the Pi's proxy, tokens for both cams instances | both cams work | the same; or pause commands on the Pi |
| 3 | cluster proxy, then Pi proxy | release with P3; allow `config.get` only; compare the reported config with the files | the cams-admin Settings tab equals the proxy's own | nothing to undo |
| 4 | cluster proxy, then Pi proxy | allow `config.set` (+ chosen camera actions); one harmless change (e.g. `sse.pingS`), then roll it back from cams-admin | both appear in both audit logs; the file returns to its old revision | `config.rollback`, or pause |
| 5 | cluster cams | release with P4; enroll the instance; import; `CONFIG_SOURCE=shadow` | `/cams/v1/report` shows zero differences for 24 h | set `CONFIG_SOURCE=file` (env change via kube-setup) |
| 6 | Pi cams | the same, with its route to loopback | zero differences; offline start from cache tested on the Pi with the network unplugged | `CONFIG_SOURCE=file` in `config/.env`, `docker compose up -d` |
| 7 | cluster cams | `CONFIG_SOURCE=cams-admin`; confirm the import (held changes); cams registers its own tokens; memberships replace `ALLOWED_EMAILS` | sign-in, picker (with a second test account), viewer role, live, recordings, archive | `CONFIG_SOURCE=file` (cameras.json still there, its tokens still valid) |
| 8 | Pi cams | the same | the demo-kit check list (`docs/pi-demo.md`) offline and online | `CONFIG_SOURCE=file` |

### 11.5 Preferences and local state

At step 7/8, cams moves its existing files into the `home` account on
first start in `cams-admin` mode: preferences `{email: …}` →
`{acc_home: {email: …}}`, the proxy switch and fallback pins likewise.
The old files are kept as `*.pre-accounts.bak`. `CONFIG_SOURCE=file` reads
the old layout again (rollback).

### 11.6 Removing the old files (30 days after step 8, Klaus says go)

- **cams:** `cameras.json` is replaced by the credentials file (§9.8). In
  the cluster the `cams-cameras` Secret becomes `cams-camera-credentials`
  (a kube-setup request). `ALLOWED_EMAILS` is removed from `cams-oauth`
  (cams warns at start if it is set in `cams-admin` mode). The generator
  (`scripts/cameras-config.ts`) stays, now writing the input for an import
  rather than a file cams reads.
- **cam-proxy:** `CAMPROXY_TOKENS` is removed from `config/.env` and
  `cam-proxy-secrets` (`sync-secrets.sh`), the `external` tokens are
  revoked, and cams's old tokens stop working. `CAMPROXY_ADMIN_TOKEN` stays.
- **Kept as an export, forever:** cams-admin's **Export** (per account and
  instance) writes a `cameras.json` without passwords and tokens, plus the
  list of token ids. With the credentials file and a fresh token per proxy
  it brings a cams back in `file` mode if cams-admin is ever lost for good.
  The runbook (`docs/restore.md`) gets that procedure.

## 12. Changes per repository

### 12.1 cams-admin

- Migrations for §5; the command queue and dispatcher (one in flight per
  proxy, retries, expiry); result verification; the P3 editor and history;
  the cams service API with request/response signing; cams enrollment;
  routes; the importer and the export; dashboard rows for cams instances
  (last pull, applied revision, held changes, diverged).
- The contract additions (§7.1), vectors, strict fixtures.
- P1's write budget (`test/write-budget.test.ts`) extended: commands and
  token rows are meaningful writes; cams pulls and reports stay in memory.

### 12.2 cam-proxy

- `src/fleet/commands.ts` (verify, allow-list, pause, limits, journal,
  results), `src/fleet/remote-settable.ts`, the token store and auth
  changes, `configRevision` in the heartbeat, the overrides backups, the
  cams-admin card additions (allow-list, pause, recent commands, Undo), the
  CLI (`admin-commands`), `admin-command` audit action, the
  `CAMPROXY_ADMIN_COMMANDS` env switch.
- Vendored contract update (`test/contract/cams-admin-v1/`).

### 12.3 cams

- `CONFIG_SOURCE`, the cams-admin client (enroll, pull, cache, verify,
  report, token registration), the account-aware registry and stores, the
  picker and switcher, role enforcement, held changes, the credentials
  file, `export-config`, the file migration of §11.5.
- The fake cams-admin for tests (`test/admin/fakeAdmin.ts`), and e2e for
  picker, viewer, held change, offline start.

### 12.4 cam-sim

Nothing. Sims stay P5.

### 12.5 kube-setup requests (one document, `docs/kube-setup-request-p4.md`)

- NetworkPolicy: ingress to cams-admin:8080 from the cams ksvc pods
  (`serving.knative.dev/service: cams` in namespace `cams`), and egress
  from them to it if namespace `cams` gets a default-deny.
- cams ksvc: env `CONFIG_SOURCE` (`shadow`, then `cams-admin`), and
  `CAMS_ADMIN_URL` (the in-cluster Service URL).
- Secret `cams-camera-credentials` (§11.6), replacing `cams-cameras` at the
  end; `ALLOWED_EMAILS` removed from `cams-oauth`.
- No new public host, no LAN port, no broader egress. The cluster
  dependency shrinks: after §11.6, a cluster change is needed only for cams
  itself and its certificate; cameras, proxies, users and tokens change in
  cams-admin.

## 13. Security

### 13.1 Threat model of the command channel

| threat | answer |
|---|---|
| **cams-admin compromised** (server, signing key or a sysadmin session) | It can send only allow-listed commands, only remote-settable paths, never `camsAdmin.*`, addresses, trust or camera users (M5); never a camera password (it holds none); every command is visible in the proxy's audit log and card; a local pause stops it at once and can't be undone remotely (§7.7). It can issue itself a token for proxies that allow `tokens.apply`, which reaches only proxies it can connect to (from the internet: the cluster proxy's ingress); that is why `tokens.apply.admin` is separate and why cams's held-change check exists (M6). |
| a forged command | needs cams-admin's private key (signature over JCS); replay is stopped by `connId` binding, the seen-id set, `exp`, and the `cmdId` journal |
| a replayed `tokens.apply` | declarative with a revision: an older set is never applied |
| a hostile proxy | can only report wrong results for itself; results are schema-checked, rendered as text, and signed by that proxy's key, so a result can't be attributed to another proxy |
| a command flood | proxy and server rate limits (§7.8); one command in flight per proxy |
| a lost or wrong command | idempotent by `cmdId` and by content; `unknown` after 15 min, never silently retried with new content |
| a change racing a local edit | `baseRevision` conflict; local wins until a person decides (M4) |
| a database or backup leak | token **hashes** of 256-bit tokens, public keys, emails, roles, settings without secrets; nothing that opens a proxy, a camera or cams |

### 13.2 Threat model of the cams service API

| threat | answer |
|---|---|
| a forged cams instance | needs its private key; one-time enrollment code |
| a forged or modified snapshot (network, cache file) | signed by cams-admin, verified on receipt and at every start |
| **cams-admin compromised** pointing cams at an attacker's host | trust-relevant changes are held for an account admin (M6); camera passwords stay local and are sent only to a host that passes the existing TLS checks |
| cross-account leak in cams | account id on every lookup and file key; the two-account `cam1` test (§9.6); the role table test |
| a removed user keeps access | re-checked per request against the applied snapshot; delay = the next pull (60 s) while cams-admin is reachable |
| cams-admin down | cams runs on the cache; nothing degrades but edits |

### 13.3 Logging

Tokens, hashes beyond an 8-hex prefix, enrollment codes, keys, cookies,
passwords and client addresses are never logged, in any of the three repos.
The P1 secret-marker guard test (P1 §9.3) is extended to commands, results,
the snapshot, `export-config` output and the importer's diff.

## 14. Testing

### 14.1 Unit and integration

- **cams-admin:** command creation, dispatch, retry and expiry with a fake
  clock; result signature checks; the token lifecycle; the importer
  (dry-run diff, apply, re-apply = no changes, mismatch blocking); the
  service API's request and response signing, clock skew, nonce reuse;
  the snapshot filter (an instance sees only its accounts); the secret
  guard (args and snapshot contain no marker).
- **cam-proxy:** every nack code; the deny list against every schema path
  (a test walks `SETTINGS` and fails for any path not classified as
  remote-settable or denied, so a new setting must be classified); conflict
  and `held_by_env`; rollback of only the changed paths; the journal's
  duplicate answer; pause and the env switch; the token store's guards and
  auth order; `CAMPROXY_TOKENS` optional only with an active managed token.
  The P1 isolation suite runs with a fake cams-admin that **sends hostile
  commands** (bad signatures, replays, denied paths, floods) and must pass
  unchanged.
- **cams:** cache verification (tampered, wrong key, missing); start
  without cams-admin; held changes; the account picker; role enforcement
  table; the two-account isolation fixture; preferences migration and its
  rollback; the credentials file and the `CAMERAS_FILE` fallback.

### 14.2 Contract tests

- Both repos validate the new message and command schemas (lenient at run
  time, strict in tests) and the signed vectors byte for byte.
- cams vendors a `contract/cams-v1/` (service API schemas, snapshot
  schema, signing vectors) the same way cam-proxy vendors the proxy
  contract.

### 14.3 Local stack (cams-admin `scripts/localstack/`, extended)

- Accounts `alpha` (one proxy, two sims), `beta` (**two proxies**, one with
  one sim, one with three: the **multi-camera** proxy), `gamma` (offline
  proxy), as in P1 §15.3.
- **Two cams instances:** `cms-main` serving `alpha` and `beta`, and
  `cms-pi` serving `alpha` with a loopback route.
- A Playwright suite (fake Google, P1's e2e lock) for: the picker for a
  user in `alpha` and `beta`; a viewer who can't change anything; a P3
  change with dry run, apply, conflict (a local edit in between) and
  rollback; a token rotation with no failed request in cams; `cms-pi`
  restarting with cams-admin stopped.

### 14.4 cams livestack

`docs/livestack.md` gains a `cams-admin` scenario: the existing 23 checks
run with cams in `cams-admin` mode, against cam-sim and, briefly and only
with Klaus's go, the real camera (Pi's proxy stopped, as today).

### 14.5 Migration rehearsal

§11.3, run before step 1 and again before step 5, with a written result in
the PR of the cut-over plan.

## 15. Phases and done criteria

| phase | content | done when |
|---|---|---|
| **P2a** command machinery | contract (§7.1), dispatcher, verify, allow-list, pause, limits, journal, double audit; no command enabled anywhere | contract tests green in both repos; hostile-command suite green; released; the Pi and cluster proxies show "commands: none allowed" on the dashboard |
| **P2b** tokens | `tokens.apply(.admin)`, token store, manual issue, rotation, revoke | cut-over steps 1–2 done; both cams instances use managed tokens; the env tokens still work (rollback proven once) |
| **P3** remote configuration | `config.get/set/unset/rollback`, remote-settable list, camera actions, `camera.name.set`, `proxy.restart`, the UI | steps 3–4 done on both proxies; the classification test covers every setting; a camera action with a re-read result shown in cams-admin |
| **P4a** service API | cams instances, enrollment, signing, snapshot, routes, report | local stack: two instances pull signed snapshots; tamper tests green |
| **P4b** cams multi-account | `CONFIG_SOURCE`, cache, picker, roles, isolation, held changes, credentials file, file migration | the cams e2e and isolation tests green; livestack scenario green |
| **P4c** import and cut-over | export, importer, rehearsal, steps 5–8 | 24 h of zero shadow differences per instance, then both switched; Klaus signs in through the picker |
| **P4d** cleanup | §11.6 after 30 days | `CAMPROXY_TOKENS` and `cameras.json` gone from both deployments; the Export path tested by a restore drill on the Mac |

Each phase is its own plan, PRs to `main`, and a release, as in P1.

## 16. Open questions for Klaus

1. **Held trust changes (M6, §9.7).** When cams-admin changes a proxy URL, a
   pin, a camera host or TLS name, should cams hold it until an account
   admin confirms (recommended; one click for you), or apply it at once?
2. **Stale cache (§9.4).** Keep using cams's cached configuration however
   old it is (recommended for the stand-alone Pi), or stop accepting
   **Google** sign-ins after N days without cams-admin (token sign-in
   would keep working)?
3. **Disruptive remote actions (§8.6).** May camera reboot, power-cycle,
   proxy restart and FTP/NTP/cert setup be allow-listed for remote use at
   all (recommended: yes, per proxy, off by default), or stay local only?

## 17. Self-review

- **Requirements covered:** one hostname for several accounts (§9.5,
  M8); the same email in several accounts with a picker (§9.5); admin and
  viewer (§9.5); camera passwords never through cams-admin (§2, §9.8, §13);
  the Pi stand-alone and offline (§9.4, §7.7, §2 `CAMERA_HOST`); cluster
  changes via kube-setup (§12.5); less cluster dependency (§12.5, §11.6).
- **Consistency with P1:** envelope, signatures, rate-limit keys, audit
  style and the "control plane only" rule are unchanged. Deliberate
  refinements: no plaintext token storage (M1, replacing P1 §12's
  AES-GCM), the admin-token split (M2), cams as an enrolled instance with
  signed requests rather than only a credential (M7, M8), per-instance
  tokens (M9).
- **Checked against the code:** cam-proxy already compares token digests
  (so hashes suffice); `allowCommands` is already parsed and rejected when
  non-empty (P2 relaxes it); `PUT /control/config` already records
  per-path changes (the dry-run diff reuses it); camera ids in cams are
  global today (hence §9.6, the largest cams change).
- **Risks:** §9.6 touches many cams modules; the plan for P4b must list
  every map and file keyed by camera id, and the source scan is the
  safety net. The cluster cams is a Knative service with min = max = 1;
  during a rollout two revisions may briefly overlap, so the cache and
  token files are written atomically and token registration is idempotent
  per (instance, proxy).
- **Not in scope:** sims (P5), an installer wizard (P5), an account name at
  login, a cams-admin view for account admins, the overview grid.
- **Public repo check:** no LAN plan, no real ids or tokens, example
  addresses from RFC 5737 / 2606.
