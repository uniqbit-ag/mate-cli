#!/usr/bin/env bash
# Pre-installs the Claude Code harness bridge a Workset runs, at exactly the
# version Mate pins, so starting a run installs nothing.
#
#   mate-bake-harness-bridge <tools-dir> <destination>
#
# Workset sandboxes use Bun only: the bridge's own pnpm lockfile is installed
# frozen with `bun install`, and Workset runs link these packages instead of
# installing. A Mate that pins no harness bakes nothing; one whose installed
# harness differs from its pin fails.
set -euo pipefail

TOOLS="${1:?usage: mate-bake-harness-bridge <tools-dir> <destination>}"
DEST="${2:?usage: mate-bake-harness-bridge <tools-dir> <destination>}"
CORE="$TOOLS/node_modules/@uniqbit/mate-core"

pinned="$(node -p 'require(process.argv[1]).dependencies?.["@ai-sdk/harness-claude-code"] ?? ""' "$CORE/package.json")"
if [[ -z "$pinned" ]]; then
  echo "mate-bake-harness-bridge: this Mate pins no Claude Code harness; nothing to bake"
  exit 0
fi

harness="$CORE/node_modules/@ai-sdk/harness-claude-code"
[[ -d "$harness" ]] || harness="$TOOLS/node_modules/@ai-sdk/harness-claude-code"
installed="$(node -p 'require(process.argv[1]).version' "$harness/package.json")"
if [[ "$installed" != "$pinned" ]]; then
  echo "mate-bake-harness-bridge: the installed harness $installed is not the pinned $pinned" >&2
  exit 1
fi

bridge="$harness/dist/bridge"
mkdir -p "$DEST"
cp "$bridge/package.json" "$DEST/package.json"
cp "$bridge/pnpm-lockfile.yaml" "$DEST/pnpm-lock.yaml"
cp "$bridge/pnpm-workspace.yaml" "$DEST/pnpm-workspace.yaml"
cp "$bridge/index.mjs" "$DEST/bridge.mjs"
(
  cd "$DEST"
  bun install --frozen-lockfile
  ./node_modules/.bin/claude --version >/dev/null
)
echo "$installed" > "$DEST/VERSION"
echo "mate-bake-harness-bridge: baked the Claude Code harness bridge $installed into $DEST"
