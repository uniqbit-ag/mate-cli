#!/usr/bin/env bun
/**
 * Builds the factory image from the release-owned inputs: Studio plus Sysbox,
 * the inner engine and Worksets. The appliance image is built by
 * apps/mate-container.
 *
 * Every pin the Dockerfile needs is passed as a build argument read from
 * image-inputs.yaml, so the recipe never has to default to a moving reference
 * and a build that is not told which release to install fails rather than
 * inventing one.
 *
 *   bun scripts/build.ts --tag mate-factory:local
 *   bun scripts/build.ts --platform linux/amd64 --mate-version 0.17.0
 *   bun scripts/build.ts --tag mate-factory:local-base --label ai.mate.local-inputs=<digest>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { findContainerRuntime } from "../src/container-runtime";
import { CONTAINER_ROOT, readImageInputs } from "../src/image-inputs";

function option(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** The image this app publishes. */
export const DEFAULT_IMAGE = "mate-factory";

/** Every `--label key=value`, passed through to the build in the order given. */
export function labelArgs(argv: string[]): string[] {
  const labels: string[] = [];
  argv.forEach((arg, index) => {
    if (arg !== "--label") return;
    const label = argv[index + 1];
    if (label === undefined || !/^[^=]+=/.test(label)) {
      throw new Error(`build: --label needs key=value, got ${label ?? "nothing"}`);
    }
    labels.push("--label", label);
  });
  return labels;
}

/** Build arguments for Sysbox, the Docker engine and their OS packages. */
function factoryBuildArgs(factory: ReturnType<typeof readImageInputs>["factory"]) {
  const engine = factory.docker_engine.packages;
  const pkg = (name: string) => engine[name]!;
  return {
    SYSBOX_VERSION: factory.sysbox.version,
    SYSBOX_BASE_URL: factory.sysbox.base_url,
    SYSBOX_SHA256_AMD64: factory.sysbox.artifacts.amd64!.sha256,
    SYSBOX_SHA256_ARM64: factory.sysbox.artifacts.arm64!.sha256,

    DOCKER_ENGINE_BASE_URL: factory.docker_engine.base_url,
    CONTAINERD_VERSION: pkg("containerd.io").version,
    CONTAINERD_SHA256_AMD64: pkg("containerd.io").artifacts.amd64!.sha256,
    CONTAINERD_SHA256_ARM64: pkg("containerd.io").artifacts.arm64!.sha256,
    DOCKER_CLI_VERSION: pkg("docker-ce-cli").version,
    DOCKER_CLI_SHA256_AMD64: pkg("docker-ce-cli").artifacts.amd64!.sha256,
    DOCKER_CLI_SHA256_ARM64: pkg("docker-ce-cli").artifacts.arm64!.sha256,
    DOCKER_CE_VERSION: pkg("docker-ce").version,
    DOCKER_CE_SHA256_AMD64: pkg("docker-ce").artifacts.amd64!.sha256,
    DOCKER_CE_SHA256_ARM64: pkg("docker-ce").artifacts.arm64!.sha256,

    FUSE3_VERSION: factory.os_packages.fuse3!,
    RSYNC_VERSION: factory.os_packages.rsync!,
    IPROUTE2_VERSION: factory.os_packages.iproute2!,
    KMOD_VERSION: factory.os_packages.kmod!,
    IPTABLES_VERSION: factory.os_packages.iptables!,
    PROCPS_VERSION: factory.os_packages.procps!,

    WORKSET_ARCHIVE: factory.workset_image.archive,
  };
}

