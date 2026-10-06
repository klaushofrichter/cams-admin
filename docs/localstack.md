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
- **The bridge:** cam-proxy has no cams-admin client yet. Each proxy is
  enrolled by the protocol test client (`test-client/cli.ts bridge`), which
  sends that proxy's real `GET /api/local/health` as its heartbeat. When
  cam-proxy's client is released, `admin-enroll` replaces the bridge.
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
