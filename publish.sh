#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$ROOT_DIR/apps/mate-cli"

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "Usage: ./publish.sh <latest|canary>" >&2
  exit 1
fi

TAG="$1"

case "$TAG" in
  latest|canary) ;;
  *)
    echo "Error: unsupported npm dist-tag '$TAG'; expected latest or canary." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found in PATH." >&2
  exit 1
fi

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$PACKAGE_DIR/package.json")"

if [[ "$TAG" == "latest" && ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version '$VERSION' cannot be published with dist-tag latest; expected a stable version." >&2
  exit 1
fi

if [[ "$TAG" == "canary" && ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$ ]]; then
  echo "Error: version '$VERSION' cannot be published with dist-tag canary; expected x.y.z-canary.n." >&2
  exit 1
fi

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "Error: NPM_TOKEN environment variable is not set." >&2
  echo "Export it from your npmjs.com account settings (Access Tokens)." >&2
  exit 1
fi

NPMRC_PATH="$(mktemp)"
cleanup() {
  rm -f "$NPMRC_PATH"
}
trap cleanup EXIT

cat > "$NPMRC_PATH" <<EOF
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
@uniqbit:registry=https://registry.npmjs.org/
EOF

echo "Previewing @uniqbit/mate@$VERSION publish contents..."
NPM_CONFIG_USERCONFIG="$NPMRC_PATH" npm pack --dry-run --workspace @uniqbit/mate

echo "Publishing @uniqbit/mate@$VERSION with tag: $TAG"
NPM_CONFIG_USERCONFIG="$NPMRC_PATH" npm publish --workspace @uniqbit/mate --access public --tag "$TAG"

echo "Published @uniqbit/mate@$VERSION with tag: $TAG"
