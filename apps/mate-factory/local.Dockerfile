# The local test image: this working tree's Mate, over a base built from the
# unchanged release recipe. Built only by scripts/local-up.ts (see README.md),
# tagged locally, and never published — the release image installs a
# published Mate and nothing else.
#
# syntax=docker/dockerfile:1

ARG BASE_IMAGE=mate-factory:local-base
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

# Workset containers run this working tree's Mate too: the archive's tools are
# replaced by the ones just installed, and the harness bridge is baked for them.
# The new version tag makes factory startup import the rebuilt image.
RUN workset="$(mktemp -d)" \
 && tar -C "${workset}" -xf "${MATE_WORKSET_ARCHIVE}" \
 && rm -rf "${workset}/opt/mate/tools" "${workset}/opt/mate/harness-bridge" \
 && cp -a /opt/mate/tools "${workset}/opt/mate/tools" \
 && mate-bake-harness-bridge "${workset}/opt/mate/tools" "${workset}/opt/mate/harness-bridge" \
 && tar --numeric-owner -C "${workset}" -cf "${MATE_WORKSET_ARCHIVE}" . \
 && rm -rf "${workset}" \
 && sed -i "s/^ENV MATE_VERSION=.*/ENV MATE_VERSION=${LOCAL_VERSION}/" /opt/mate/workset-image.conf

LABEL ai.mate.version="${LOCAL_VERSION}" \
      ai.mate.local-build="working tree; local only, do not publish"

ENV MATE_VERSION=${LOCAL_VERSION}

WORKDIR /home/mate
# As the published factory image: root starts the factory, whose supervisor runs Studio as mate.
USER root
