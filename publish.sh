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

# The image locks pin the integrity sync-image-inputs packed at the version
# bump. A tree changed since then would publish a tarball the image can never
# install, and a published version cannot be replaced — so nothing is published
# unless every pin still matches. Packed and hashed the way sync-image-inputs
# does; lifecycle output (prepack builds) goes to stderr so it cannot corrupt
# anything read from stdout.
LOCK_DIR="$ROOT_DIR/apps/mate-container/locks"
PACKED_INTEGRITIES=()
for NAME in "${PACKAGE_NAMES[@]}"; do
  CI=1 npm pack --workspace "$NAME" --pack-destination "$PACK_DIR" --loglevel error >&2
  PACKED_INTEGRITIES+=("$(node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const path = require("path");
    const [name, version, lockDir, packDir] = process.argv.slice(1);
    const archive = path.join(packDir, `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`);
    if (!fs.existsSync(archive)) {
      console.error(`Error: npm pack did not create ${path.basename(archive)} for ${name}.`);
      process.exit(1);
    }
    const packed = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
    let pins = 0;
    const stale = [];
    for (const file of fs.readdirSync(lockDir).filter((f) => f.endsWith(".package-lock.json")).sort()) {
      const entry = JSON.parse(fs.readFileSync(path.join(lockDir, file), "utf8")).packages?.[`node_modules/${name}`];
      if (!entry) continue;
      pins += 1;
      if (entry.version !== version || entry.integrity !== packed) stale.push(file);
    }
    if (pins === 0) {
      console.error(`Error: no image lock in ${lockDir} pins ${name}.`);
      process.exit(1);
    }
    if (stale.length > 0) {
      console.error(`Error: ${name}@${version} would publish as ${packed}, but ${stale.join(", ")} pin another tarball.`);
      console.error("The tagged tree does not pack to the tarball pinned at the version bump; nothing was published.");
      process.exit(1);
    }
    process.stdout.write(packed);
  ' "$NAME" "$VERSION" "$LOCK_DIR" "$PACK_DIR")")
done

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
  if ! npm publish --workspace "$NAME" --access public --tag "$TAG" --provenance --registry "$REGISTRY"; then
    echo "Error: npm rejected $NAME@$VERSION. Check its trusted publisher on npmjs.com" >&2
    echo "(repository uniqbit-ag/mate-cli, workflow release.yml, environment npm-publish) and that the job has id-token: write." >&2
    exit 1
  fi
  echo "Published $NAME@$VERSION with tag: $TAG"
done