export function buildArgs(
  inputs: ReturnType<typeof readImageInputs>,
  mateVersion: string,
): string[] {
  const opencode = inputs.opencode;
  const tools = inputs.tools;
  const pairs: Record<string, string> = {
    NODE_IMAGE: `node@${inputs.base_images.node!.digest}`,
    BUN_IMAGE: `oven/bun@${inputs.base_images.bun!.digest}`,
    MATE_VERSION: mateVersion,

    OPENCODE_VERSION: opencode.version,
    OPENCODE_RELEASE_BASE_URL: opencode.release_base_url,
    OPENCODE_SHA256_AMD64: opencode.artifacts.amd64!.sha256,
    OPENCODE_SHA256_ARM64: opencode.artifacts.arm64!.sha256,

    CLAUDE_VERSION: inputs.claude.version,
    CLAUDE_RELEASE_BASE_URL: inputs.claude.release_base_url,
    CLAUDE_SHA256_AMD64: inputs.claude.artifacts.amd64!.sha256,
    CLAUDE_SHA256_ARM64: inputs.claude.artifacts.arm64!.sha256,

    UV_VERSION: tools.uv!.version,
    UV_SHA256_AMD64: tools.uv!.artifacts!.amd64!.sha256,
    UV_SHA256_ARM64: tools.uv!.artifacts!.arm64!.sha256,

    RTK_VERSION: tools.rtk!.version,
    RTK_SHA256_AMD64: tools.rtk!.artifacts!.amd64!.sha256,
    RTK_SHA256_ARM64: tools.rtk!.artifacts!.arm64!.sha256,

    TOKENSAVE_VERSION: tools.tokensave!.version,
    TOKENSAVE_SHA256_AMD64: tools.tokensave!.artifacts!.amd64!.sha256,
    TOKENSAVE_SHA256_ARM64: tools.tokensave!.artifacts!.arm64!.sha256,

    GRAPHIFY_VERSION: tools.graphify!.version,
    GRAPHIFY_PYTHON_VERSION: String((tools.graphify as { python_version?: string }).python_version),

    GIT_VERSION: inputs.os_packages.packages.git!,
    CA_CERTIFICATES_VERSION: inputs.os_packages.packages["ca-certificates"]!,
    TAR_VERSION: inputs.os_packages.packages.tar!,
    GZIP_VERSION: inputs.os_packages.packages.gzip!,
    XZ_UTILS_VERSION: inputs.os_packages.packages["xz-utils"]!,
    OPENSSH_CLIENT_VERSION: inputs.os_packages.packages["openssh-client"]!,

    ...factoryBuildArgs(inputs.factory),

    MATE_UID: String(inputs.runtime.uid),
    MATE_GID: String(inputs.runtime.gid),
  };
  return Object.entries(pairs).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
}

function main(argv: string[]): number {
  const runtime = findContainerRuntime();
  if (runtime === null) {
    process.stderr.write("build: no container runtime found; install podman or docker.\n");
    return 1;
  }

  const inputs = readImageInputs();
  // Defaults to the pinned version: the global-tools lock installs exactly it,
  // and the Dockerfile rejects any other `MATE_VERSION`.
  const mateVersion = option(argv, "mate-version") ?? inputs.mate.version;
  const tag = option(argv, "tag") ?? `${DEFAULT_IMAGE}:${mateVersion}`;
  const platform = option(argv, "platform");

  const args = [
    "build",
    // Podman defaults to the OCI image format, which drops `SHELL` — every RUN
    // would silently fall back to `/bin/sh` without `pipefail`. Docker's format
    // honours it; buildkit does so natively and ignores the flag's absence.
    ...(runtime === "podman" ? ["--format", "docker"] : []),
    ...(platform ? ["--platform", platform] : []),
    ...buildArgs(inputs, mateVersion),
    ...labelArgs(argv),
    "--file",
    path.join(CONTAINER_ROOT, "Dockerfile"),
    "--tag",
    tag,
    CONTAINER_ROOT,
  ];

  process.stderr.write(`build: ${runtime} ${args.slice(0, 2).join(" ")} … --tag ${tag}\n`);
  const result = spawnSync(runtime, args, { stdio: "inherit" });
  return result.status ?? 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
