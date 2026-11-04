#!/usr/bin/env bash
# Runs the local factory on Mate itself: this checkout as the Working Repository,
# the mate-cli companion as the companion.
#
# Worksets clone a bare mirror of this checkout, served by `git daemon` on
# 127.0.0.1 only, never GitHub. The factory pushes its Delivery Branches back to
# that mirror; `pull` fetches them here as `factory/*`. No credential is read.
#
#   bash apps/mate-factory/scripts/dogfood.sh [up|down|reset|pull|logs] [--companion <path>]
#
# `up` refreshes the mirror from this checkout's local branches (forced, so a local
# branch overwrites a factory branch of the same name) and passes other options to
# local-up.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LOCAL_DIR="$SCRIPT_DIR/../.local"
GIT_BASE="$LOCAL_DIR/git"
IDENTITY="uniqbit-ag/mate-cli"
MIRROR="$GIT_BASE/$IDENTITY.git"
PID_FILE="$LOCAL_DIR/git-daemon.pid"
PORT="${MATE_DOGFOOD_GIT_PORT:-9418}"
# The container reaches the host's loopback through this name on Docker Desktop and OrbStack.
REMOTE_URL="git://host.docker.internal:$PORT/$IDENTITY.git"

say() { echo "factory:dogfood: $*" >&2; }

refresh_mirror() {
  if [[ ! -d "$MIRROR" ]]; then
    say "creating the mirror $MIRROR"
    mkdir -p "$(dirname "$MIRROR")"
    git init --quiet --bare "$MIRROR"
  fi
  git -C "$MIRROR" fetch --quiet --no-tags "$REPO_ROOT" '+refs/heads/*:refs/heads/*'
  # Worksets branch from the mirror's HEAD: this checkout's main, as it is locally.
  git -C "$MIRROR" symbolic-ref HEAD refs/heads/main
  say "mirror at main $(git -C "$MIRROR" rev-parse --short main); run \`git fetch\` and update main first for the latest"
}

daemon_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start_daemon() {
  if daemon_running; then return; fi
  # receive-pack lets the factory push; loopback only, so nothing else can.
  git daemon --reuseaddr --listen=127.0.0.1 --port="$PORT" \
    --base-path="$GIT_BASE" --export-all --enable=receive-pack \
    --pid-file="$PID_FILE" --detach "$GIT_BASE"
  say "serving $GIT_BASE on 127.0.0.1:$PORT"
}

stop_daemon() {
  if daemon_running; then kill "$(cat "$PID_FILE")"; say "stopped git daemon"; fi
  rm -f "$PID_FILE"
}

local_up() { bun "$SCRIPT_DIR/local-up.ts" "$@"; }

command="${1:-up}"
[[ $# -gt 0 ]] && shift

case "$command" in
  up)
    refresh_mirror
    start_daemon
    MATE_FACTORY_REPOSITORIES="$REMOTE_URL" local_up up "$@"
    ;;
  down)
    local_up down "$@"
    stop_daemon
    ;;
  reset)
    # local-up.ts removes .local/, the mirror and the factory's branches with it.
    stop_daemon
    local_up reset "$@"
    ;;
  pull)
    [[ -d "$MIRROR" ]] || { say "no mirror yet; run up first"; exit 1; }
    git -C "$REPO_ROOT" fetch --no-tags "$MIRROR" '+refs/heads/*:refs/remotes/factory/*'
    ;;
  logs)
    local_up logs "$@"
    ;;
  *)
    echo "usage: dogfood.sh [up|down|reset|pull|logs] [--companion <path>]" >&2
    exit 2
    ;;
esac
