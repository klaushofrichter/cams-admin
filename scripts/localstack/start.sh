#!/usr/bin/env bash
# start.sh [--no-s3]: cams-admin with several accounts, real cam-proxies and
# cam-sims, all on 127.0.0.1, on the Mac (spec §15.3). See docs/localstack.md.
#
#   alpha  alpha-1 (:29100)  2 cam-sims
#   beta   beta-1  (:29200)  1 cam-sim
#          beta-2  (:29300)  3 cam-sims
#   gamma  gamma-1 (:29400)  1 cam-sim, enrolled, then stopped (shows offline)
#
# cams-admin: this repo's build on :29000 (http://localhost:29000), with a
# fake Google on :29001 (sign in as localstack@example.com) and a local S3
# (SeaweedFS in Docker, :29010) for its backups unless --no-s3. Never the
# real bucket, the real camera, the Pi or the cluster.
#
# cam-proxy (origin/main) has no cams-admin client yet: each proxy is
# enrolled by the protocol test client in bridge mode, which forwards that
# proxy's real GET /api/local/health as its heartbeat. Once cam-proxy ships
# its client, `admin-enroll` replaces the bridge.
#
# cam-sims: 29500 + 10·n (+0 http, +1 https, +2 control/UI, +3 rtsp, +4 onvif, +5 baichuan).
# Stop with stop.sh; secrets are per run, mode 600, never printed. Every
# process is started with absolute paths, so stop.sh can tell it is ours.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

S3=1
case "${1:-}" in --no-s3) S3=0 ;; "") ;; *) die "usage: start.sh [--no-s3]" ;; esac
stack_running && die "a stack is running (pids in $PIDS); run stop.sh first"
for t in jq openssl curl lsof; do command -v "$t" >/dev/null || die "$t is not on the PATH"; done
[ -x "$GO2RTC_BIN" ] || die "go2rtc missing at $GO2RTC_BIN (cam-proxy scripts/install-go2rtc.sh)"
[ -x "$MEDIAMTX_BIN" ] || die "MediaMTX missing at $MEDIAMTX_BIN (cam-sim scripts/install-mediamtx.sh)"
[ "$S3" = 0 ] || command -v docker >/dev/null || die "docker is needed for the local S3 (or use --no-s3)"
HB="${LOCALSTACK_HEARTBEAT_S:-10}"

ADMIN_PORT=29000 GOOGLE_PORT=29001 S3_PORT=29010
# account proxy port camera-count
PROXIES=("alpha alpha-1 29100 2" "beta beta-1 29200 1" "beta beta-2 29300 3" "gamma gamma-1 29400 1")
sim_port() { echo $((29500 + 10 * ($1 - 1) + $2)); }

rm -rf "$RUN" "$PIDS" "$RUN_ENV"
mkdir -p "$LOGS" "$RUN" "$FIXTURES"
chmod 700 "$RUN"
ports=($ADMIN_PORT $GOOGLE_PORT)
[ "$S3" = 1 ] && ports+=($S3_PORT)
n=0
for p in "${PROXIES[@]}"; do
  read -r _ _ port cams <<<"$p"
  ports+=("$port" $((port + 1)) $((port + 2)))
  for _ in $(seq 1 "$cams"); do n=$((n + 1)); for o in 0 1 2 3 4 5; do ports+=("$(sim_port $n $o)"); done; done
done
require_ports_free "${ports[@]}"

prepare_repo cam-proxy "$CAM_PROXY_REPO"
prepare_repo cam-sim "$CAM_SIM_REPO"
note "cams-admin: build of $(git -C "$REPO" rev-parse --short HEAD) (log $LOGS/build-cams-admin.log)"
( cd "$REPO" && npm run build ) > "$LOGS/build-cams-admin.log" 2>&1 || die "cams-admin build failed"
[ -z "$(git -C "$REPO" status --porcelain -- server web 2>/dev/null)" ] || note "cams-admin has uncommitted changes in server/ or web/: they are in this build"

# --- the local S3 ---------------------------------------------------------------
S3ENV=()
if [ "$S3" = 1 ]; then
  docker rm -f "$S3_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm --name "$S3_CONTAINER" -p "127.0.0.1:$S3_PORT:8333" "$SEAWEED_IMAGE" server -s3 -dir=/data >/dev/null
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$S3_PORT/" 2>/dev/null && break; sleep 1; done
  S3ENV=(AWS_ACCESS_KEY_ID=localstack AWS_SECRET_ACCESS_KEY=localstack AWS_REGION=us-east-1 S3_ENDPOINT="http://127.0.0.1:$S3_PORT" BACKUP_S3_BUCKET=localstack BACKUP_S3_PREFIX=cams-admin/localstack/)
  ( cd "$REPO" && env "${S3ENV[@]}" npx tsx scripts/backup/restore-check.ts bucket ) || die "could not create the local bucket"
  note "local S3 on :$S3_PORT (container $S3_CONTAINER)"
