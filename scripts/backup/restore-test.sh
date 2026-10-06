#!/usr/bin/env bash
# restore-test.sh: the tested restore of spec §13.6, against a local S3
# (SeaweedFS in Docker; MinIO no longer publishes images) and the pinned
# Litestream. Runs in CI (the `test` job) and on the Mac.
#   1. the built app + `litestream replicate` against s3://restore-test/cams-admin/ci/
#   2. accounts, users, proxies, cameras, sims, an enrollment (test client)
#   3. a snapshot through the API
#   4. both processes killed (SIGKILL)
#   5. restored (a) from Litestream, (b) from the snapshot
#   6. per-table counts and content hashes compared, integrity checked
#   7. the app started on each copy; the enrolled test client passes hello
# Only its own container and PIDs are stopped; nothing is killed by name.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cams-admin-restore.XXXXXX")"
S3_PORT="${RESTORE_S3_PORT:-29012}" APP_PORT="${RESTORE_APP_PORT:-29021}" LS_PORT="${RESTORE_LS_PORT:-29022}"
SEAWEED_IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
CONTAINER="cams-admin-restore-s3-$$"
PIDS=()
note() { echo "restore-test: $*"; }
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "${KEEP_WORK:-0}" = 1 ]; then note "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

[ -f dist/server/server.js ] || npm run build:server >/dev/null
LITESTREAM="$(scripts/backup/litestream.sh)"
note "litestream $("$LITESTREAM" version)"

export AWS_ACCESS_KEY_ID=restore-test AWS_SECRET_ACCESS_KEY=restore-test AWS_REGION=us-east-1
export S3_ENDPOINT="http://127.0.0.1:$S3_PORT" BACKUP_S3_BUCKET=restore-test BACKUP_S3_PREFIX=cams-admin/ci/
docker run -d --rm --name "$CONTAINER" -p "127.0.0.1:$S3_PORT:8333" "$SEAWEED_IMAGE" server -s3 -dir=/data >/dev/null
for _ in $(seq 1 60); do curl -fsS -o /dev/null "$S3_ENDPOINT/" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "$S3_ENDPOINT/" || { note "S3 did not start"; docker logs "$CONTAINER" | tail -20; exit 1; }
npx tsx scripts/backup/restore-check.ts bucket

npx tsx scripts/gen-signing-key.ts "$WORK/signing.pem" >/dev/null
lsconf() { # lsconf DBFILE
  cat <<YAML
addr: "127.0.0.1:$LS_PORT"
dbs:
  - path: $1
    replica:
      type: s3
      bucket: $BACKUP_S3_BUCKET
      path: ${BACKUP_S3_PREFIX}litestream
      region: us-east-1
      endpoint: $S3_ENDPOINT
      force-path-style: true
      sync-interval: 1s
YAML
}
app_env() { # app_env DBFILE PORT
  exec env NODE_ENV=development LOG_LEVEL=warn PORT="$2" PUBLIC_URL="http://127.0.0.1:$2" DB_FILE="$1" SERVER_SIGNING_KEY_FILE="$WORK/signing.pem" \
    ALLOWED_EMAILS=restore@example.com LITESTREAM_METRICS_URL="http://127.0.0.1:$LS_PORT/metrics" TZ=America/Chicago "${@:3}"
}
wait_health() { for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null && return 0; sleep 0.5; done; note "app on :$1 did not start"; exit 1; }

DB="$WORK/live/cams-admin.db"
mkdir -p "$WORK/live"
app_env "$DB" "$APP_PORT" node dist/server/server.js > "$WORK/app.log" 2>&1 &
PIDS+=($!); APP_PID=$!
wait_health "$APP_PORT"
lsconf "$DB" > "$WORK/litestream.yml"
"$LITESTREAM" replicate -config "$WORK/litestream.yml" > "$WORK/litestream.log" 2>&1 &
PIDS+=($!); LS_PID=$!

COOKIE="$(app_env "$DB" "$APP_PORT" npx tsx scripts/dev-session.ts restore@example.com)"  # (a subshell: exec is fine)
npx tsx scripts/backup/restore-check.ts seed --url "http://127.0.0.1:$APP_PORT" --cookie "$COOKIE" --key "$WORK/proxy-key.json"
npx tsx scripts/backup/restore-check.ts snapshot --url "http://127.0.0.1:$APP_PORT" --cookie "$COOKIE"
note "waiting for Litestream to sync"
sleep 5
npx tsx scripts/backup/restore-check.ts dump --db "$DB" > "$WORK/before.json"
REG=accounts,account_users,proxies,proxy_keys,enrollment_codes,cameras,sims
npx tsx scripts/backup/restore-check.ts dump --db "$DB" --tables "$REG" > "$WORK/before-registry.json"
kill -9 "$APP_PID" "$LS_PID"
note "app and litestream killed"

# (a) Litestream
mkdir -p "$WORK/ra"
"$LITESTREAM" restore -config "$WORK/litestream.yml" -o "$WORK/ra/cams-admin.db" "$DB" > "$WORK/restore-a.log" 2>&1 || { cat "$WORK/restore-a.log"; exit 1; }
npx tsx scripts/backup/restore-check.ts dump --db "$WORK/ra/cams-admin.db" > "$WORK/after-a.json"
# (b) the snapshot (written before the snapshot's own job and audit rows: registry tables)
mkdir -p "$WORK/rb"
npx tsx scripts/backup/restore-check.ts fetch-snapshot --out "$WORK/rb/cams-admin.db"
npx tsx scripts/backup/restore-check.ts dump --db "$WORK/rb/cams-admin.db" --tables "$REG" > "$WORK/after-b.json"

fail=0
if cmp -s "$WORK/before.json" "$WORK/after-a.json"; then note "Litestream restore: every table matches"; else note "Litestream restore DIFFERS"; diff <(tr ',' '\n' < "$WORK/before.json") <(tr ',' '\n' < "$WORK/after-a.json") || true; fail=1; fi
if cmp -s "$WORK/before-registry.json" "$WORK/after-b.json"; then note "snapshot restore: every registry table matches"; else note "snapshot restore DIFFERS"; diff <(tr ',' '\n' < "$WORK/before-registry.json") <(tr ',' '\n' < "$WORK/after-b.json") || true; fail=1; fi
grep -q '"integrity":"ok"' "$WORK/after-a.json" && grep -q '"integrity":"ok"' "$WORK/after-b.json" || { note "integrity check failed"; fail=1; }
[ "$fail" = 0 ] || exit 1
cat "$WORK/before-registry.json"

for copy in ra rb; do
  PORT=$((APP_PORT + 10))
  app_env "$WORK/$copy/cams-admin.db" "$PORT" LITESTREAM_METRICS_URL= node dist/server/server.js > "$WORK/app-$copy.log" 2>&1 &
  PIDS+=($!); P=$!
  wait_health "$PORT"
  npx tsx scripts/backup/restore-check.ts hello --key "$WORK/proxy-key.json" --connect "ws://127.0.0.1:$PORT/proxy/v1/connect"
  kill "$P"; wait "$P" 2>/dev/null || true
  note "copy $copy: the app starts and the enrolled proxy passes hello"
done
note "OK"
