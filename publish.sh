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

REGISTRY="https://registry.npmjs.org/"

if [[ $# -lt 1 || $# -gt 2 || -z "${1:-}" ]]; then
  echo "Usage: ./publish.sh <latest|canary> [release-tag]" >&2
  exit 1
fi

TAG="$1"

# Publication needs the OIDC identity only the release workflow's publish job
# receives; anywhere else there is no credential, and no other path is allowed.
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${GITHUB_WORKFLOW_REF:-}" != */.github/workflows/release.yml@* ]]; then
  echo "Error: publish.sh only runs inside the release workflow (.github/workflows/release.yml)." >&2
  echo "Run bun release or bun release:canary; the pushed signed tag starts the publication." >&2
  exit 1
fi

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

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but was not found in PATH." >&2
  exit 1
fi

read_version() {
  node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$1/package.json"
}

VERSION="$(read_version "$ROOT_DIR/apps/mate-cli")"

for DIR in "${PACKAGE_DIRS[@]}"; do
  PACKAGE_VERSION="$(read_version "$DIR")"
  if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
    echo "Error: $DIR/package.json is at version '$PACKAGE_VERSION' but @uniqbit/mate is at '$VERSION'." >&2
    echo "All public packages must be released with synchronized versions (run the release pipeline, not npm publish directly)." >&2
    exit 1
  fi
done

if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  CHANNEL="latest"
elif [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$ ]]; then
  CHANNEL="canary"
else
  echo "Error: unsupported version shape '$VERSION'; expected x.y.z (latest) or x.y.z-canary.n (canary)." >&2
  exit 1
fi

if [[ "$TAG" != "$CHANNEL" ]]; then
  echo "Error: version '$VERSION' cannot be published with dist-tag $TAG; it belongs to $CHANNEL." >&2
  exit 1
fi

# A dispatched retry runs on a branch ref, so the workflow passes the tag.
RELEASE_TAG="${2:-${GITHUB_REF_NAME:-}}"
if [[ "$RELEASE_TAG" != "$VERSION" ]]; then
  echo "Error: release tag '$RELEASE_TAG' does not match version '$VERSION' of ${PACKAGE_NAMES[*]}." >&2
  echo "Publish only from the signed tag release-it created for this version." >&2
  exit 1
fi

PACK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$PACK_DIR"
}
trap cleanup EXIT

for NAME in "${PACKAGE_NAMES[@]}"; do
  echo "Previewing $NAME@$VERSION publish contents..."
  npm pack --dry-run --workspace "$NAME"
done

# The image locks pin the integrity release preparation packed at the version
# bump. A tree changed since then would publish a tarball the image can never
# install, and a published version cannot be replaced — so nothing is published
# unless every pin still matches. Each package is packed exactly once, by the
# same image-pin rule release preparation used, and that verified tarball is
# the file published below.
VERIFIED="$(bun "$ROOT_DIR/apps/mate-container/scripts/image-pins.ts" verify "$VERSION" "$PACK_DIR" "$ROOT_DIR")"
PACKED_INTEGRITIES=()
PACKED_TARBALLS=()
while IFS=$'\t' read -r NAME INTEGRITY TARBALL; do
  EXPECTED="${PACKAGE_NAMES[${#PACKED_TARBALLS[@]}]:-}"
  if [[ "$NAME" != "$EXPECTED" ]]; then
    echo "Error: image-pins verify reported '$NAME' where '$EXPECTED' was expected; nothing was published." >&2
    exit 1
  fi
  PACKED_INTEGRITIES+=("$INTEGRITY")
  PACKED_TARBALLS+=("$TARBALL")
done <<< "$VERIFIED"
if [[ ${#PACKED_TARBALLS[@]} -ne ${#PACKAGE_NAMES[@]} ]]; then
  echo "Error: image-pins verify reported ${#PACKED_TARBALLS[@]} of ${#PACKAGE_NAMES[@]} packages; nothing was published." >&2
  exit 1
fi

# Prints the registry integrity of an exact version, or nothing when that
# version does not exist. Any other registry failure stops the release.
published_integrity() {
  local output status=0
  output="$(npm view "$1@$VERSION" dist.integrity --registry "$REGISTRY" 2>&1)" || status=$?
  if [[ $status -eq 0 ]]; then
    printf "%s" "$output"
  elif [[ "$output" != *E404* ]]; then
    echo "Error: could not read $1@$VERSION from $REGISTRY:" >&2
    echo "$output" >&2
    exit 1
  fi
}

# A rerun of the release workflow completes a partial publication: versions
# already on the registry with the identical tarball are skipped, and any other
# tarball under the same version stops the run before publishing further.
for i in "${!PACKAGE_NAMES[@]}"; do
  NAME="${PACKAGE_NAMES[$i]}"
  PACKED="${PACKED_INTEGRITIES[$i]}"
  PUBLISHED="$(published_integrity "$NAME")"
  if [[ -n "$PUBLISHED" ]]; then
    if [[ "$PUBLISHED" == "$PACKED" ]]; then
      echo "Skipping $NAME@$VERSION: already published with the same integrity."
      continue
    fi
    echo "Error: $NAME@$VERSION is already published as $PUBLISHED, but this release packed $PACKED." >&2
    echo "A published version cannot be replaced; no further package was published." >&2
    exit 1
  fi

  echo "Publishing $NAME@$VERSION with tag: $TAG"
  if ! npm publish "${PACKED_TARBALLS[$i]}" --access public --tag "$TAG" --provenance --registry "$REGISTRY"; then
    echo "Error: npm rejected $NAME@$VERSION. Check its trusted publisher on npmjs.com" >&2
    echo "(repository uniqbit-ag/mate-cli, workflow release.yml, environment npm-publish) and that the job has id-token: write." >&2
    exit 1
  fi
  echo "Published $NAME@$VERSION with tag: $TAG"
done
