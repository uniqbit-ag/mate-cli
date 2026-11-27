#!/usr/bin/env bash
# Installs Studio Chat's harness bridges at exactly the versions the installed
# Mate pins, so a chat turn in the container installs and downloads nothing.
#
#   mate-prepare-chat-bridges <tools-dir> <destination>
#
# Mate's own script runs each harness's bootstrap through the chat's sandbox:
# the bridge lockfile pins every package, native binaries included, and the
# result carries the chat's guards and the marker a turn checks. Studio finds
# it through MATE_STUDIO_CHAT_BRIDGES and never writes into it.
set -euo pipefail

TOOLS="${1:?usage: mate-prepare-chat-bridges <tools-dir> <destination>}"
DEST="${2:?usage: mate-prepare-chat-bridges <tools-dir> <destination>}"
CORE="$TOOLS/node_modules/@uniqbit/mate-core"

pinned="$(node -p 'require(process.argv[1]).dependencies["@ai-sdk/harness-claude-code"]' "$CORE/package.json")"
harness="$CORE/node_modules/@ai-sdk/harness-claude-code"
[[ -d "$harness" ]] || harness="$TOOLS/node_modules/@ai-sdk/harness-claude-code"
installed="$(node -p 'require(process.argv[1]).version' "$harness/package.json")"
if [[ "$installed" != "$pinned" ]]; then
  echo "mate-prepare-chat-bridges: the installed Claude Code harness $installed is not the pinned $pinned" >&2
  exit 1
fi

rm -rf "$DEST"
# A scratch HOME: Mate and Bun keep nothing of the build in a real home.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
HOME="$scratch" bun "$CORE/src/lib/studio-chat/prepare-bridges.ts" "$DEST"

compgen -G "$DEST/claude-code/.bootstrap-*.ok" >/dev/null \
  || { echo "mate-prepare-chat-bridges: the Claude Code bridge has no bootstrap marker" >&2; exit 1; }
"$DEST/claude-code/node_modules/.bin/claude" --version >/dev/null 2>&1 \
  || { echo "mate-prepare-chat-bridges: the Claude Code bridge's Agent SDK binary does not run" >&2; exit 1; }
# Readable by the container's user, written by nobody but this build.
chmod -R a+rX,go-w "$DEST"
echo "mate-prepare-chat-bridges: prepared the Claude Code bridge $installed in $DEST"
