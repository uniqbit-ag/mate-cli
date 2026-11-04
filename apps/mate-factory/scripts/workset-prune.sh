#!/usr/bin/env bash
# Prunes a Workset container's nested images and build cache when its Docker
# daemon is running, and does nothing otherwise. Talks to the daemon's own
# socket: the public one would start the daemon just to prune it.
set -uo pipefail

SOCKET="${MATE_DOCKERD_SOCKET:-/run/mate-dockerd.sock}"
export DOCKER_HOST="unix://$SOCKET"

[[ -S "$SOCKET" ]] && docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || exit 0
exec docker system prune --force