fi

# --- cams-admin and the fake Google -----------------------------------------------
mkdir -p "$RUN/cams-admin"
( cd "$REPO" && npx tsx scripts/gen-signing-key.ts "$RUN/cams-admin/signing.pem" ) >/dev/null
ADMIN_ENV=(NODE_ENV=development LOG_LEVEL=info HOST=127.0.0.1 PORT=$ADMIN_PORT PUBLIC_URL="http://localhost:$ADMIN_PORT"
  DB_FILE="$RUN/cams-admin/cams-admin.db" SERVER_SIGNING_KEY_FILE="$RUN/cams-admin/signing.pem" ALLOWED_EMAILS=$ADMIN_EMAIL
  HEARTBEAT_S="$HB" OFFLINE_AFTER_S=$((HB * 3)) TZ=America/Chicago
  GOOGLE_CLIENT_ID=localstack GOOGLE_CLIENT_SECRET=localstack
  GOOGLE_AUTH_URL="http://127.0.0.1:$GOOGLE_PORT/auth" GOOGLE_TOKEN_URL="http://127.0.0.1:$GOOGLE_PORT/token" GOOGLE_CERTS_URL="http://127.0.0.1:$GOOGLE_PORT/certs"
  ${S3ENV[@]+"${S3ENV[@]}"})
start_bg fake-google env -C "$REPO" node --import tsx "$REPO/test/fakeGoogle.ts" "$GOOGLE_PORT"
start_bg cams-admin env -C "$REPO" "${ADMIN_ENV[@]}" node "$REPO/dist/server/server.js"
wait_http "http://127.0.0.1:$GOOGLE_PORT/certs" 30 "fake Google"
curl -fsS -o /dev/null "http://127.0.0.1:$GOOGLE_PORT/set?email=$ADMIN_EMAIL"
wait_http "http://127.0.0.1:$ADMIN_PORT/health" 60 cams-admin
( umask 077; cd "$REPO" && env "${ADMIN_ENV[@]}" npx tsx scripts/dev-session.ts "$ADMIN_EMAIL" > "$RUN/cams-admin/cookie" )

# --- cam-sims and cam-proxies -------------------------------------------------------
n=0
PLAN='{"accounts":[]}'
for p in "${PROXIES[@]}"; do
  read -r acc name port cams <<<"$p"
  d="$RUN/$name"; s="$d/secrets"
  mkdir -p "$d/data" "$s"
  pw_proxy="$(gen_token)" pw_cams="$(gen_token)"
  put_secret "$s/proxy_tokens" "$(gen_token)"
  put_secret "$s/proxy_admin_token" "$(gen_token)"
  put_secret "$s/camera_password" "$pw_proxy"
  put_secret "$s/camsim_users" "proxy:admin:$pw_proxy;cams:admin:$pw_cams"
  put_secret "$s/camsim_control_token" "$(gen_token)"
  unset pw_proxy pw_cams
  cams_json='[]'
  plan_cams='[]'
  for i in $(seq 1 "$cams"); do
    n=$((n + 1))
    simname="$name cam$i"
    mkdir -p "$RUN/sim-$n"
    start_bg "cam-sim-$n" env LIVESTACK_CAMSIM_DIR="$WORK/src-cam-sim" \
      CAMSIM_USERS_FILE="$s/camsim_users" CAMSIM_CONTROL_TOKEN_FILE="$s/camsim_control_token" CAMSIM_NAME="$simname" CAMSIM_TZ=America/Chicago \
      CAMSIM_SEED_CLIPS=demo CAMSIM_SD_MB=61047 CAMSIM_WEB_UI=true CAMSIM_LOG_LEVEL=warn \
      CAMSIM_DATA_DIR="$RUN/sim-$n" CAMSIM_FIXTURE_DIR="$FIXTURES" CAMSIM_MEDIAMTX="$MEDIAMTX_BIN" \
      CAMSIM_HTTP_PORT="$(sim_port $n 0)" CAMSIM_HTTPS_PORT="$(sim_port $n 1)" CAMSIM_CONTROL_PORT="$(sim_port $n 2)" \
      CAMSIM_RTSP_PORT="$(sim_port $n 3)" CAMSIM_ONVIF_PORT="$(sim_port $n 4)" CAMSIM_BAICHUAN_PORT="$(sim_port $n 5)" \
      node "$HERE/sim-local.cjs"
    wait_http "http://127.0.0.1:$(sim_port $n 2)/healthz" 180 "cam-sim $n"
    cams_json="$(jq -c --arg id "cam$i" --arg nm "$simname" --argjson http "$(sim_port $n 0)" --argjson rtsp "$(sim_port $n 3)" --argjson onvif "$(sim_port $n 4)" --argjson bc "$(sim_port $n 5)" \
      '. + [{ id: $id, name: $nm, host: ("127.0.0.1:" + ($http|tostring)), protocol: "http", user: "proxy", webUiUrl: "none", onvifPort: $onvif, rtspPort: $rtsp, baichuanPort: $bc, statusPollS: 5 }]' <<<"$cams_json")"
    plan_cams="$(jq -c --arg id "cam$i" --arg cid "$name-cam$i" --arg nm "$simname" --argjson cp "$(sim_port $n 2)" '. + [{ id: $id, camsId: $cid, name: $nm, controlPort: $cp }]' <<<"$plan_cams")"
  done
  jq -n --arg data "$d/data" --arg go2rtc "$GO2RTC_BIN" --argjson port "$port" --argjson cams "$cams_json" '{
    server: { port: $port, dataDir: $data, logLevel: "warn" },
    go2rtc: { binary: $go2rtc, rtspPort: ($port + 1), apiPort: ($port + 2) },
    stills: { enabled: false, stream: "sub" },
    storage: { maxBytes: 1073741824, minFreeBytes: 1073741824 },
    analytics: { googleVision: { enabled: false } },
    ftp: { enabled: false },
    cameras: $cams }' > "$d/config.json"
  start_bg "$name" env -C "$WORK/src-cam-proxy" -u CAMPROXY_GOOGLE_VISION_KEY -u CAMPROXY_ENV_FILE \
    CAMPROXY_CONFIG="$d/config.json" CAMPROXY_TOKENS_FILE="$s/proxy_tokens" CAMPROXY_ADMIN_TOKEN_FILE="$s/proxy_admin_token" CAMPROXY_CAMERA_PASSWORD_FILE="$s/camera_password" \
    LIVESTACK_BIND=127.0.0.1 node --require "$HERE/bind-local.cjs" dist/src/cli.js
  wait_http "http://127.0.0.1:$port/health" 60 "cam-proxy $name"
  PLAN="$(jq -c --arg acc "$acc" --arg name "$name" --argjson port "$port" --argjson cams "$plan_cams" '
    (if any(.accounts[]; .name == $acc) then . else .accounts += [{ name: $acc, displayName: ($acc | ascii_upcase), users: [{ email: ("admin@" + $acc + ".example.com"), role: "admin" }, { email: "viewer@example.com", role: "viewer" }], proxies: [] }] end)
    | (.accounts[] | select(.name == $acc) | .proxies) += [{ name: $name, displayName: $name, port: $port, cameras: $cams }]' <<<"$PLAN")"
  note "cam-proxy $name on :$port with $cams cam-sim(s)"
