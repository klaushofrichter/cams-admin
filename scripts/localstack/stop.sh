#!/usr/bin/env bash
# stop.sh [--clean]: stops what start.sh started (newest first, SIGTERM, then
# SIGKILL after 20 s), and the local S3 container. A PID is signalled only
# while its command line names this harness, so a reused PID is never hit.
# Never pkill, never another port. --clean also deletes run/, logs/ and the
# cam-proxy/cam-sim worktrees.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
CLEAN=0
case "${1:-}" in --clean) CLEAN=1 ;; "") ;; *) die "usage: stop.sh [--clean]" ;; esac
if [ -f "$PIDS" ]; then
  list=()
  while read -r pid name; do [ -n "${pid:-}" ] && list=("$pid:$name" "${list[@]}"); done < "$PIDS"
  for e in "${list[@]}"; do
    pid="${e%%:*}" name="${e#*:}"
    if ours "$pid"; then kill -TERM "$pid" 2>/dev/null && note "stopping $name ($pid)"; fi
  done
  for e in "${list[@]}"; do
    pid="${e%%:*}"
    for _ in $(seq 1 20); do ours "$pid" || break; sleep 1; done
    ours "$pid" && kill -KILL "$pid" 2>/dev/null
  done
  rm -f "$PIDS"
fi
docker rm -f "$S3_CONTAINER" >/dev/null 2>&1 && note "local S3 container removed" || true
if [ "$CLEAN" = 1 ]; then
  rm -rf "$RUN" "$LOGS" "$RUN_ENV" "$FIXTURES"
  for r in cam-proxy:"$CAM_PROXY_REPO" cam-sim:"$CAM_SIM_REPO"; do
    n="${r%%:*}" src="${r#*:}"
    [ -d "$WORK/src-$n" ] && { git -C "$src" worktree remove --force "$WORK/src-$n" 2>/dev/null || rm -rf "$WORK/src-$n"; git -C "$src" worktree prune; note "removed worktree src-$n"; }
  done
fi
note "stopped"
