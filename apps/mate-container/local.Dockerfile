# The local test image: this working tree's Mate, over a base built from the
# unchanged release recipe. Built only by scripts/local-up.ts (see README.md),
# tagged locally, and never published — the release image installs a
# published Mate and nothing else.
#
# syntax=docker/dockerfile:1

ARG BASE_IMAGE=mate-appliance:local-base
FROM ${BASE_IMAGE}

ARG LOCAL_VERSION
ARG CORE_TARBALL
ARG CLI_TARBALL

USER root
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# The packed CLI names its core dependency by this path, so npm resolves it
# from the tarball beside it rather than the registry.
COPY ${CORE_TARBALL} ${CLI_TARBALL} /opt/mate/local/

WORKDIR /opt/mate/tools
RUN test -n "${LOCAL_VERSION}" \
 && npm install --omit=dev --no-audit --no-fund \
      "/opt/mate/local/${CORE_TARBALL}" "/opt/mate/local/${CLI_TARBALL}" \
 && test -f /opt/mate/tools/node_modules/@uniqbit/mate-core/opencode-plugin/server.ts \
 && scratch="$(mktemp -d)" \
 && test "$(HOME="${scratch}" MATE_UPDATE_POLICY=pinned mate --version | tail -1)" = "${LOCAL_VERSION}" \
 && rm -rf "${scratch}" \
 && { test ! -e /root/.mate || { echo "unexpected /root/.mate" >&2; exit 1; }; }

LABEL ai.mate.version="${LOCAL_VERSION}" \
      ai.mate.local-build="working tree; local only, do not publish"

ENV MATE_VERSION=${LOCAL_VERSION}

USER mate
WORKDIR /home/mate
