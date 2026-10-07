# The local stack (Mac)

`scripts/localstack/start.sh` runs cams-admin with several accounts, real
cam-proxies and cam-sims, everything on 127.0.0.1 (spec §15.3):

| account | proxy | port | cam-sims |
|---|---|---|---|
| alpha | alpha-1 | 29100 | 2 |
| beta | beta-1 | 29200 | 1 |
| beta | beta-2 | 29300 | 3 |
| gamma | gamma-1 | 29400 | 1, enrolled and then cut: shows **offline** |

- **cams-admin:** this repo's build (`npm run build`) on
  <http://localhost:29000>. **Sign in** goes to a fake Google on :29001, which
  signs you in as `localstack@example.com`. Real Google is never used.
- **Backups:** a local S3 (SeaweedFS in Docker, :29010, bucket `localstack`),
  so **Backup now** and the daily snapshot work; `--no-s3` uses a local
  folder instead. Never the real bucket.
- **cam-proxies and cam-sims:** detached worktrees of `cam-proxy` and
  `cam-sim` `origin/main` in the work dir, built once per commit. cam-sims are
  on 29500 + 10·n (+0 http, +2 control and web UI, +3 RTSP, +4 ONVIF,
  +5 Baichuan). Stills and FTP are off in the proxies (not what this stack
  tests).
- **Enrollment:** each proxy enrolls itself with its real `admin-enroll`
  (the code on stdin, from a mode-600 file deleted after use), with
  `CAMPROXY_ADMIN_COMMANDS=on`. `start.sh` then allows `tokens.apply` and
  `tokens.apply.admin` locally on each proxy (the P4 rehearsal issues
  tokens), and nothing of P3. `LOCALSTACK_BRIDGE=1`, or a cam-proxy without
  `src/fleet/commands.ts`, uses the old bridge instead: the protocol test
  client (`test-client/cli.ts bridge`) sends the proxy's
  `GET /api/local/health` as its heartbeat.
- **cam-proxy branch:** `LOCALSTACK_CAM_PROXY_REF` (default `origin/main`),
  for example `origin/feat/migration-p3` before it is merged.
- **Restarts:** every proxy except gamma-1 runs under
  `scripts/localstack/supervise.sh`, which starts it again when it ends by
  itself with code 0 (cam-proxy's `proxy.restart`), as systemd or Docker
  would. beta-2 has `ntp.server` `192.0.2.123` set locally.
- **Heartbeats** every 10 s, offline after 30 s
  (`LOCALSTACK_HEARTBEAT_S`).
- **Work dir:** `${TMPDIR}/cams-admin-localstack` (`LOCALSTACK_DIR`), never
  inside the repo. Secrets are per run, mode 600, never printed.
- **Stop:** `scripts/localstack/stop.sh` (`--clean` also removes run data
  and the worktrees). It stops only the processes it recorded and whose
  command line names this harness; never `pkill`.
- **Never:** the real camera, the Pi, the cluster, the PoE switch, or any
  address but 127.0.0.1.

Prerequisites: Docker (unless `--no-s3`), `jq`, `openssl`, cam-proxy's
`tools/go2rtc` and cam-sim's `tools/mediamtx` (their install scripts).

## The P3 check

With the stack up (real enrollment, a cam-proxy with P3):

```
npx tsx scripts/localstack/p3-check.ts [--only <part of a check's name>]
```

It drives cams-admin's remote configuration against the real proxies
alpha-1 and beta-2 and their cam-sims, and prints one line per check. It
exits 1 at the first failure, and 2 if the cam-proxy build has no P3. It
allows entries with each proxy's **local** admin token, then checks:

- the views equal the proxies' own `/control/config`;
- preview and apply, with the "set by cams-admin" marker and the audit
  record on both sides (same cmdId, old → new);
- a local edit between preview and apply (`preview_stale` or `conflict`);
- rollback: refused while the setting has changed since, done once it is
  back, then `already_rolled_back`;
- denied and local-only paths, and a narrow path lowered, all refused by
  cams-admin before any command;
- `camera.name.set` read back from the cam-sim, and `camera-ntp-set` with
  its typed confirmation (the cam-sim then has `192.0.2.123`);
- `proxy.restart` twice through the supervisor; a third is refused by the
  fleet limit;
- a local pause and resume;
- the client tokens still work on both proxies.

It takes about 2 minutes, one of which is a wait for the proxy's settings
window (6 a minute, dry runs count). It changes only the local cam-sims and
proxies; run it on a fresh stack (`stop.sh`, `start.sh`).

## Two cams instances (P4)

After the proxies, `start.sh` creates two cams instances through the API
(`scripts/localstack/cams-setup.ts`) and enrolls each with the **reference
cams client** (`test-client/cams.ts`, an implementation of the cams-v1
contract independent of the server's code); their key files are in
`$LOCALSTACK_DIR/run/cams/` (mode 600):

| instance | serves | routes |
|---|---|---|
| `cms-main` | alpha, beta | every proxy at its registered URL (routes are default-deny) |
| `cms-pi` | alpha | alpha-1 → `http://localhost:29100` (the loopback form) only |

The proxies allow `tokens.apply` and `tokens.apply.admin`, so managed and
cams-held tokens become `active` (with the bridge, through `--allow`; the
tokens then live in the bridge's memory).

Real cams processes are not started here: cams's own livestack admin
scenario (cams `docs/livestack.md`, cams P4 plan Task 15) runs cams against
a cams-admin. `start.sh` says which applies (cams `main` with or without
`admin-enroll`). Ports 29600–29619 are kept for cams instances.

## The rehearsal (runbook §R, cams-admin side)

With the stack up:

```
W=$LOCALSTACK_DIR   # default ${TMPDIR}/cams-admin-localstack
npx tsx scripts/rehearse/rehearse.ts --url http://localhost:29000 \
  --session-file $W/run/cams-admin/cookie --account beta --work $W/rehearse
```

It issues the P2 managed tokens (cut-over steps 1–2) for beta's two
proxies, writes two real-shaped `export-config` outputs (cluster and Pi,
token hashes only), localizes them with `scripts/rehearse/localize.ts`,
creates and enrolls `rh-cluster-*` and `rh-pi-*`, imports both (dry run,
apply, again = no changes, each apply bound to its dry run; the Pi file routes only its proxy), pulls and
verifies both snapshots (200, 304), compares the files with the snapshots
like cams's shadow mode (0 differences, reported), registers cams-held
tokens and rotates them, checks the cached snapshot offline, and blocks
the Pi instance (its tokens revoked, its pull `403 revoked`). PASS/FAIL per
step; `result.json` in the work dir. Nothing leaves the Mac.

With **real exports** (Klaus runs `export-config` in the cluster and on the
Pi): put them in the work dir, write `map.json` (each real proxy URL → a
local proxy URL and, where the file pins a CA, the local CA's fingerprint),
then `npx tsx scripts/rehearse/localize.ts --in export-cluster.json --map
map.json --out local-cluster.json` and import with `npm run import -- --url
http://localhost:29000 --session-file $W/run/cams-admin/cookie --account
<account> --instance <instance> --file local-cluster.json [--apply]` (with `--apply` it runs the dry run first and applies exactly that plan).
