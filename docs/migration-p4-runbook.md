# Migration phase 4: import and cut-over runbook

How cams moves from `cameras.json` + `ALLOWED_EMAILS` to cams-admin, one
deployment at a time, each step with a check and a one-switch rollback
(spec `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md`
§11, cited **M §n**). Plans: `docs/superpowers/plans/2026-10-07-migration-p4-cams-admin.md`
and cams `docs/superpowers/plans/2026-10-07-migration-p4-cams.md`.

This repository is public: no addresses, tokens or real ids here. Examples
use RFC 5737 / RFC 2606 values. The real exports are kept on the Mac's scratch
work dir only, never committed, never pasted into an issue or a chat log.

## Who does what

| who | does |
|---|---|
| Klaus | every step on the Pi (`docker compose …`), every `kubectl exec`, the go for each step, the production sign-in checks |
| kube-setup session | the cluster changes of `docs/kube-setup-request-p4.md` (NetworkPolicy, cams ksvc env) |
| the P4 implementer | the releases, the rehearsal on the Mac, the cams-admin UI steps when Klaus asks (instances, routes, import dry runs), this runbook's log |

Nobody else touches the Pi, the cluster or the camera.

## Before step 5

- [ ] P2 cut-over steps 1–2 are done: both proxies allow `tokens.apply` and `tokens.apply.admin`; the cluster cams and the Pi cams use **managed** client and admin tokens (their hashes are in `proxy_tokens`; that is how the importer matches the proxies, R4-6).
- [ ] cams-admin is released with P4 (service API, importer); cams is released with P4 (still `CONFIG_SOURCE=file` by default: nothing changed for users).
- [ ] Steps 3–4 (P3) are **not** needed (R4-17).
- [ ] The rehearsal (§R) passed and its result is in the log below.
- [ ] In cams-admin, account `home` lists every person who signs in to cams today (`ALLOWED_EMAILS`), Klaus as `admin`: from step 7 the memberships replace `ALLOWED_EMAILS`.
- [ ] A cams-admin backup was taken (`Backup now`) and the restore test is green.

## What stays local forever (never in cams-admin)

| value | where it stays |
|---|---|
| camera passwords (cams's `cams` user, the proxies' camera user) | cams: `cameras.json` now, the credentials file after P4d; the proxy's env |
| FTP password, PoE-switch password, Google Vision key | the proxy's env |
| `CAMPROXY_ADMIN_TOKEN` (break-glass login to each proxy) | the proxy's env |
| private keys: site CA and leaves, the proxy's cams-admin key, cams's instance key | their host's data folder |
| `COOKIE_SECRET`, cams's Google OAuth client, `CAMS_LOGIN_TOKEN` | each cams instance's env |
| cams's own proxy tokens (plaintext) | `<cams data>/admin/tokens.json` (cams-admin keeps hashes) |

## §R Rehearsal on the Mac (M §11.3; before step 5, again before step 7)

1. Klaus runs `export-config` where each file is (no secret in the output; it may leave the host):
   - cluster: `kubectl exec -n cams <cams pod> -- node dist/server/cli.js export-config > export-cluster.json`
   - Pi: `docker compose exec -T cams node dist/server/cli.js export-config > export-pi.json`

   and copies both to the Mac's livestack work dir (`$LIVESTACK_DIR/rehearse/`, mode 600).
