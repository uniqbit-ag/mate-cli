# The Mate appliance image.
#
# Everything the appliance needs is installed here, at exact versions checked
# against apps/mate-container/image-inputs.yaml. Startup does filesystem work
# only: it copies a prebuilt workspace and starts two processes. No package
# manager, dependency resolver, download, native build, or installation script
# runs in a started container.
#
# Build arguments carry the pins rather than defaulting to a moving reference,
# so a build that is not told which release to install fails instead of
# inventing one. The publication workflow passes them from image-inputs.yaml.
#
# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Pins. Kept in sync with image-inputs.yaml, which is the release-owned source
# and which the workflow reads to pass these in.
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG BUN_IMAGE=oven/bun@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

# ===========================================================================
# Stage: bun — the runtime the published `mate` command bootstraps into.
#
# Copied from the official image rather than installed by the bootstrap. The
# container's own command line carries `--yes`, which the bootstrap reads as
# consent to install Bun, so a missing Bun here would not fail loudly — it
# would quietly run a network installer at container start. The final stage
# asserts Bun is present instead of relying on the prompt being unanswerable.
# ===========================================================================
FROM ${BUN_IMAGE} AS bun

# ===========================================================================
# Stage: fetch — every standalone download, checked against its digest.
#
# Nothing here is installed into the final image without its sha256 matching
# the release-owned input. A mismatch fails the build.
# ===========================================================================
FROM ${NODE_IMAGE} AS fetch

ARG TARGETARCH

ARG OPENCODE_VERSION
ARG OPENCODE_INSTALLER_SHA256
ARG OPENCODE_SHA256_AMD64
ARG OPENCODE_SHA256_ARM64
ARG UV_VERSION
ARG UV_SHA256_AMD64
ARG UV_SHA256_ARM64
ARG RTK_VERSION
ARG RTK_SHA256_AMD64
ARG RTK_SHA256_ARM64
ARG TOKENSAVE_VERSION
ARG TOKENSAVE_SHA256_AMD64
ARG TOKENSAVE_SHA256_ARM64

ARG GIT_VERSION
ARG CA_CERTIFICATES_VERSION
ARG TAR_VERSION
ARG GZIP_VERSION
ARG XZ_UTILS_VERSION

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Certificate authorities first: every download below verifies TLS against this
# trust store, and the exact versions come from the release-owned inputs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
      "curl=$(apt-cache policy curl | sed -n 's/^  Candidate: //p')" \
      "tar=${TAR_VERSION}" \
      "gzip=${GZIP_VERSION}" \
      "xz-utils=${XZ_UTILS_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /fetch

# One helper for every checked download: fetch, verify, refuse otherwise.
COPY scripts/fetch-verified.sh /usr/local/bin/fetch-verified
RUN chmod +x /usr/local/bin/fetch-verified

# --- uv -------------------------------------------------------------------
RUN case "${TARGETARCH}" in \
      amd64) UV_FILE=uv-x86_64-unknown-linux-gnu.tar.gz; UV_SHA="${UV_SHA256_AMD64}" ;; \
      arm64) UV_FILE=uv-aarch64-unknown-linux-gnu.tar.gz; UV_SHA="${UV_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && fetch-verified "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_FILE}" "${UV_SHA}" /fetch/uv.tar.gz \
 && mkdir -p /out/bin && tar -xzf /fetch/uv.tar.gz -C /fetch \
 && find /fetch -type f -name uv -perm -u+x -exec cp {} /out/bin/uv \; \
 && find /fetch -type f -name uvx -perm -u+x -exec cp {} /out/bin/uvx \; \
 && /out/bin/uv --version

