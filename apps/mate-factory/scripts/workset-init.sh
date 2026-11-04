#!/usr/bin/env bash
# A Workset container's init: listens on the Docker socket and starts the
# container's own Docker daemon on the first connection, kept until stop.
#
# Runs as the container's root, which sysbox-runc maps to an unprivileged host
# user. The agent never runs here; Studio starts it per command with
# `docker exec --user mate`. A daemon that fails to start is logged and the
# container stays up, so the worktree remains reachable.
set -uo pipefail

PUBLIC_SOCKET="${MATE_DOCKER_SOCKET:-/var/run/docker.sock}"
DOCKERD_PIDFILE="${MATE_DOCKERD_PIDFILE:-/var/run/docker.pid}"
RELAY_SECONDS=2592000

# /run survives a container restart; a pid left from the last run names nothing of ours.
rm -f "$DOCKERD_PIDFILE"

# -t: after the client half-closes, keep relaying the daemon's answer until it
# ends; socat's default 0.5 s would cut off a slow start or a hijacked stream.
socat -t "$RELAY_SECONDS" "UNIX-LISTEN:${PUBLIC_SOCKET},fork,unlink-early,user=root,group=docker,mode=660" \
  EXEC:/usr/local/bin/mate-workset-docker-proxy &
LISTENER_PID=$!

# Alive and not yet reaped; this shell, as PID 1, reaps the orphaned daemon.
alive() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  [[ "${stat##*) }" != Z* ]]
}

stop() {
  kill -TERM "$LISTENER_PID" 2>/dev/null
  wait "$LISTENER_PID" 2>/dev/null
  local dockerd
  dockerd="$(cat "$DOCKERD_PIDFILE" 2>/dev/null)"
  if [[ "$dockerd" =~ ^[0-9]+$ ]] && kill -TERM "$dockerd" 2>/dev/null; then
    # Not this shell's child: wait for it by polling.
    while alive "$dockerd"; do sleep 0.1; done
  fi
  exit 0
}
trap stop TERM INT

while :; do
  sleep 3600 &
  wait $!
done