2. Localize: `npx tsx scripts/rehearse/localize.ts --in export-cluster.json --map map.json --out local-cluster.json` (and the Pi's). `map.json` maps each real proxy URL to a local stack proxy and its local test CA's fingerprint (`docs/localstack.md`).
3. **cams-admin side** (this repo, `docs/localstack.md` "The rehearsal"): `scripts/localstack/start.sh`, then `npx tsx scripts/rehearse/rehearse.ts …` — P2 tokens, exports, localize, two instances enrolled by the reference cams client, imports (dry run, apply, again = "no changes"; the Pi file routes only its proxy), signed pulls (200/304), shadow comparison 0, cams-held tokens and Rotate now, offline cache check, block. With the real exports: `npm run import -- … --file local-cluster.json` (dry run, then `--apply`, then again).
4. **cams side:** `REHEARSE_EXPORTS=$LIVESTACK_DIR/rehearse scripts/livestack/rehearse-cutover.sh` (cams repo, once cams P4 is on its `main`) — the two-proxy stack, a local cams-admin, two cams instances (`cluster`, `pi`): both cams in `shadow` (zero differences), switched to `cams-admin`, restarted with cams-admin stopped (cache start), the livestack checks, token rotation with a request loop (0 failures), a held change confirmed, and the rollback of every step below.
5. Write the result into the log (date, commits, pass/fail per step).

## The steps (M §11.4, steps 5–8)

### Step 5 — cluster cams: enroll, import, shadow

1. **cams-admin UI:** Instances → New: name `cluster`, display name "Cluster", served accounts `home`. Create an enrollment code (shown once; it also shows cams-admin's server key fingerprint).
2. **kube-setup:** NetworkPolicy cams → cams-admin; ksvc env `CAMS_ADMIN_URL=<in-cluster Service URL>` (no `CONFIG_SOURCE` yet).
3. **Klaus:** `kubectl exec -i -n cams <cams pod> -- node dist/server/cli.js admin-enroll --url $CAMS_ADMIN_URL`, code on stdin. Compare the printed server key fingerprint with the UI. The key lands on the `cams-data` PVC (`/var/lib/cams/admin/key.json`, mode 600).
4. **Klaus:** `export-config` (as §R 1).
5. **cams-admin UI:** account `home` → Import → pick instance `cluster` (the Import tab has no default instance) → the file → Dry run. Decide each camera's name first: the import sets the registry name (what cams shows) to the file's; change it afterwards on the account's Cameras tab → Edit. Expect: both proxies matched **by token**, a route at the registered URL for each (routes are default-deny); cameras `cam1` (Pi proxy) and `cam2` (cluster proxy) new or matching; no mismatch (a mismatch is a stop: find out why before accepting it). Apply. Dry run again: "No changes".
6. **kube-setup:** ksvc env `CONFIG_SOURCE=shadow`.
7. **Check:** the instance page shows mode `shadow`, the applied revision current, **0 shadow differences**, then "zero since …" for **24 h**. cams works as before (it still uses the file).

**Rollback:** `CONFIG_SOURCE=file` (kube-setup), or unset it. Nothing else changed.

### Step 6 — Pi cams: enroll with a loopback route, import, shadow

1. **cams-admin UI:** instance `pi`, served accounts `home`; Routes: the Pi proxy → `http://127.0.0.1:8480`; nothing for the cluster proxy (routes are default-deny: the Pi shows only its camera, as today, R4-3). Enrollment code.
2. **Klaus (Pi):** `config/.env` gains `CAMS_ADMIN_URL=https://<cams-admin public host>` and `CAMS_TOKEN_ACCOUNT=home`; pull the cams release; `docker compose up -d`; then `docker compose exec -T cams node dist/server/cli.js admin-enroll --url https://<cams-admin public host>` with the code on stdin; compare the fingerprint.
3. **Klaus:** `export-config` on the Pi.
4. **cams-admin UI:** Import → pick instance `pi` → the Pi file → Dry run: the Pi proxy matched by token, a route (already set: no change), `cam1: override for pi: host … → "from-proxy", camera user "cams" → "proxy"` (the Pi reaches the camera through its proxy; the cluster keeps the camera's own host and user — the `pi` instance page lists it under Camera overrides); Apply; Dry run again for `pi` **and** for `cluster` (the cluster file): "No changes" both. The dry run must show only `proxy-matched … by token`, a route line, `camera-override` and possibly `kept` lines: no `camera-change`, no `proxy-new`, no `shared-change` mismatch (any of these: stop and find out why). A red "Is this …'s export?" box means the file and the picked instance don't fit: stop and check the instance.
5. **Klaus (Pi):** `CONFIG_SOURCE=shadow` in `config/.env`, `docker compose up -d`.
6. **Check:** 0 shadow differences for 24 h on the `pi` instance page. **Offline start test:** unplug the Pi's network (or block cams-admin), `docker compose restart cams`, token sign-in, live still, recordings — then plug back in.

**Rollback:** `CONFIG_SOURCE=file` in `config/.env`, `docker compose up -d`.

### Step 7 — cluster cams: switch to cams-admin

1. **Prepare the checks:** in cams-admin create account `test` (display "Test") with Klaus as admin and no cameras, served by `cluster` (for the picker).
2. **kube-setup:** ksvc env `CONFIG_SOURCE=cams-admin`.
3. On its first start cams seeds its trust store from `cameras.json` (R4-11), moves preferences, the proxy switch and pins into account `home` (`*.pre-accounts.bak` kept), and registers its own client and admin token for both proxies (they become `active` within a minute; until then it uses the managed P2 tokens from `cameras.json`).
4. **Checks (Klaus):** sign in with Google → the **picker** (Home, Test) → Home: live, recordings, Timeline, archive, a still check, rename a camera and back, the proxy switch, a sign-in link into each proxy's UI. The held-change banner is empty (or shows exactly what Klaus expects; Confirm it). **Viewer check (R4-20):** in cams-admin set Klaus's role in `home` to viewer → within a minute cams hides every admin control and refuses a settings change; set it back to admin. The cams-admin instance page: mode `cams-admin`, tokens `managed 4, legacy 0`, no problems.
5. Remove account `test` from instance `cluster` (or keep it for later picker checks).

**Rollback:** `CONFIG_SOURCE=file`. `cameras.json` is unchanged and its (managed P2) tokens still work; file mode reads the account layout of the moved state files (R4-10), so preferences survive.

### Step 8 — Pi cams: switch to cams-admin

1. **Klaus (Pi):** `CONFIG_SOURCE=cams-admin` in `config/.env`, `docker compose up -d`.
2. **Checks:** the demo-kit checklist of cams `docs/pi-demo.md`, online and then **offline** (network unplugged, cams restarted: token sign-in, live, recordings from the cached configuration; the camera's address from cam-proxy).

**Rollback:** `CONFIG_SOURCE=file`, `docker compose up -d`.

## Later: P4d (30 days after step 8, only when Klaus says go; M §11.6)

Not part of this rollout; listed so nothing is removed early:

- the credentials file / Secret `cams-camera-credentials` replaces `cameras.json` / `cams-cameras` (kube-setup);
- `ALLOWED_EMAILS` removed from `cams-oauth`;
- the P2 manual and imported `external` tokens revoked; `CAMPROXY_TOKENS` removed from both proxies (`CAMPROXY_ADMIN_TOKEN` stays);
- the cams-admin **Export** tested by a restore drill on the Mac (`docs/restore.md`).

## Log

| date | step | commits (cams-admin / cams / cam-proxy) | result | by |
|---|---|---|---|---|
| 2026-10-07 | §R cams-admin side only (synthetic exports, reference cams client; cams P4 not yet on cams `main`) | cams-admin `feat/migration-p4-ui` (`scripts/rehearse/rehearse.ts`) / — / cam-proxy `main` via the bridge | PASS 13/13: tokens, exports + localize, enroll ×2, imports (no changes on the second run, Pi route + hidden proxy), pulls 200/304 verified, shadow 0, cams-held tokens + rotate, offline cache, block | P4 implementer |
| 2026-10-07 | §R cams-admin side again, after the security review fixes (routes default-deny, plan-bound Apply) | cams-admin `feat/migration-p4-ui` / — / cam-proxy `main` via the bridge | PASS 13/13 (the cluster import routes both proxies; the Pi import routes only its own) | P4 implementer |
| | §R rehearsal (before 5) | | | |
| | 5 cluster shadow | | | |
| | 6 Pi shadow | | | |
| | §R rehearsal (before 7) | | | |
| | 7 cluster switched | | | |
| | 8 Pi switched | | | |
