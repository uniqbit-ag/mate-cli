#!/usr/bin/env bash
# Factory mode's root supervisor: Sysbox, the inner Docker daemon and the
# factory broker as root, then the ordinary appliance startup as `mate`.
#
# It stays PID 1 so it can stop things in order: Studio and its sessions
# first, then Workset containers (stopped, not deleted), the broker, the
# inner daemon and Sysbox. The Workset agent credential reaches the broker
# only; the unprivileged startup gets neither the variables nor a config file
# that holds them.
set -uo pipefail

if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
  echo "mate-appliance: this entrypoint needs bash 5.1 or newer; this is ${BASH_VERSION}." >&2
  exit 1
fi

STARTUP_SCRIPT="${MATE_STARTUP_SCRIPT:-/opt/mate/tools/startup/startup.ts}"
BUN="${MATE_BUN:-bun}"
MATE="${MATE_COMMAND:-mate}"
DOCKER="${MATE_DOCKER_COMMAND:-docker}"
DOCKERD="${MATE_DOCKERD_COMMAND:-dockerd}"
SYSBOX_MGR="${MATE_SYSBOX_MGR_COMMAND:-sysbox-mgr}"
SYSBOX_FS="${MATE_SYSBOX_FS_COMMAND:-sysbox-fs}"
APPLIANCE="${MATE_APPLIANCE_ENTRYPOINT:-/usr/local/bin/mate-appliance}"
DAEMON_CONFIG="${MATE_FACTORY_DAEMON_CONFIG:-/etc/mate-factory/daemon.json}"
RUN_DIR="${MATE_FACTORY_RUN_DIR:-/run/mate-factory}"
STATE_DIR="${MATE_FACTORY_STATE_DIR:-/var/lib/mate-factory}"
SYSBOX_RUN_DIR="${MATE_SYSBOX_RUN_DIR:-/run/sysbox}"
CGROUP_ROOT="${MATE_CGROUP_ROOT:-/sys/fs/cgroup}"
WORKSET_ARCHIVE="${MATE_WORKSET_ARCHIVE:-/opt/mate/workset-rootfs.tar}"
WORKSET_CONF="${MATE_WORKSET_CONF:-/opt/mate/workset-image.conf}"
WORKSET_IMAGE="mate-workset:${MATE_VERSION:?mate-appliance: MATE_VERSION is not set}"
READY_SECONDS="${MATE_FACTORY_READY_SECONDS:-60}"
USER_NAME=mate
# The image's HOME is mate's volume: root's own processes keep their state out of
# it, or a fresh volume gets root-owned ~/.mate that Studio cannot write.
export HOME=/root

export MATE_UPDATE_POLICY=pinned

log() { printf 'mate-appliance: %s\n' "$*" >&2; }

SYSBOX_MGR_PID=""
SYSBOX_FS_PID=""
DOCKERD_PID=""
BROKER_PID=""
CHILD_PID=""

# Stops one started process: TERM, then KILL after the grace period.
stop_pid() {
  local pid="$1" tries=0
  [[ -z "$pid" ]] && return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null && (( tries < 150 )); do
    sleep 0.1
    tries=$((tries + 1))
  done
  kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return 0
}

# Workset containers are stopped, never removed: their filesystems are the
# Worksets' state and survive the restart.
stop_factory() {
  if [[ -n "$DOCKERD_PID" ]] && kill -0 "$DOCKERD_PID" 2>/dev/null; then
    local running
    running="$("$DOCKER" ps --quiet --filter label=dev.mate.workset 2>/dev/null)"
    if [[ -n "$running" ]]; then
      log "stopping Workset containers"
      # shellcheck disable=SC2086
      "$DOCKER" stop --time 10 $running >/dev/null 2>&1
    fi
  fi
  stop_pid "$BROKER_PID"
  stop_pid "$DOCKERD_PID"
  stop_pid "$SYSBOX_FS_PID"
  stop_pid "$SYSBOX_MGR_PID"
}

fail() {
  log "$*"
  stop_factory
  exit 1
}