# --- rtk ------------------------------------------------------------------
# The project publishes a static musl build for x86_64 and a gnu build for
# aarch64; the musl binary runs on the glibc base image.
RUN case "${TARGETARCH}" in \
      amd64) RTK_FILE=rtk-x86_64-unknown-linux-musl.tar.gz; RTK_SHA="${RTK_SHA256_AMD64}" ;; \
      arm64) RTK_FILE=rtk-aarch64-unknown-linux-gnu.tar.gz; RTK_SHA="${RTK_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && fetch-verified "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${RTK_FILE}" "${RTK_SHA}" /fetch/rtk.tar.gz \
 && mkdir -p /fetch/rtk && tar -xzf /fetch/rtk.tar.gz -C /fetch/rtk \
 && find /fetch/rtk -type f -name rtk -perm -u+x -exec cp {} /out/bin/rtk \; \
 && /out/bin/rtk --version

# --- tokensave ------------------------------------------------------------
# Prebuilt release binaries, so the image needs no Rust toolchain.
RUN case "${TARGETARCH}" in \
      amd64) TS_FILE="tokensave-v${TOKENSAVE_VERSION}-x86_64-linux.tar.gz"; TS_SHA="${TOKENSAVE_SHA256_AMD64}" ;; \
      arm64) TS_FILE="tokensave-v${TOKENSAVE_VERSION}-aarch64-linux.tar.gz"; TS_SHA="${TOKENSAVE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && fetch-verified "https://github.com/aovestdipaperino/tokensave/releases/download/v${TOKENSAVE_VERSION}/${TS_FILE}" "${TS_SHA}" /fetch/tokensave.tar.gz \
 && mkdir -p /fetch/tokensave && tar -xzf /fetch/tokensave.tar.gz -C /fetch/tokensave \
 && find /fetch/tokensave -type f -name tokensave -perm -u+x -exec cp {} /out/bin/tokensave \; \
 && /out/bin/tokensave --version

# --- OpenCode -------------------------------------------------------------
# The installer is checked before it is run, and run with `--version`, which
# installs that exact version rather than the current one. The artifact it
# downloads is checked too, which also pins away the installer's own
# CPU-feature "baseline" variant selection: a baseline artifact fails the
# digest check rather than producing a different image per build host.
RUN case "${TARGETARCH}" in \
      amd64) OC_FILE=opencode-linux-x64.tar.gz; OC_SHA="${OPENCODE_SHA256_AMD64}" ;; \
      arm64) OC_FILE=opencode-linux-arm64.tar.gz; OC_SHA="${OPENCODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && fetch-verified "https://opencode.ai/install" "${OPENCODE_INSTALLER_SHA256}" /fetch/opencode-install.sh \
 && fetch-verified "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${OC_FILE}" "${OC_SHA}" /fetch/opencode.tar.gz \
 && HOME=/fetch/ochome bash /fetch/opencode-install.sh --version "${OPENCODE_VERSION}" \
 && cp "/fetch/ochome/.opencode/bin/opencode" /out/bin/opencode \
 && test "$(/out/bin/opencode --version)" = "${OPENCODE_VERSION}"

# ===========================================================================
# Stage: packages — the npm graphs, installed from checked-in lockfiles.
#
# `npm ci` installs exactly what the lock resolves; nothing here re-resolves a
# version, so a rebuild of the same release gets the same graph.
# ===========================================================================
FROM ${NODE_IMAGE} AS packages

ARG MATE_VERSION
ARG CA_CERTIFICATES_VERSION

# An update check during the build would write update state into a layer and
# could refuse a build-time `mate` invocation outright. The appliance is
# version-pinned by construction, so the policy applies here too.
ENV MATE_UPDATE_POLICY=pinned

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends "ca-certificates=${CA_CERTIFICATES_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# --- global tools: the Mate CLI and the OpenSpec CLI ----------------------
WORKDIR /opt/mate/tools
COPY locks/global-tools.package.json ./package.json
COPY locks/global-tools.package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund \
 && test "$(node -p 'require("/opt/mate/tools/node_modules/@uniqbit/mate/package.json").version')" = "${MATE_VERSION}"

