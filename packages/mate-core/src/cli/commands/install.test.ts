import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runInstallCommand } from "./install";

describe("runInstallCommand", () => {
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
  const originalExitCode = process.exitCode;
  let home: string;
  let stderr: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-command-"));
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-bin");
    process.env.MATE_ARTIFACT_PATH = "";
    process.exitCode = 0;
    stderr = [];
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
    else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  });

  test("refuses a non-TTY install without --yes before running installers", async () => {
    await runInstallCommand([]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join(" ")).toContain("mate install --yes");
    await expect(fs.access(path.join(home, ".mate", "install-state.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  async function companionWithPlugin(): Promise<string> {
    const companion = path.join(home, "companion");
    await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(companion, ".mate", "config", "framework.yaml"),
      JSON.stringify({ plugins: [{ package: "@acme/reader", version: "^1.0.0" }] }),
    );
    process.env.MATE_ARTIFACT_PATH = companion;
    return companion;
  }

  test("a declared plugin that fails to install fails the command before state is recorded", async () => {
    await companionWithPlugin();
    expect(await runInstallCommand(["--yes"])).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderr.join(" ")).toContain('plugin "@acme/reader" failed to install');
    await expect(fs.access(path.join(home, ".mate", "install-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("frozen mode refuses an absent lockfile and an unlisted plugin before npm runs", async () => {
    await companionWithPlugin();
    expect(await runInstallCommand(["--yes", "--frozen-plugins"])).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderr.join(" ")).toContain("frozen plugin install refused");

    stderr.length = 0;
    process.env.MATE_ALLOWED_PLUGINS = "@other/*";
    try {
      expect(await runInstallCommand(["--yes", "--frozen-plugins"])).toBe(false);
    } finally {
      delete process.env.MATE_ALLOWED_PLUGINS;
    }
    expect(stderr.join(" ")).toContain('plugin "@acme/reader" is not allowed');
  });
});
