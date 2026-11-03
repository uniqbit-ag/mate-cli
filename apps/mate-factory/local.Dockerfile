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
# The base image's input digest: names the imported base Workset image, so a
# rebuilt base is imported afresh and an unchanged one is reused.
ARG BASE_ID

USER root
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# The packed CLI names its core dependency by this path, so npm resolves it
# from the tarball beside it rather than the registry.
COPY ${CORE_TARBALL} ${CLI_TARBALL} /opt/mate/local/

# Mate's own packages are swapped in place when they declare the dependencies
# already installed; anything else reinstalls the tool graph from the tarballs.
WORKDIR /opt/mate/tools
RUN test -n "${LOCAL_VERSION}" && test -n "${BASE_ID}" \
 && unpacked="$(mktemp -d)" \
 && mkdir "${unpacked}/mate-core" "${unpacked}/mate" \
 && tar -xzf "/opt/mate/local/${CORE_TARBALL}" -C "${unpacked}/mate-core" --strip-components=1 \
 && tar -xzf "/opt/mate/local/${CLI_TARBALL}" -C "${unpacked}/mate" --strip-components=1 \
 && if node -e ' \
      const [dir] = process.argv.slice(1); \
      const deps = (file) => { \
        const p = require(file); \
        const all = { ...p.dependencies, ...p.optionalDependencies, ...p.peerDependencies }; \
        return JSON.stringify(Object.entries(all).filter(([n]) => !n.startsWith("@uniqbit/")).sort()); \
      }; \
      for (const name of ["mate-core", "mate"]) { \
        const installed = `/opt/mate/tools/node_modules/@uniqbit/${name}/package.json`; \
        if (deps(installed) !== deps(`${dir}/${name}/package.json`)) process.exit(1); \
      }' "${unpacked}"; then \
      echo "local build: dependencies unchanged; replacing Mate's own packages only" \
      && for name in mate-core mate; do \
           target="node_modules/@uniqbit/${name}"; \
           find "${target}" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +; \
           cp -a "${unpacked}/${name}/." "${target}/"; \
           node -e ' \
             const [dir] = process.argv.slice(1); const p = require(`${dir}/package.json`); \
             const bins = typeof p.bin === "string" ? [p.bin] : Object.values(p.bin ?? {}); \
             for (const b of bins) require("fs").chmodSync(`${dir}/${b}`, 0o755);' "$PWD/${target}"; \
         done; \
    else \
      echo "local build: dependencies changed; reinstalling the tool graph" \
      && npm install --omit=dev --no-audit --no-fund --cache "${unpacked}/npm-cache" \
           "/opt/mate/local/${CORE_TARBALL}" "/opt/mate/local/${CLI_TARBALL}"; \
    fi \
 && rm -rf "${unpacked}" \
 && test -f /opt/mate/tools/node_modules/@uniqbit/mate-core/opencode-plugin/server.ts \
 && scratch="$(mktemp -d)" \
 && test "$(HOME="${scratch}" MATE_UPDATE_POLICY=pinned mate --version | tail -1)" = "${LOCAL_VERSION}" \
 && rm -rf "${scratch}" \
 && { test ! -e /root/.mate || { echo "unexpected /root/.mate" >&2; exit 1; }; }

# Workset containers run this working tree's Mate too, as one overlay layer on
# the unchanged base Workset image: its tools and a freshly baked harness
# bridge. Factory startup imports the base archive once and commits this on
# top; the new version tag makes it build the local Workset image.
RUN overlay="$(mktemp -d)" \
 && mkdir -p "${overlay}/opt/mate" \
 && cp -a /opt/mate/tools "${overlay}/opt/mate/tools" \
 && mate-bake-harness-bridge "${overlay}/opt/mate/tools" "${overlay}/opt/mate/harness-bridge" \
 && tar --numeric-owner -C "${overlay}" -cf - opt | zstd -T0 -3 -q -o /opt/mate/workset-overlay.tar.zst \
 && rm -rf "${overlay}" \
 && sed -i "s/^ENV MATE_VERSION=.*/ENV MATE_VERSION=${LOCAL_VERSION}/" /opt/mate/workset-image.conf

# Factory startup refreshes the served companion clone's Mate skills from these, so a
# local run uses this working tree's skills; the release image never sets it.
ENV MATE_FACTORY_LOCAL_SKILLS=/opt/mate/tools/node_modules/@uniqbit/mate-core/src/templates/mate-skills
RUN test -f "${MATE_FACTORY_LOCAL_SKILLS}/claude/mate-propose-change/SKILL.md"

LABEL ai.mate.version="${LOCAL_VERSION}" \
      ai.mate.local-build="working tree; local only, do not publish"

ENV MATE_VERSION=${LOCAL_VERSION} \
    MATE_WORKSET_OVERLAY=/opt/mate/workset-overlay.tar.zst \
    MATE_WORKSET_BASE_IMAGE=mate-workset-base:${BASE_ID}

WORKDIR /home/mate
# As the published factory image: root starts the factory, whose supervisor runs Studio as mate.
USER root
