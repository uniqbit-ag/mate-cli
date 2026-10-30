#!/usr/bin/env bash
# A Workset container's init: its own Docker daemon, kept running until stop.
#
# Runs as the container's root, which sysbox-runc maps to an unprivileged host
# user. The agent never runs here; Studio starts it per command with
# `docker exec --user mate`. A daemon that fails to start is logged and the
# container stays up, so the worktree remains reachable.
set -uo pipefail

dockerd >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

stop() {
  kill -TERM "$DOCKERD_PID" 2>/dev/null
  wait "$DOCKERD_PID" 2>/dev/null
  exit 0
}
trap stop TERM INT

while :; do
  sleep 3600 &
  wait $!
done
