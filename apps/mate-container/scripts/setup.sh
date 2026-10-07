#!/usr/bin/env bash
# Frozen plugin restore from the companion's lockfile; run by startup when a
# plugin registry is configured. The npm config is owner-only, references the
# token by name (no expanded secret on disk) and is removed on exit.
set -euo pipefail

COMPANION="${1:?usage: setup.sh <companion-path>}"
: "${MATE_PLUGIN_REGISTRY_SCOPE:?}" "${MATE_PLUGIN_REGISTRY_URL:?}" "${MATE_PLUGIN_REGISTRY_TOKEN:?}"
MATE="${MATE_COMMAND:-mate}"

umask 077
NPMRC="$(mktemp "${HOME:?}/.mate-setup-npmrc.XXXXXX")"
trap 'rm -f "$NPMRC"' EXIT

AUTH_PATH="${MATE_PLUGIN_REGISTRY_URL#*:}"
printf '%s:registry=%s\n//%s:_authToken=${MATE_PLUGIN_REGISTRY_TOKEN}\n' \
  "$MATE_PLUGIN_REGISTRY_SCOPE" "$MATE_PLUGIN_REGISTRY_URL" "${AUTH_PATH#//}" >"$NPMRC"

cd "$COMPANION"
NPM_CONFIG_USERCONFIG="$NPMRC" MATE_ARTIFACT_PATH="$COMPANION" \
  "$MATE" install --yes --frozen-plugins
