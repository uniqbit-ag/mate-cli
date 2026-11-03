#!/usr/bin/env bash
# Serves one connection to a Workset container's Docker socket, starting the
# nested daemon first when it is not running yet.
#
# The init's socat listener runs this once per connection, as root, with the
# connection on stdin and stdout. The daemon keeps running until the container
# stops; the lock makes concurrent first connections start one daemon.
set -uo pipefail

SOCKET="${MATE_DOCKERD_SOCKET:-/run/mate-dockerd.sock}"
LOCK="${MATE_DOCKERD_LOCK:-/run/mate-dockerd.lock}"
LOG="${MATE_DOCKERD_LOG:-/var/log/dockerd.log}"
WAIT_TENTHS=$(( ${MATE_DOCKERD_WAIT_SECONDS:-30} * 10 ))

answers() {
  [[ -S "$SOCKET" ]] && DOCKER_HOST="unix://$SOCKET" docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

{
  flock 9
  if ! answers; then
    # setsid: the daemon outlives this connection; 9>&-: it must not hold the
    # lock. One still starting after an earlier timeout makes this one exit on
    # its pidfile.
    setsid dockerd -H "unix://$SOCKET" >>"$LOG" 2>&1 </dev/null 9>&- &
    for (( i = 0; i < WAIT_TENTHS; i++ )); do
      answers && break
      sleep 0.1
    done
  fi
} 9>"$LOCK"

answers || { echo "mate-workset-docker-proxy: the Docker daemon did not start; see $LOG" >&2; exit 1; }
# -t as in the init: relay until the daemon ends its answer.
exec socat -t 2592000 STDIO "UNIX-CONNECT:$SOCKET"
