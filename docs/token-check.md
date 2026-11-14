# Credential check (`scripts/token-check`)

A read-only check, run on the sysadmin's Mac, of every credential that
belongs to one account or one host: is each one valid, and do all its copies
agree? It complements the rotation runbook (kept outside this repository):
run it before and after a rotation.

```sh
scripts/token-check --account home        # the account, its proxies and cams instances, the hosts that run them, the Mac's copies
scripts/token-check --host gateway        # one host: its proxy and cams instance
scripts/token-check --all                 # everything in the config; also reports Mac copies that match nothing
scripts/token-check --account home --json # {scope, at, exitCode, lines: [{section, credential, copy, status, reason, fp, severity}]}
```

It prints one line per credential or copy:

```
== proxy gateway
ok       local admin token | mac ~/.config/cam-proxy/gateway-admin-token | sha256:3f1c… | same as the host
unused   CAMPROXY_TOKENS #1 | host gateway | sha256:9a0b… | no holder found (cams uses managed tokens)
mismatch managed client token tok_… (pi) | cams-admin + host gateway | sha256:1234abcd | revoked in cams-admin but live on the proxy
```

| Status | Meaning | Exit |
|---|---|---|
| `ok` | valid, and the copies agree | 0 |
| `unknown` | not checkable from here (named in the reason) | 0 |
| `expiring` | expires within 7 days (`expiringDays`) | 2 |
| `unused` | set but nobody uses it: no holder, a stale copy, a retired variable, a backup file with superseded values, a token never used | 2 |
| `mismatch` | copies differ, a revoked token still live, a pin that doesn't match, a file others can read | 1 |
| `expired` | expired, or retiring past its retire time | 1 |
| `missing` | a credential or a copy that should be there isn't | 1 |

The exit code is 1 when any line is a problem, else 2 when any is a warning,
else 0; 3 for a usage or configuration error. An expired viewer token that is
still listed counts as a warning.

## How secrets are handled

Klaus approved (2026-11-10) that the check reads secret files, only to
fingerprint them. The rules:

- **A value never leaves the process that reads it.** A small Python program
  (`scripts/tokencheck/hasher.py`, standard library only) runs where the files
  are: on the Mac (`python3 -`) and on each host (`ssh <host> python3 -`, the
  program on stdin). It prints JSON with fingerprints, file modes and
  non-secret fields; never a value, never an exception message (only its
  type).
- **High-entropy tokens:** `sha256:` + 12 hex of SHA-256, which also matches
  cam-proxy's and cams-admin's stored token hashes (their 8-hex prefixes).
- **Passwords and other low-entropy secrets:** `hmac:` + 12 hex of
  HMAC-SHA256 with a random key made for each run on the Mac and sent to each
  host on stdin for that run only. Fingerprints compare copies within one
  run and are useless afterwards: the same password shows another `hmac:` in
  the next run.
- **No secret on a command line, nothing written:** the run key and the spec
  travel inside the program on stdin; nothing is stored on a host or the Mac.
- The only secret the Mac process itself handles is the diagnostics token,
  sent to cams-admin as every diagnostics call does.
- **Cameras:** never contacted. A camera password's validity is the proxy's
  own login status (`GET /control/cameras` on the host: `credentials.authOk`;
  for a proxy without ssh, the `login` step of the onboarding report in
  `/diag/proxies`). On the host, the hasher reads the proxy's local API
  (`http://127.0.0.1:8480`) with the proxy's admin token from its own
  `config/.env`; the token stays on the host.

## Configuration

`~/.config/cams-admin/token-check.json` (mode 600; addresses and paths, no
secret; not in the repository). Example with placeholders:
[`scripts/tokencheck/token-check.example.json`](../scripts/tokencheck/token-check.example.json).

| Key | Meaning |
|---|---|
| `camsAdmin.url` | cams-admin (https) |
| `camsAdmin.diagTokenFile` | the diagnostics token (default `~/.config/cams-admin/diag-token`) |
| `camsAdmin.opsTokenFile` | the operations token, if any: matched with `/diag/ops-tokens` |
| `camsAdmin.signingKeyFile` | a copy of the signing key, if any: only its public key's fingerprint is compared with the pins |
| `accounts` | account name → `acc_` id (`--account` also takes an `acc_` id) |
| `hosts[]` | `name`; `ssh` (`user@address`; absent: no shell, cams-admin's view only, as for a cluster); `root` (cam-proxy's folder, default `/srv/cam-proxy`); `proxy` (its name in cams-admin); `localApi` (default `http://127.0.0.1:8480`); `cams: {instance, root, env}` for a cams instance on the host (`root` default `<root>/cams`, `env` default `<cams root>/.env`) |
| `mac.adminTokens` | host → Mac copy of its local admin token (default `~/.config/cam-proxy/<host>-admin-token`) |
| `mac.copies[]` | other Mac copies: `path`; `vars` (an env file and the variable names to fingerprint; without it the whole file is one value); `host` (whose copy it is: compared with that host's value); `camera`, `user` (a camera password copy); `label` |
| `expiringDays` | default 7 |
| `sshTimeoutS` | per host, default 20 |

A host's `*_FILE` variables name container paths (`/config/…`, `/data/…`);
the hasher reads them at `<root>/config/…` and `<root>/data/…`.

## What it checks

**cams-admin (every run)**
- The diagnostics token: accepted, and its expiry from its issue record in
  the audit (`diag-token-issue`, matched by hash prefix; the diagnostics API
  has no token list).
- The Mac's operations token against `/diag/ops-tokens` (state, scopes,
  expiry, last use); every other active one (expiry; `unused` when never
  used after 7 days).