# --- the prebuilt companion-local workspace -------------------------------
# Built here, outside any companions mount, so a freshly cloned companion can
# be given a complete workspace by copying rather than installing. Its declared
# dependency versions are the distribution-owned pins exactly; preparation
# refuses anything else.
WORKDIR /opt/mate/prebuilt
COPY locks/local-workspace.package.json ./package.json
COPY locks/local-workspace.package-lock.json ./package-lock.json
# npm 11 runs no install script the manifest has not approved, so the
# `allowScripts` entries in locks/local-workspace.package.json are what make
# this a *fully installed* workspace rather than an unpacked one — native
# builds, generated assets and postinstalls included.
#
# What is asserted below is the outcome, not npm's own advisory listing: that
# listing keeps reporting a package as unreviewed even when the release has
# approved exactly the key npm wrote for it, and a build must not turn on a
# tool's opinion of its own bookkeeping. A native module that loads and a
# generated asset that exists are the facts a session depends on.
RUN npm ci --omit=dev --no-audit --no-fund \
 && test -f node_modules/context-mode/build/adapters/opencode/plugin.js \
 && test -f node_modules/context-mode/.claude-plugin/plugin.json \
 && test -f node_modules/context-mode/hooks/hooks.json \
 && test -f node_modules/context-mode/skills/context-mode/SKILL.md \
 && test "$(node -p 'require("/opt/mate/prebuilt/node_modules/@uniqbit/mate-opencode-plugin/package.json").version')" = "${MATE_VERSION}" \
 && node -e "require('/opt/mate/prebuilt/node_modules/better-sqlite3')" \
 && node -e "require('/opt/mate/prebuilt/node_modules/context-mode/node_modules/better-sqlite3')"

# ===========================================================================
# Stage: runtime — the published image.
# ===========================================================================
FROM ${NODE_IMAGE} AS runtime

ARG TARGETARCH
ARG MATE_VERSION
ARG OPENCODE_VERSION
ARG GRAPHIFY_VERSION
ARG GRAPHIFY_PYTHON_VERSION
ARG GIT_VERSION
ARG CA_CERTIFICATES_VERSION
ARG TAR_VERSION
ARG GZIP_VERSION
ARG XZ_UTILS_VERSION
ARG OPENSSH_CLIENT_VERSION
ARG MATE_UID=10001
ARG MATE_GID=10001

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# --- OS packages, at the exact versions the pinned base image resolves -----
# Git is what the entrypoint clones and what the companion synchronizes with;
# the certificate authorities and the SSH client are what either needs to reach
# an HTTPS or an SSH remote.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      "git=${GIT_VERSION}" \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
      "tar=${TAR_VERSION}" \
      "gzip=${GZIP_VERSION}" \
      "xz-utils=${XZ_UTILS_VERSION}" \
      "openssh-client=${OPENSSH_CLIENT_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# --- runtimes and tools ---------------------------------------------------
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

COPY --from=fetch /out/bin/ /usr/local/bin/
COPY --from=packages /opt/mate/tools /opt/mate/tools
COPY --from=packages /opt/mate/prebuilt /opt/mate/prebuilt

# The CLI entrypoints the appliance calls, and the OpenSpec and Context7
# capability tools.
RUN ln -sf /opt/mate/tools/node_modules/.bin/mate /usr/local/bin/mate \
 && ln -sf /opt/mate/tools/node_modules/.bin/openspec /usr/local/bin/openspec \
 && ln -sf /opt/mate/tools/node_modules/.bin/context7-mcp /usr/local/bin/context7-mcp

# --- what the prebuilt workspace actually is -------------------------------
# Recorded beside the bundle so its installed versions, its target, and a
# content digest can be read without unpacking the image or starting a
# container. Preparation validates the bundle against the distribution's own
# pins regardless; this makes it legible rather than trustworthy.
COPY scripts/write-bundle-manifest.ts /opt/mate/tools/startup/write-bundle-manifest.ts
RUN bun /opt/mate/tools/startup/write-bundle-manifest.ts /opt/mate/prebuilt "${MATE_VERSION}" \
 && test -f /opt/mate/prebuilt-manifest.json

# --- graphify, from a hash-locked requirements file ------------------------
# `uv tool install graphifyy` would resolve transitive dependencies afresh on
# every rebuild; installing from the compiled, hashed requirements does not.
ENV UV_TOOL_DIR=/opt/mate/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/mate/uv/python \
    UV_NO_MODIFY_PATH=1