# Waits up to READY_SECONDS for a condition; the process it names must stay alive.
wait_for() {
  local what="$1" pid="$2"; shift 2
  local tries=0
  until "$@" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || fail "$what exited before it became ready"
    (( tries >= READY_SECONDS * 10 )) && fail "$what did not become ready within ${READY_SECONDS}s"
    sleep 0.1
    tries=$((tries + 1))
  done
}

# A stop requested before Studio runs ends startup without reporting a failure.
trap 'log "stopped during factory startup"; stop_factory; exit 0' INT TERM

# ---------------------------------------------------------------------------
# Factory mode, its credential, and the preflight. Root without factory mode
# is refused by the startup program, naming factory mode.
# ---------------------------------------------------------------------------
FACTORY="$("$BUN" "$STARTUP_SCRIPT" --factory)" || exit 1
eval "$FACTORY" || { log "the factory plan could not be read"; exit 1; }
unset FACTORY
# From here on the credential lives only in these unexported variables, which
# no process inherits until the broker is started with it.
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY

"$BUN" "$STARTUP_SCRIPT" --factory-preflight || exit 1

mkdir -p "$RUN_DIR" "$SYSBOX_RUN_DIR" /var/lib/sysbox || fail "the factory run directories could not be created"
chown "root:$USER_NAME" "$RUN_DIR" && chmod 0750 "$RUN_DIR" \
  || fail "$RUN_DIR could not be restricted to root and $USER_NAME"

# The unprivileged startup reads its own copy of the configuration, without
# the Workset agent credential, so the original can stay readable by root only.
CHILD_CONFIG="$RUN_DIR/appliance.yaml"
"$BUN" "$STARTUP_SCRIPT" --factory-config "$CHILD_CONFIG" \
  && chown "root:$USER_NAME" "$CHILD_CONFIG" \
  || fail "the configuration could not be prepared for Studio"

# ---------------------------------------------------------------------------
# Sysbox and the inner daemon.
# ---------------------------------------------------------------------------
# cgroup v2: move every process out of the root cgroup so controllers can be
# delegated to the inner daemon's containers, as Docker's dind script does.
if [[ -f "$CGROUP_ROOT/cgroup.controllers" ]]; then
  mkdir -p "$CGROUP_ROOT/init"
  xargs -rn1 < "$CGROUP_ROOT/cgroup.procs" > "$CGROUP_ROOT/init/cgroup.procs" 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < "$CGROUP_ROOT/cgroup.controllers" > "$CGROUP_ROOT/cgroup.subtree_control" \
    || fail "cgroup controllers could not be delegated under $CGROUP_ROOT"
fi

"$SYSBOX_MGR" &
SYSBOX_MGR_PID=$!
wait_for sysbox-mgr "$SYSBOX_MGR_PID" test -e "$SYSBOX_RUN_DIR/sysmgr.sock"

"$SYSBOX_FS" &
SYSBOX_FS_PID=$!
wait_for sysbox-fs "$SYSBOX_FS_PID" test -e "$SYSBOX_RUN_DIR/sysfs.sock"

"$DOCKERD" --config-file "$DAEMON_CONFIG" &
DOCKERD_PID=$!
export DOCKER_HOST="unix://$RUN_DIR/docker.sock"
wait_for "the inner Docker daemon" "$DOCKERD_PID" "$DOCKER" info
chmod 0600 "$RUN_DIR/docker.sock" || fail "the inner daemon's socket could not be restricted to root"
"$DOCKER" info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' \
  || fail "the inner Docker daemon does not offer the sysbox-runc runtime"

if ! "$DOCKER" image inspect "$WORKSET_IMAGE" >/dev/null 2>&1; then
  log "loading the Workset image $WORKSET_IMAGE"
  CHANGES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && CHANGES+=(--change "$line")
  done < "$WORKSET_CONF"
  "$DOCKER" import "${CHANGES[@]}" "$WORKSET_ARCHIVE" "$WORKSET_IMAGE" >/dev/null \
    || fail "the Workset image could not be loaded from $WORKSET_ARCHIVE"
