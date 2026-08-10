#!/usr/bin/env bash
# Pack the working tree and install it as the global `mate` without
# publishing: @uniqbit/mate@<x.y.z>-local.<n>, replacing whatever version is
# currently installed (restore the published one with
# `npm install -g @uniqbit/mate@latest`).
#
# The CLI pins exact registry versions of @uniqbit/mate-core and
# @uniqbit/mate-opencode-plugin, so this script rewires those pins to the
# locally packed tarballs (file: dependencies) before packing the CLI. All
# package.json edits are reverted on exit.
#
# Usage: ./pack-local.sh [n] [--no-install]
#   n            local prerelease counter (default 0)
#   --no-install pack only; print the tarball paths instead of installing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

LOCAL_N="0"
INSTALL=1
for ARG in "$@"; do
  case "$ARG" in
    --no-install) INSTALL=0 ;;
    [0-9]*) LOCAL_N="$ARG" ;;
    *)
      echo "Usage: ./pack-local.sh [n] [--no-install]" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required but was not found in PATH." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found in PATH." >&2
  exit 1
fi

CORE_PKG="$ROOT_DIR/packages/mate-core/package.json"
PLUGIN_PKG="$ROOT_DIR/apps/mate-opencode-plugin/package.json"
CLI_PKG="$ROOT_DIR/apps/mate-cli/package.json"

BASE_VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version.split("-")[0]' "$CLI_PKG")"
VERSION="${BASE_VERSION}-local.${LOCAL_N}"

OUT_DIR="$(mktemp -d -t mate-pack-local)"
echo "Packing @uniqbit/mate@$VERSION into $OUT_DIR"

cp "$CORE_PKG" "$OUT_DIR/core.package.json.bak"
cp "$PLUGIN_PKG" "$OUT_DIR/plugin.package.json.bak"
cp "$CLI_PKG" "$OUT_DIR/cli.package.json.bak"

restore() {
  cp "$OUT_DIR/core.package.json.bak" "$CORE_PKG"
  cp "$OUT_DIR/plugin.package.json.bak" "$PLUGIN_PKG"
  cp "$OUT_DIR/cli.package.json.bak" "$CLI_PKG"
}
trap restore EXIT

node - "$VERSION" "$CORE_PKG" "$PLUGIN_PKG" "$CLI_PKG" "$OUT_DIR" <<'EOF'
const fs = require("fs");
const [version, corePath, pluginPath, cliPath, outDir] = process.argv.slice(2);

const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

const core = load(corePath);
core.version = version;
save(corePath, core);

const plugin = load(pluginPath);
plugin.version = version;
plugin.dependencies["@uniqbit/mate-core"] = `file:${outDir}/uniqbit-mate-core-${version}.tgz`;
save(pluginPath, plugin);

const cli = load(cliPath);
cli.version = version;
cli.dependencies["@uniqbit/mate-core"] = `file:${outDir}/uniqbit-mate-core-${version}.tgz`;
cli.dependencies["@uniqbit/mate-opencode-plugin"] =
  `file:${outDir}/uniqbit-mate-opencode-plugin-${version}.tgz`;
save(cliPath, cli);
EOF

# Pack order matters: the CLI's file: dependencies must exist before npm
# resolves them at install time.
(cd "$ROOT_DIR/packages/mate-core" && CI=1 npm pack --pack-destination "$OUT_DIR" >/dev/null)
echo "Packed @uniqbit/mate-core@$VERSION"
(cd "$ROOT_DIR/apps/mate-opencode-plugin" && CI=1 npm pack --pack-destination "$OUT_DIR" >/dev/null)
echo "Packed @uniqbit/mate-opencode-plugin@$VERSION"
(cd "$ROOT_DIR/apps/mate-cli" && CI=1 npm pack --pack-destination "$OUT_DIR" >/dev/null)
echo "Packed @uniqbit/mate@$VERSION"

CLI_TARBALL="$OUT_DIR/uniqbit-mate-$VERSION.tgz"

if [[ "$INSTALL" -eq 0 ]]; then
  echo ""
  echo "Tarballs:"
  ls "$OUT_DIR"/*.tgz
  echo ""
  echo "Install with: CI=1 npm install -g $CLI_TARBALL"
  exit 0
fi

echo "Installing globally (replaces the installed @uniqbit/mate)..."
CI=1 npm install -g "$CLI_TARBALL"

# Seed OpenCode's plugin cache. `mate sync` pins
# @uniqbit/mate-opencode-plugin@<local version> in the global OpenCode config,
# but neither OpenCode's on-demand install nor mate's prefetch can fetch an
# unpublished version from npm — without this seed the plugin silently never
# loads. Mirrors OpenCode's layout: <cache>/packages/<spec>/ containing a
# package.json plus node_modules; OpenCode skips install when
# node_modules/<name> already exists and imports the package's ./server export.
OPENCODE_SPEC_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/@uniqbit/mate-opencode-plugin@$VERSION"
rm -rf "$OPENCODE_SPEC_DIR"
mkdir -p "$OPENCODE_SPEC_DIR"
# package.json must exist before npm install: npm otherwise walks up to
# ~/.cache/opencode/package.json and installs the plugin there.
printf '{\n  "dependencies": {\n    "@uniqbit/mate-opencode-plugin": "%s"\n  }\n}\n' "$VERSION" \
  > "$OPENCODE_SPEC_DIR/package.json"
(cd "$OPENCODE_SPEC_DIR" && CI=1 npm install --no-audit --no-fund --no-save --silent \
  "$OUT_DIR/uniqbit-mate-opencode-plugin-$VERSION.tgz")
echo "Seeded OpenCode plugin cache: $OPENCODE_SPEC_DIR"

echo ""
echo "Installed: mate $(mate --version)"
echo "Try it:    mate sync --check   (read-only staleness report)"
echo "Restore:   npm install -g @uniqbit/mate@latest"
echo "           (then remove the seeded dir above so OpenCode reinstalls from npm)"
