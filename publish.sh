#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Publish order matters: core and plugin must exist on the registry before the
# CLI that pins them, so a partially failed publish never leaves a released
# @uniqbit/mate referencing an unpublished package version.
PACKAGE_NAMES=(
  "@uniqbit/mate-core"
  "@uniqbit/mate-opencode-plugin"
  "@uniqbit/mate"
)
PACKAGE_DIRS=(
  "$ROOT_DIR/packages/mate-core"
  "$ROOT_DIR/apps/mate-opencode-plugin"
  "$ROOT_DIR/apps/mate-cli"
)

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

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$ROOT_DIR/apps/mate-cli/package.json")"

for DIR in "${PACKAGE_DIRS[@]}"; do
  PACKAGE_VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$DIR/package.json")"
  if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
    echo "Error: $DIR/package.json is at version '$PACKAGE_VERSION' but @uniqbit/mate is at '$VERSION'." >&2
    echo "All public packages must be released with synchronized versions (run the release pipeline, not npm publish directly)." >&2
    exit 1
  fi
done

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

for NAME in "${PACKAGE_NAMES[@]}"; do
  echo "Previewing $NAME@$VERSION publish contents..."
  NPM_CONFIG_USERCONFIG="$NPMRC_PATH" npm pack --dry-run --workspace "$NAME"
done

for NAME in "${PACKAGE_NAMES[@]}"; do
  echo "Publishing $NAME@$VERSION with tag: $TAG"
  NPM_CONFIG_USERCONFIG="$NPMRC_PATH" npm publish --workspace "$NAME" --access public --tag "$TAG"
  echo "Published $NAME@$VERSION with tag: $TAG"
done

# ---------------------------------------------------------------------------
# Ask for an appliance image, now that every package it installs exists.
#
# Publication is complete at this point and stays complete: this request is
# best-effort and bounded, and nothing below changes this script's exit status.
# A release without an image is a release missing an image, not a failed one —
# and the same dispatch, run by hand with the inputs printed here, is the retry.
# ---------------------------------------------------------------------------
IMAGE_WORKFLOW="publish-image.yml"
REPOSITORY="uniqbit-ag/mate-cli"
# release-it tags the release commit with the bare version, and pushes it
# before this script runs, so the tag to build from is the version itself.
RELEASE_TAG="$VERSION"

retry_instruction() {
  echo "  Retry it with:" >&2
  echo "    gh workflow run $IMAGE_WORKFLOW --repo $REPOSITORY \\" >&2
  echo "      --field version=$VERSION --field channel=$TAG --field ref=$RELEASE_TAG" >&2
}

echo
if ! command -v gh >/dev/null 2>&1; then
  echo "Note: npm publication succeeded; the image was not requested because gh is not installed." >&2
  retry_instruction
elif ! gh auth status >/dev/null 2>&1; then
  echo "Note: npm publication succeeded; the image was not requested because gh is not authenticated." >&2
  retry_instruction
elif ! gh workflow view "$IMAGE_WORKFLOW" --repo "$REPOSITORY" >/dev/null 2>&1; then
  echo "Note: npm publication succeeded; the image was not requested because $IMAGE_WORKFLOW is not available on the default branch." >&2
  retry_instruction
elif ! gh workflow run "$IMAGE_WORKFLOW" \
        --repo "$REPOSITORY" \
        --field version="$VERSION" \
        --field channel="$TAG" \
        --field ref="$RELEASE_TAG" >/dev/null 2>&1; then
  echo "Note: npm publication succeeded; the image request was rejected." >&2
  retry_instruction
else
  echo "Requested an appliance image for $VERSION ($TAG) from $RELEASE_TAG."
  echo "The build runs on its own; this release is complete either way."
fi