fi

# Each update imports a new Workset image; older ones go unless a Workset container
# still uses them, which `image rm` refuses to remove.
while IFS= read -r old; do
  [[ -n "$old" && "$old" != "$WORKSET_IMAGE" ]] || continue
  "$DOCKER" image rm "$old" >/dev/null 2>&1 && log "removed the unused Workset image $old"
done < <("$DOCKER" image ls --format '{{.Repository}}:{{.Tag}}' mate-workset 2>/dev/null)

# Clones and worktrees belong to mate, whose uid the Workset containers share.
install -d -m 0755 -o root -g root "$STATE_DIR" \
  && install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$STATE_DIR/repos" "$STATE_DIR/worktrees" "$STATE_DIR/runs" \
  || fail "the factory state directories under $STATE_DIR could not be prepared"

# ---------------------------------------------------------------------------
# The broker: the only process with the inner socket and the credential.
# ---------------------------------------------------------------------------
BROKER_SOCKET="$RUN_DIR/broker.sock"
(
  if [[ -n "$MATE_FACTORY_CREDENTIAL_NAME" ]]; then
    export "$MATE_FACTORY_CREDENTIAL_NAME=$MATE_FACTORY_CREDENTIAL_VALUE"
  fi
  exec "$MATE" factory serve --socket "$BROKER_SOCKET" --docker-host "$DOCKER_HOST" \
    --state-dir "$STATE_DIR" --image "$WORKSET_IMAGE" --user "$USER_NAME" \
    --companions-dir "${MATE_COMPANIONS_DIR:-/companions}"
) &
BROKER_PID=$!
unset MATE_FACTORY_CREDENTIAL_VALUE
wait_for "the factory broker" "$BROKER_PID" test -e "$BROKER_SOCKET"
ATTACH_SOCKET="$RUN_DIR/attach.sock"
wait_for "the factory broker's attach socket" "$BROKER_PID" test -e "$ATTACH_SOCKET"
chown "root:$USER_NAME" "$BROKER_SOCKET" "$ATTACH_SOCKET" && chmod 0660 "$BROKER_SOCKET" "$ATTACH_SOCKET" \
  || fail "the factory broker's sockets could not be opened to $USER_NAME"

# ---------------------------------------------------------------------------
# Studio, as mate, through the ordinary entrypoint.
# ---------------------------------------------------------------------------
forward() {
  log "received SIG$1; stopping Studio and its agent sessions"
  [[ -n "$CHILD_PID" ]] && kill -"$1" "$CHILD_PID" 2>/dev/null
  return 0
}
trap 'forward INT' INT
trap 'forward TERM' TERM

# Job control while starting the child, so a forwarded SIGINT is not ignored on entry.
set -m
setpriv --reuid="$USER_NAME" --regid="$USER_NAME" --init-groups --inh-caps=-all --bounding-set=-all \
  env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u DOCKER_HOST \
  HOME="/home/$USER_NAME" \
  MATE_APPLIANCE_CONFIG="$CHILD_CONFIG" \
  MATE_FACTORY_ACTIVE=1 \
  MATE_FACTORY_BROKER="$BROKER_SOCKET" \
  MATE_FACTORY_STATE_DIR="$STATE_DIR" \
  "$APPLIANCE" "$@" &
CHILD_PID=$!
set +m

CHILD_STATUS=0
while :; do
  ENDED=""
  wait -n -p ENDED "$CHILD_PID"
  status=$?
  [[ -z "${ENDED:-}" ]] && continue
  CHILD_STATUS=$status
  break
done

# Whatever the unprivileged side left behind, then the factory, in order.
pkill -TERM -u "$USER_NAME" 2>/dev/null
for _ in $(seq 1 50); do
  pgrep -u "$USER_NAME" >/dev/null 2>&1 || break
  sleep 0.1
done
pkill -KILL -u "$USER_NAME" 2>/dev/null
stop_factory

exit "$CHILD_STATUS"