- The signing key copy on the Mac: its public key fingerprint, compared with
  the pins below.

**The account:** its viewer tokens (`/diag/viewer-tokens`): expiry, never used.

**Each proxy**
- Enrollment: registry state, online, heartbeat; on the host, `/control/admin`
  says connected with the same proxy id.
- Signing-key pin: the `serverKeys` in its `data/admin/key.json` against the
  Mac's key.
- Site CA: the proxy's own CA (`/control/tls`), what it reports, and the
  registry's pins; the CA's and the leaf certificates' expiry (a leaf within
  7 days means its renewal failed); pins that are not sent to a viewer.
- Managed tokens: cams-admin's registry (`/diag/tokens`) against the proxy's
  own set (`/control/admin/tokens`): active ones live on the proxy, revoked
  ones not, retiring ones not past due, none on the proxy that cams-admin
  doesn't know, no `manual` holder or removed instance left; without a host,
  the proxy's reported counts. Each cams instance that serves the account and
  routes to the proxy holds an active client and admin token; a route of an
  instance that no longer serves the account is reported.
- The local admin token: the host's value against the Mac copies; not the
  same as another checked host's.
- `CAMPROXY_TOKENS` (each one): a holder somewhere (a viewer's file);
  `unused` when only the Mac or nobody has it. `CAMPROXY_AUDIT_TOKEN`: a
  reader somewhere.
- The FTP password: the host's against the Mac copies; each camera's upload
  from the proxy's status (the camera's FTP setting on and matching, no
  failures, no stall, the last upload). The password stored in the camera
  itself is not readable without a camera login.
- Camera passwords: the proxy's login status, the value it logs in with
  (`CAMPROXY_CAMERA_PASSWORD_<ID>`, `data/admin/camera-passwords.json`, or the
  shared variable), and every copy (`config/<camera>-<user>.pw`, a shadowed
  store entry, the Mac's copies, a viewer's camera-credentials file and its
  legacy `cameras.json`); camera password variables no camera uses.
- PoE switch passwords: set on the operating proxy, cams-admin's switch
  problems, and the copies (the Mac, the retired `CAMPROXY_POE_SWITCH_PASSWORD`).
- Other env secrets (the Vision key): set, and where else the same value is.
- Backup env files (`config/.env.*`, `.env*`): whether they hold values that
  are no longer the live ones.
- File modes: every secret file it reads should be 600.

**Each cams instance**
- Enrollment and its report: current snapshot revision, no pending or legacy
  tokens, no problems, seen recently.
- On its host: `data/admin/key.json` is for the same instance and pins the
  Mac's signing key; the CA pins in its cached snapshot equal the registry's;
  each held proxy token (`data/admin/tokens.json`) matches its stored hash,
  is active in cams-admin for this instance, and has the proxy's hash; a
  revoked or unknown one is a stale plaintext copy.
- `CAMS_LOGIN_TOKEN` (an env token sign-in, as on the Pi): present, and its
  `CAMS_TOKEN_ACCOUNT` is an account the instance serves; `COOKIE_SECRET`
  present.

**The Mac:** each configured copy, with what it equals on the checked hosts
(or `unused`); mode 600.

## What it can't check

- **Hosts without a shell** (the cluster's cam-proxy and cams): only
  cams-admin's view. Their env secrets, key files, held tokens and the Mac
  copies meant for them are `unknown`. The cluster cams' pins are taken as
  the registry's when it applied the current snapshot (inferred).
- **Diagnostics tokens other than the Mac's**: the diagnostics API has no
  list; only the audit's issue records.
- **The password a camera holds** for the FTP upload and for its `admin` and
  `cams` users: not readable without a camera login, which the check never
  tries. The FTP upload status and the proxy's login stand in for them; a
  copy for a user the proxy doesn't log in as is `unknown` unless another
  copy has the same value.
- **Which user a camera added at run time logs in as** (`camera-passwords.json`
  has only the password): such copies are compared by value only.
- **Viewer tokens on devices, MCP tokens, sessions**, Google OAuth secrets,
  `COOKIE_SECRET` rotation age, the S3 backup key, GitHub PATs: out of scope
  or not visible; cams-admin's own Secrets (signing key, viewer-token key) are
  checked only through the signing-key pins.
- **Who uses a credential**: "unused" means no holder was found among the
  checked files; a script elsewhere may still use it.
