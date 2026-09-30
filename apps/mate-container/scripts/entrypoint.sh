#!/usr/bin/env bash
# The Mate appliance entrypoint: a small supervisor over Studio.
#
# It supervises rather than `exec`s because agent sessions started from
# Studio's terminal are Studio's descendants in their own process groups: if
# Studio dies on its own, something has to stop what it left behind before the
# container reports Studio's outcome. An agent session ending is Studio's
# business and never ends the container.
set -uo pipefail

# `wait -n -p` is how this script tells Studio ending apart from a trapped
# signal interrupting the wait. Checked rather than assumed, so a wrong shell
# fails in one line instead of behaving strangely.
if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
  echo "mate-appliance: this entrypoint needs bash 5.1 or newer; this is ${BASH_VERSION}." >&2
  exit 1
fi

STARTUP_SCRIPT="${MATE_STARTUP_SCRIPT:-/opt/mate/tools/startup/startup.ts}"
BUN="${MATE_BUN:-bun}"
MATE="${MATE_COMMAND:-mate}"

# The appliance's version is a property of its image. Declared before the first
# Mate invocation so registration, preparation, inspection, Studio, the agent
# sessions its terminal starts, and every descendant inherit it: under the
# pinned policy a cached newer version blocks nothing, no registry is contacted,
# and the update-state cache is neither read nor written. Every other gate stays effective.
export MATE_UPDATE_POLICY=pinned

log() { printf 'mate-appliance: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Startup. Nothing is served until all of it has succeeded, so a failed startup
# leaves nothing running and the container never reports itself ready.
# ---------------------------------------------------------------------------
PLAN="$("$BUN" "$STARTUP_SCRIPT")" || exit 1
eval "$PLAN" || fail "the startup plan could not be read"

: "${MATE_PLAN_COMPANION:?startup produced no companion}"
: "${MATE_PLAN_STUDIO_PORT:?startup produced no Studio port}"

# Credentials never touch the filesystem: they are evaluated straight into this
# shell's environment, inherited by Studio and the agent sessions it starts, and
# gone when the container is.
CREDENTIALS="$("$BUN" "$STARTUP_SCRIPT" --credentials)" || exit 1
if [[ -n "$CREDENTIALS" ]]; then
  eval "$CREDENTIALS" || fail "the supplied credentials could not be read"
fi
unset CREDENTIALS

STUDIO_ARGS=(studio serve --port "$MATE_PLAN_STUDIO_PORT" --host "$MATE_PLAN_STUDIO_HOST")
[[ -n "$MATE_PLAN_STUDIO_WRITABLE" ]] && STUDIO_ARGS+=(--writable)
if [[ -n "${MATE_PLAN_STUDIO_TERMINAL:-}" ]]; then
  # Every launch targets the startup-selected companion, whatever the page is
  # browsing. `--no-git` unless synchronization was asked for: a launch's own
  # Git sync is on by default, and a container with no remote credentials would
  # otherwise fail its first launch on a fetch nobody wanted.
  STUDIO_ARGS+=(--terminal --detach-timeout "${MATE_PLAN_STUDIO_DETACH_MINUTES:-30}" --companion "$MATE_PLAN_COMPANION")
  [[ -z "${MATE_PLAN_GIT_SYNC:-}" ]] && STUDIO_ARGS+=(--no-git)
fi
if [[ -n "${MATE_PLAN_STUDIO_ALLOWED_HOSTS:-}" ]]; then
  STUDIO_ARGS+=(--allowed-host "$MATE_PLAN_STUDIO_ALLOWED_HOSTS")
fi
if [[ -n "${MATE_PLAN_STUDIO_PUBLIC_ORIGIN:-}" ]]; then
  STUDIO_ARGS+=(--public-origin "$MATE_PLAN_STUDIO_PUBLIC_ORIGIN")
fi

# ---------------------------------------------------------------------------
# Studio.
# ---------------------------------------------------------------------------
STUDIO_PID=""
# Which signal this supervisor sent, so a `128 + signal` status it caused can be
# told apart from the same status arising from anything else.
SENT_SIGNAL=""
TERMINATING=""

forward() {
  local signal="$1"
  TERMINATING=1
  SENT_SIGNAL="$signal"
  log "received SIG$signal; stopping Studio and its agent sessions"
  [[ -n "$STUDIO_PID" ]] && kill -"$signal" "$STUDIO_PID" 2>/dev/null
  return 0
}

trap 'forward INT' INT
trap 'forward TERM' TERM

# Whatever Studio left behind — agent sessions in their own process groups
# when Studio died without ending them. Only as the container's init: anywhere
# else `kill -1` would reach the operator's own processes.
stop_leftovers() {
  (( $$ == 1 )) || return 0
  kill -TERM -1 2>/dev/null || return 0
  local tries=0
  while kill -0 -1 2>/dev/null && (( tries < 50 )); do
    sleep 0.1
    tries=$((tries + 1))
  done
  kill -KILL -1 2>/dev/null || true
  wait 2>/dev/null
}

cd "$MATE_PLAN_COMPANION" || fail "the selected companion $MATE_PLAN_COMPANION is not reachable"

# Job control, only while Studio is started.
#
# A shell without it starts every background command with SIGINT ignored, and a
# signal ignored on entry cannot be trapped or reset — so a forwarded SIGINT
# would reach a Studio constitutionally unable to act on it, and the container
# would sit there until something killed it. The disposition is fixed when the
# child is started, so job control is turned off again straight afterwards.
set -m
MATE_ARTIFACT_PATH="$MATE_PLAN_COMPANION" "$MATE" "${STUDIO_ARGS[@]}" &
STUDIO_PID=$!
set +m

log "studio on $MATE_PLAN_STUDIO_HOST:$MATE_PLAN_STUDIO_PORT"

# ---------------------------------------------------------------------------
# Wait for Studio to end.
# ---------------------------------------------------------------------------
STUDIO_STATUS=0
while :; do
  # A trapped signal interrupts the wait, returning 128 + n and leaving the
  # variable *unset* — that is not Studio ending, so the loop waits again after
  # the trap has forwarded the signal.
  ENDED=""
  wait -n -p ENDED "$STUDIO_PID"
  status=$?
  [[ -z "${ENDED:-}" ]] && continue
  STUDIO_STATUS=$status
  break
done

log "studio ended with status $STUDIO_STATUS"
stop_leftovers

# ---------------------------------------------------------------------------
# Report Studio's outcome, normalizing only a stop this container caused: the
# operator's termination forwarded to Studio. Any other status is reported
# exactly as it was — an unrelated SIGTERM is still a failure, and an OOM kill
# (137) is not a clean shutdown.
# ---------------------------------------------------------------------------
signal_number() {
  case "$1" in
    INT) echo 2 ;;
    TERM) echo 15 ;;
    *) echo "" ;;
  esac
}

if (( STUDIO_STATUS > 128 )) && [[ -n "$TERMINATING" ]]; then
  expected="$(signal_number "$SENT_SIGNAL")"
  if [[ -n "$expected" ]] && (( STUDIO_STATUS == 128 + expected )); then
    log "stopped by SIG$SENT_SIGNAL, which this container forwarded; exiting 0"
    exit 0
  fi
fi

exit "$STUDIO_STATUS"
