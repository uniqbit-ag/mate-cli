#!/usr/bin/env bash
# Fetch a file and refuse it unless it matches the digest the release recorded.
#
# Used for every standalone download in the image build, including the OpenCode
# installer — which is fetched and checked here rather than piped into a shell,
# so a moved install script fails the build instead of running.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: fetch-verified <url> <sha256> <destination>" >&2
  exit 2
fi

URL="$1"
EXPECTED="$2"
DESTINATION="$3"

if [[ ! "$EXPECTED" =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-verified: expected digest for $URL is not a sha256: '$EXPECTED'" >&2
  exit 2
fi

mkdir -p "$(dirname "$DESTINATION")"
curl --fail --silent --show-error --location --retry 3 --output "$DESTINATION" "$URL"

ACTUAL="$(sha256sum "$DESTINATION" | cut -d' ' -f1)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  rm -f "$DESTINATION"
  echo "fetch-verified: $URL" >&2
  echo "  expected sha256 $EXPECTED" >&2
  echo "  received sha256 $ACTUAL" >&2
  exit 1
fi
