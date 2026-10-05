#!/usr/bin/env bun
/**
 * Builds the appliance image from the release-owned inputs.
 *
 * Every pin the Dockerfile needs is passed as a build argument read from
 * image-inputs.yaml, so the recipe never has to default to a moving reference
 * and a build that is not told which release to install fails rather than
 * inventing one.
 *
 *   bun scripts/build.ts --tag mate-appliance:local
 *   bun scripts/build.ts --platform linux/amd64 --mate-version 0.17.0
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { findContainerRuntime } from "../src/container-runtime";
import { CONTAINER_ROOT, readImageInputs } from "../src/image-inputs";

function option(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
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
    OPENCODE_INSTALLER_SHA256: opencode.installer_sha256,
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
  // A local build defaults to the minimum compatible version; the publication
  // workflow passes the release's own version instead.
  const mateVersion = option(argv, "mate-version") ?? inputs.mate.minimum_compatible;
  const tag = option(argv, "tag") ?? `mate-appliance:${mateVersion}`;
  const platform = option(argv, "platform");

  const args = [
    "build",
    // Podman defaults to the OCI image format, which drops `SHELL` — every RUN
    // would silently fall back to `/bin/sh` without `pipefail`. Docker's format
    // honours it; buildkit does so natively and ignores the flag's absence.
    ...(runtime === "podman" ? ["--format", "docker"] : []),
    ...(platform ? ["--platform", platform] : []),
    ...buildArgs(inputs, mateVersion),
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