done

# --- the registry and the enrollments; the bridges --------------------------------------
printf '%s' "$PLAN" > "$RUN/plan.json"
mkdir -p "$RUN/keys" && chmod 700 "$RUN/keys"
( cd "$REPO" && npx tsx scripts/localstack/setup.ts --url "http://localhost:$ADMIN_PORT" --cookie-file "$RUN/cams-admin/cookie" --plan "$RUN/plan.json" --keys "$RUN/keys" )
for p in "${PROXIES[@]}"; do
  read -r acc name port _ <<<"$p"
  start_bg "bridge-$name" env -C "$REPO" node --import tsx "$REPO/test-client/cli.ts" bridge --key "$RUN/keys/$acc-$name.json" --health "http://127.0.0.1:$port/api/local/health"
done
# gamma-1: wait for its first heartbeat, then cut it: the bridge is killed
# without a bye (an outage, not a deliberate stop, which would show
# "stopped"), the proxy stopped. Offline after OFFLINE_AFTER_S.
for _ in $(seq 1 60); do grep -q 'admin_connected' "$LOGS/bridge-gamma-1.log" 2>/dev/null && break; sleep 1; done
sleep 2
while read -r pid pname; do
  case "$pname" in
    bridge-gamma-1) ours "$pid" && kill -KILL "$pid" 2>/dev/null || true ;;
    gamma-1) ours "$pid" && kill -TERM "$pid" 2>/dev/null || true ;;
  esac
done < "$PIDS"
awk '$2 != "gamma-1" && $2 != "bridge-gamma-1"' "$PIDS" > "$PIDS.tmp" && mv "$PIDS.tmp" "$PIDS"
runenv_put ADMIN_URL "http://localhost:$ADMIN_PORT"

cat <<EOF

Local stack up (work dir $WORK):
  cams-admin  http://localhost:$ADMIN_PORT   (Sign in: the fake Google signs you in as $ADMIN_EMAIL)
  accounts    alpha (alpha-1: 2 sims), beta (beta-1: 1, beta-2: 3), gamma (gamma-1: stopped, offline after $((HB * 3)) s)
  proxies     http://127.0.0.1:29100 / 29200 / 29300 (cam-proxy admin UIs)
  backups     $([ "$S3" = 1 ] && echo "local S3 :$S3_PORT, bucket localstack" || echo "local folder (no S3)")
Stop: $HERE/stop.sh
EOF
