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
  # A throwaway cache: Bun's default one would keep every platform's Claude
  # binary in the image layer.
  cache="$(mktemp -d)"
  trap 'rm -rf "$cache"' EXIT
  BUN_INSTALL_CACHE_DIR="$cache" bun install --frozen-lockfile
  # The bridge runs only the Agent SDK's own binary for this platform and libc;
  # every other Claude native binary is ~235 MB of dead weight.
  arch="$(node -p process.arch)"
  keep="claude-agent-sdk-linux-$arch"
  sdk="node_modules/@anthropic-ai/$keep/claude"
  for pkg in node_modules/@anthropic-ai/claude-code-* node_modules/@anthropic-ai/claude-agent-sdk-*; do
    if [[ -e "$pkg" && "$(basename "$pkg")" != "$keep" ]]; then rm -rf "$pkg"; fi
  done
  # The harness bootstrap checks `./node_modules/.bin/claude --version`; the
  # pruned claude-code package has no binary left, so point it at the SDK's.
  ln -sfn "../@anthropic-ai/$keep/claude" node_modules/.bin/claude
  ./node_modules/.bin/claude --version >/dev/null 2>&1 \
    || { echo "mate-bake-harness-bridge: the bridge's Agent SDK binary $sdk does not run" >&2; exit 1; }
  # Module-load smoke: with no arguments the bridge reports its missing workdir
  # only after every import resolved.
  smoke="$(bun bridge.mjs 2>&1 || true)"
  grep -q 'Missing --workdir' <<<"$smoke" \
    || { echo "mate-bake-harness-bridge: the bridge does not load after pruning: $smoke" >&2; exit 1; }
)
echo "$installed" > "$DEST/VERSION"
echo "mate-bake-harness-bridge: baked the Claude Code harness bridge $installed into $DEST"
