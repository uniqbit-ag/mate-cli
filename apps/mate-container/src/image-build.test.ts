import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findContainerRuntime, TEST_BASE_IMAGE } from "./container-runtime";
import { CONTAINER_ROOT, readImageInputs } from "./image-inputs";

/**
 * What the build refuses, and what it must never carry.
 *
 * These cases build tiny images rather than the whole appliance: the question
 * is whether the verification step does its job, not whether the appliance
 * assembles, which `verify-image.ts` answers against a real build.
 */

const RUNTIME = findContainerRuntime();
const withContainer = RUNTIME === null ? describe.skip : describe;
const inputs = readImageInputs();

let scratch: string;

function build(dockerfile: string, context: string): { status: number; output: string } {
  fs.writeFileSync(path.join(context, "Dockerfile"), dockerfile);
  const result = spawnSync(
    RUNTIME!,
    [
      "build",
      ...(RUNTIME === "podman" ? ["--format", "docker"] : []),
      "--file",
      path.join(context, "Dockerfile"),
      "--tag",
      `mate-build-case:${Math.random().toString(36).slice(2, 8)}`,
      context,
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

withContainer("a download whose digest does not match fails the build", () => {
  test("the verified fetch refuses a mismatched artifact and installs nothing", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mate-build-"));
    try {
      fs.copyFileSync(
        path.join(CONTAINER_ROOT, "scripts", "fetch-verified.sh"),
        path.join(scratch, "fetch-verified.sh"),
      );
      const wrongDigest = "0".repeat(64);
      const result = build(
        `FROM ${TEST_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
COPY fetch-verified.sh /usr/local/bin/fetch-verified
RUN chmod +x /usr/local/bin/fetch-verified
RUN fetch-verified "${inputs.opencode.installer_url}" "${wrongDigest}" /tmp/installer.sh
`,
        scratch,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("expected sha256");
      expect(result.output).toContain("received sha256");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);

  test("a digest that is not a sha256 at all is refused before anything is fetched", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mate-build-"));
    try {
      fs.copyFileSync(
        path.join(CONTAINER_ROOT, "scripts", "fetch-verified.sh"),
        path.join(scratch, "fetch-verified.sh"),
      );
      const result = build(
        `FROM ${TEST_BASE_IMAGE}
COPY fetch-verified.sh /usr/local/bin/fetch-verified
RUN chmod +x /usr/local/bin/fetch-verified
RUN fetch-verified "https://example.invalid/thing" "not-a-digest" /tmp/thing
`,
        scratch,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("is not a sha256");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("the recipe itself", () => {
  const dockerfile = fs.readFileSync(path.join(CONTAINER_ROOT, "Dockerfile"), "utf8");

  test("references its base images by digest, never by a bare tag", () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]!);
    for (const from of froms) {
      const isArg = from.startsWith("${");
      expect(isArg, `FROM ${from} is not a build argument`).toBe(true);
    }
    expect(dockerfile).toContain(`ARG NODE_IMAGE=node@${inputs.base_images.node!.digest}`);
    expect(dockerfile).toContain(`ARG BUN_IMAGE=oven/bun@${inputs.base_images.bun!.digest}`);
  });

  test("installs Mate from the published package rather than the working tree", () => {
    // `npm ci` against the checked-in lock, and no copy of the repository's
    // source into any stage.
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).not.toMatch(/COPY\s+(\.\.\/)?(packages|apps\/mate-cli|apps\/mate-core)/);
    expect(dockerfile).not.toContain("bun run build");
  });

  test("names the Mate version exactly rather than resolving a channel", () => {
    expect(dockerfile).toContain("ARG MATE_VERSION");
    // No default: a build that is not told which release to install fails.
    expect(dockerfile).not.toMatch(/ARG MATE_VERSION=/);
    expect(dockerfile).not.toContain("@latest");
    expect(dockerfile).not.toContain("@canary");
  });

  test("installs OS packages at pinned versions", () => {
    for (const [name, version] of Object.entries(inputs.os_packages.packages)) {
      if (name === "curl") continue;
      const argName = `${name.replace(/-/g, "_").toUpperCase()}_VERSION`;
      expect(dockerfile, `${name} is not pinned`).toContain(`${argName}}`);
      // The published image is the runtime stage; a pin installed only in a
      // build stage never reaches it.
      const runtimeStage = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
      expect(runtimeStage, `${name} is not installed in the runtime stage`).toContain(
        `"${name}=\${${argName}}"`,
      );
      expect(version.length).toBeGreaterThan(0);
    }
  });

  test("asserts every runtime and tool is present before the image is finished", () => {
    for (const command of [
      "bun",
      "node",
      "git",
      "ssh",
      "uv",
      "openspec",
      "graphify",
      "rtk",
      "tokensave",
      "opencode",
    ]) {
      expect(dockerfile).toContain(`command -v ${command}`);
    }
  });

  test("applies the pinned update policy to its own build-time Mate checks", () => {
    expect(dockerfile).toContain("ENV MATE_UPDATE_POLICY=pinned");
    expect(dockerfile).toContain("MATE_UPDATE_POLICY=pinned mate --version");
  });

  test("registers the installed Context7 server rather than npx", () => {
    expect(dockerfile).toMatch(/^\s+MATE_CONTEXT7_MODE=preinstalled \\$/m);
  });

  test("runs as the unprivileged identity the inputs name", () => {
    expect(dockerfile).toContain("USER mate");
    expect(dockerfile).toContain(`ARG MATE_UID=${inputs.runtime.uid}`);
    expect(dockerfile).toContain(`ARG MATE_GID=${inputs.runtime.gid}`);
    // The last USER in the file decides what a container runs as.
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]!);
    expect(users.at(-1)).toBe("mate");
  });

  test("bakes no credential, identity, or operator configuration", () => {
    // Nothing that would write a secret into a layer. Build arguments are
    // versions and digests; none of them is a token.
    const args = [...dockerfile.matchAll(/^ARG\s+([A-Z_]+)/gm)].map((match) => match[1]!);
    for (const arg of args) {
      // Matched on the trailing word, so `TOKENSAVE_VERSION` — a pinned tool
      // version — is not mistaken for a secret.
      expect(arg, `${arg} looks like a credential`).not.toMatch(
        /(^|_)(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|CREDENTIALS)$/,
      );
    }
    expect(dockerfile).not.toContain("NPM_TOKEN");
    expect(dockerfile).not.toContain(".npmrc");
    expect(dockerfile).not.toContain("git config --global user.");
    // And it asserts their absence rather than only avoiding them.
    expect(dockerfile).toContain("test ! -e /root/.mate");
    expect(dockerfile).toContain("test ! -e /home/mate/.mate");
  });
});
