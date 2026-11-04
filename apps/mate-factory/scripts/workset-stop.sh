#!/usr/bin/env bash
# Stops every process in this Workset container that carries one attach session's
# marker: the agent and everything it started, which inherit its environment.
# TERM first, KILL after the grace period; the container's dockerd is untouched.
set -uo pipefail

[[ $# -ge 1 && "$1" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo "usage: mate-workset-stop <session-id>" >&2; exit 2; }
MARKER="MATE_FACTORY_SESSION=$1"
GRACE_TENTHS=$(( ${MATE_WORKSET_STOP_GRACE_SECONDS:-5} * 10 ))

marked() {
  local environ pid
  for environ in /proc/[0-9]*/environ; do
    pid="${environ#/proc/}"; pid="${pid%/environ}"
    [[ "$pid" == "$$" ]] && continue
    tr '\0' '\n' < "$environ" 2>/dev/null | grep -qxF "$MARKER" && echo "$pid"
  done
}

pids="$(marked)"
[[ -z "$pids" ]] && exit 0
# shellcheck disable=SC2086
kill -TERM $pids 2>/dev/null
for (( i = 0; i < GRACE_TENTHS; i++ )); do
  pids="$(marked)"
  [[ -z "$pids" ]] && exit 0
  sleep 0.1
done
# shellcheck disable=SC2086
kill -KILL $(marked) 2>/dev/null
exit 0
