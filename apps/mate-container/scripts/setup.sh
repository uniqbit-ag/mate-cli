#!/usr/bin/env bash
# Image-owned plugin restore, run by startup only when a scoped plugin
# registry is configured. Restores the selected companion's plugins from its
# committed lockfile; never updates a tracked file.
#
# The scoped npm configuration is generated under the container user's home,
# owner-only, and references the token by name for npm to expand from this
# process's environment, so no expanded secret is written anywhere. It is
# removed whether the restore succeeds or fails.
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
