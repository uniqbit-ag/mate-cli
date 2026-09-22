#!/usr/bin/env bash
# The Mate appliance entrypoint: a small supervisor over two processes.
#
# It is a supervisor rather than an `exec`, because `exec` gives one correct
# process and one orphan. The container is either serving both the agent
# session and Studio, or it is gone.
#
# Which status the container exits with: the first process to end *on its own*
# decides it, whichever one that was. Studio dying is as much a failure of the
# appliance as the session dying, so reporting the session's status in both
# cases would tell an operator watching restarts that a container which died of
# a broken Studio exited zero. The status of the process stopped as cleanup is
# discarded — that process did not fail, it was killed.
set -uo pipefail

# `wait -n -p` is how this script learns *which* process ended and with what
# status; without it the container could not tell a failed Studio from a failed
# session. Checked rather than assumed, so a wrong shell fails in one line
# instead of behaving strangely.
if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
  echo "mate-appliance: this entrypoint needs bash 5.1 or newer; this is ${BASH_VERSION}." >&2
  exit 1
fi

STARTUP_SCRIPT="${MATE_STARTUP_SCRIPT:-/opt/mate/tools/startup/startup.ts}"
BUN="${MATE_BUN:-bun}"
MATE="${MATE_COMMAND:-mate}"

# The appliance's version is a property of its image. Declared before the first
# Mate invocation so registration, preparation, inspection, the session, Studio
# and every descendant inherit it: under the pinned policy a cached newer
# version blocks nothing, no registry is contacted, and the update-state cache
# is neither read nor written. Every other gate stays effective.
export MATE_UPDATE_POLICY=pinned

log() { printf 'mate-appliance: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Startup. Nothing is served until all of it has succeeded, so a failed startup
# leaves neither process running and the container never reports itself ready.
# ---------------------------------------------------------------------------
PLAN="$("$BUN" "$STARTUP_SCRIPT")" || exit 1
eval "$PLAN" || fail "the startup plan could not be read"

: "${MATE_PLAN_COMPANION:?startup produced no companion}"
: "${MATE_PLAN_AGENT_PORT:?startup produced no agent port}"
: "${MATE_PLAN_STUDIO_PORT:?startup produced no Studio port}"

# Credentials never touch the filesystem: they are evaluated straight into this
# shell's environment, inherited by the session, and gone when the container is.
CREDENTIALS="$("$BUN" "$STARTUP_SCRIPT" --credentials)" || exit 1
if [[ -n "$CREDENTIALS" ]]; then
  eval "$CREDENTIALS" || fail "the supplied credentials could not be read"
fi
unset CREDENTIALS

STUDIO_ARGS=(studio serve --port "$MATE_PLAN_STUDIO_PORT" --host "$MATE_PLAN_STUDIO_HOST")
[[ -n "$MATE_PLAN_STUDIO_WRITABLE" ]] && STUDIO_ARGS+=(--writable)

# The launch parsers treat everything before `--` as Mate's and filter the
# reserved tokens after it, so both halves live on one line: the tokens Mate
# reads, then the arguments OpenCode reads.
#
# `--yes` is belt and braces — the confirmation predicate already skips the
# prompt without a TTY, and a container that acquires one should still not stop
# for a question.
AGENT_ARGS=(
  opencode --
  --companion --yes
  web --port "$MATE_PLAN_AGENT_PORT" --hostname "$MATE_PLAN_AGENT_HOST"
)

# ---------------------------------------------------------------------------
# The two processes.
# ---------------------------------------------------------------------------
STUDIO_PID=""
AGENT_PID=""
# Which signal this supervisor sent, so a `128 + signal` status it caused can be
# told apart from the same status arising from anything else.
SENT_SIGNAL=""
TERMINATING=""

stop_process() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
}

forward() {
  local signal="$1"
  TERMINATING=1
  SENT_SIGNAL="$signal"
  log "received SIG$signal; stopping both processes"
  [[ -n "$STUDIO_PID" ]] && kill -"$signal" "$STUDIO_PID" 2>/dev/null
  [[ -n "$AGENT_PID" ]] && kill -"$signal" "$AGENT_PID" 2>/dev/null
  return 0
}

trap 'forward INT' INT
trap 'forward TERM' TERM

cd "$MATE_PLAN_COMPANION" || fail "the selected companion $MATE_PLAN_COMPANION is not reachable"

# Job control, only while the two processes are started.
#
# A shell without it starts every background command with SIGINT ignored, and a
# signal ignored on entry cannot be trapped or reset — so a forwarded SIGINT
# would reach two processes that are constitutionally unable to act on it, and
# the container would sit there until something killed it. The disposition is
# fixed when each child is started, so job control is turned off again straight
# afterwards rather than left on to narrate every job to the container's log.
set -m
"$MATE" "${STUDIO_ARGS[@]}" &
STUDIO_PID=$!

# The companion is named to the session explicitly, so which companion it runs
# against does not depend on the directory the container happened to start in.
MATE_ARTIFACT_PATH="$MATE_PLAN_COMPANION" "$MATE" "${AGENT_ARGS[@]}" &
AGENT_PID=$!
set +m

log "studio on $MATE_PLAN_STUDIO_HOST:$MATE_PLAN_STUDIO_PORT, session on $MATE_PLAN_AGENT_HOST:$MATE_PLAN_AGENT_PORT"

# ---------------------------------------------------------------------------
# Wait for the first process to end, whichever it is, then stop the other.
# ---------------------------------------------------------------------------
FIRST=""
FIRST_STATUS=0

while :; do
  # `wait -n -p` reports *which* child ended and returns that child's own
  # status. A trapped signal interrupts the wait instead, returning 128 + n and
  # leaving the variable *unset* — that is not a child ending, so the loop
  # simply waits again after the trap has forwarded the signal.
  ENDED=""
  wait -n -p ENDED "$STUDIO_PID" "$AGENT_PID"
  status=$?
  [[ -z "${ENDED:-}" ]] && continue
  FIRST_STATUS=$status
  if [[ "$ENDED" == "$STUDIO_PID" ]]; then FIRST="studio"; else FIRST="session"; fi
  break
done

log "$FIRST ended with status $FIRST_STATUS; stopping the other"

if [[ "$FIRST" == "studio" ]]; then
  stop_process "$AGENT_PID"
  wait "$AGENT_PID" 2>/dev/null
  wait "$STUDIO_PID" 2>/dev/null
else
  stop_process "$STUDIO_PID"
  wait "$STUDIO_PID" 2>/dev/null
  wait "$AGENT_PID" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Report the first independent exit, normalizing only a stop this container
# caused: the operator's termination forwarded to both, or the cleanup signal
# sent to the survivor. Any other status is reported exactly as it was — an
# unrelated SIGTERM is still a failure, and an OOM kill (137) is not a clean
# shutdown.
# ---------------------------------------------------------------------------
signal_number() {
  case "$1" in
    INT) echo 2 ;;
    TERM) echo 15 ;;
    *) echo "" ;;
  esac
}

if (( FIRST_STATUS > 128 )) && [[ -n "$TERMINATING" ]]; then
  expected="$(signal_number "$SENT_SIGNAL")"
  if [[ -n "$expected" ]] && (( FIRST_STATUS == 128 + expected )); then
    log "stopped by SIG$SENT_SIGNAL, which this container forwarded; exiting 0"
    exit 0
  fi
fi

exit "$FIRST_STATUS"