COPY locks/graphify.requirements.txt /opt/mate/locks/graphify.requirements.txt
RUN uv python install "${GRAPHIFY_PYTHON_VERSION}" \
 && uv tool install --no-cache \
      --python "${GRAPHIFY_PYTHON_VERSION}" \
      --with-requirements /opt/mate/locks/graphify.requirements.txt \
      "graphifyy==${GRAPHIFY_VERSION}" \
 && graphify --version

# --- the unprivileged identity the container runs as -----------------------
# Documented in the deployment page and in image-inputs.yaml, because the
# operator has to grant this identity write access to the companions volume.
#
# The agent runtimes' own home directories are created here too. Capability
# initialisation writes into them and does not create them: `rtk init -g
# --auto-patch` fails outright on a missing ~/.claude, and a failed
# initialisation makes the launch's installation-state repair fail — which
# refuses the session with advice to run `mate install` that no appliance can
# act on. Creating them is the image's job, because the image is what decided
# this user exists.
RUN groupadd --gid "${MATE_GID}" mate \
 && useradd --uid "${MATE_UID}" --gid "${MATE_GID}" --create-home --home-dir /home/mate --shell /bin/bash mate \
 && mkdir -p /companions \
 && mkdir -p /home/mate/.claude /home/mate/.config/opencode \
 && chown -R "${MATE_UID}:${MATE_GID}" /companions /home/mate \
 && chmod 0755 /companions

# --- the entrypoint --------------------------------------------------------
# The startup program lives under /opt/mate/tools so that `yaml`, which the
# Mate CLI's own locked graph already installs there, resolves from an ancestor
# `node_modules` rather than needing a second copy.
COPY scripts/entrypoint.sh /usr/local/bin/mate-appliance
COPY scripts/xdg-open.sh /usr/local/bin/xdg-open
COPY src/config.ts src/discovery.ts src/startup.ts /opt/mate/tools/startup/
RUN chmod +x /usr/local/bin/mate-appliance /usr/local/bin/xdg-open \
 && test -d /opt/mate/tools/node_modules/yaml

# --- build-time assertions -------------------------------------------------
# Everything the appliance needs is present now, and the runtime bootstrap has
# nothing left to do. Asserted by presence, not by an installer declining.
RUN set -e \
 && command -v bun \
 && command -v node \
 && command -v git \
 && command -v ssh \
 && command -v uv \
 && command -v openspec \
 && command -v graphify \
 && command -v rtk \
 && command -v tokensave \
 && command -v context7-mcp \
 && command -v opencode \
 && command -v xdg-open \
 && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
 && MATE_UPDATE_POLICY=pinned mate --version | tail -1 | grep -qx "${MATE_VERSION}" \
 && test ! -e /root/.mate \
 && test ! -e /home/mate/.mate

# The version the image contains, readable without starting anything.
LABEL org.opencontainers.image.title="Mate appliance" \
      org.opencontainers.image.description="A single-tenant Mate appliance: an OpenCode session over the web with Studio beside it." \
      org.opencontainers.image.source="https://github.com/uniqbit-ag/mate-cli" \
      org.opencontainers.image.licenses="MIT" \
      ai.mate.version="${MATE_VERSION}" \
      ai.mate.opencode.version="${OPENCODE_VERSION}"

ENV MATE_VERSION=${MATE_VERSION} \
    MATE_OPENCODE_VERSION=${OPENCODE_VERSION} \
    MATE_PREBUILT_WORKSPACE=/opt/mate/prebuilt \
    MATE_COMPANIONS_DIR=/companions \
    MATE_UPDATE_POLICY=pinned \
    MATE_CONTEXT7_MODE=preinstalled \
    HOME=/home/mate

USER mate
WORKDIR /home/mate

# Both ports are unauthenticated; what fronts them is the operator's.
EXPOSE 4096 4097

ENTRYPOINT ["/usr/local/bin/mate-appliance"]
