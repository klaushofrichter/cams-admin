# lib.sh: paths and helpers of the cams-admin local stack (start.sh, stop.sh).
# Sourced, never run. See docs/localstack.md.
#   LOCALSTACK_DIR       work dir (default ${TMPDIR:-/tmp}/cams-admin-localstack),
#                        always outside the repo: worktrees, run/, logs/, pids
#   LOCALSTACK_DEV_DIR   where cam-proxy and cam-sim live (default ~/Development)
# Never prints a secret; values go to files (mode 600) and *_FILE variables.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
DEV_DIR="${LOCALSTACK_DEV_DIR:-$HOME/Development}"
CAM_PROXY_REPO="${LOCALSTACK_CAM_PROXY_REPO:-$DEV_DIR/cam-proxy}"
CAM_SIM_REPO="${LOCALSTACK_CAM_SIM_REPO:-$DEV_DIR/cam-sim}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
WORK="${LOCALSTACK_DIR:-$TMP_BASE/cams-admin-localstack}"; WORK="${WORK%/}"
LOGS="$WORK/logs" RUN="$WORK/run" PIDS="$WORK/pids" RUN_ENV="$WORK/run.env" FIXTURES="$WORK/fixtures"
GO2RTC_BIN="${GO2RTC_BIN:-$CAM_PROXY_REPO/tools/go2rtc}"
MEDIAMTX_BIN="${MEDIAMTX_BIN:-$CAM_SIM_REPO/tools/mediamtx}"
S3_CONTAINER=cams-admin-localstack-s3
SEAWEED_IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
ADMIN_EMAIL=localstack@example.com

die() { echo "localstack: $*" >&2; exit 1; }
note() { echo "localstack: $*"; }
case "$WORK" in /*) ;; *) WORK="$PWD/$WORK" ;; esac
case "$WORK/" in "$REPO"/*) die "LOCALSTACK_DIR ($WORK) is inside the repo; use a folder outside it" ;; esac
mkdir -p "$WORK" && chmod 700 "$WORK"

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
require_ports_free() { local p; for p in "$@"; do port_free "$p" || die "port $p is in use"; done; }
gen_token() { openssl rand -hex 24; }
put_secret() { ( umask 077; mkdir -p "$(dirname "$1")"; printf '%s' "$2" > "$1" ); }
runenv_put() { ( umask 077; printf '%s=%s\n' "$1" "$2" >> "$RUN_ENV" ); }
env_get() { [ -r "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1; }

# start_bg NAME CMD...: detached, logged, recorded in the pids file.
start_bg() {
  local name="$1"; shift
  nohup "$@" > "$LOGS/$name.log" 2>&1 < /dev/null &
  echo "$! $name" >> "$PIDS"
}

wait_http() { # URL SECONDS NAME
  local i=0
  while [ "$i" -lt "$2" ]; do curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null && return 0; sleep 1; i=$((i + 1)); done
  die "$3 did not answer $1 within $2 s (see $LOGS/)"
}

# prepare_repo NAME SRC [REF]: a detached worktree of REF (origin/main, or
# another origin branch such as origin/feat/migration-p3) in
# the work dir, npm ci + build once per commit. The repo's own checkout is
# never touched (fetch and worktree add only).
prepare_repo() {
  local name="$1" src="$2" ref="${3:-origin/main}" dir="$WORK/src-$1" sha
  [ -e "$src/.git" ] || die "$name: no git repo at $src"
  git -C "$src" fetch -q origin || die "$name: git fetch failed"
  if [ -d "$dir" ]; then git -C "$dir" checkout -q --detach "$ref"; else git -C "$src" worktree prune; git -C "$src" worktree add -q --detach "$dir" "$ref" || die "$name: worktree add failed"; fi
  sha="$(git -C "$dir" rev-parse HEAD)"
  if [ "$(cat "$dir/.localstack-built" 2>/dev/null)" != "$sha" ]; then
    note "$name: npm ci + build at ${sha:0:7} (log $LOGS/build-$name.log)"
    ( cd "$dir" && npm ci --no-audit --no-fund && npm run build ) > "$LOGS/build-$name.log" 2>&1 || die "$name: build failed, see $LOGS/build-$name.log"
    echo "$sha" > "$dir/.localstack-built"
  else
    note "$name: built at ${sha:0:7}"
  fi
}

# ours PID: alive and started by this harness (its work dir or scripts in the command line).
ours() {
  local cmd; cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  case "$cmd" in *"$HERE"*|*"$WORK"*|*"$REPO"*) return 0 ;; *) return 1 ;; esac
}
stack_running() { [ -f "$PIDS" ] || return 1; local pid name; while read -r pid name; do [ -n "$pid" ] && ours "$pid" && return 0; done < "$PIDS"; return 1; }
