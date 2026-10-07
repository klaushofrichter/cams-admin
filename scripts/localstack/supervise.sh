#!/usr/bin/env bash
# supervise.sh CMD...: the local stack's stand-in for systemd/docker restart.
# Runs CMD; when CMD ends by itself with code 0 (cam-proxy's proxy.restart:
# "stop, then exit 0"), starts it again (at most 10 times per run). A TERM
# or INT to this script is passed to CMD and ends the loop. Its own PID is in
# the pids file, so stop.sh stops the child through it.
child=""
stopping=0
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
n=0
while :; do
  "$@" &
  child=$!
  rc=0
  wait "$child" || rc=$?
  # A trap interrupts wait: wait again until the child is really gone.
  while kill -0 "$child" 2>/dev/null; do wait "$child" || rc=$?; done
  [ "$stopping" = 1 ] && exit 0
  if [ "$rc" != 0 ] || [ "$n" -ge 10 ]; then echo "supervise: exit $rc, not restarting"; exit "$rc"; fi
  n=$((n + 1))
  echo "supervise: the process ended with 0 (a requested restart): starting it again ($n)"
  sleep 1
done
