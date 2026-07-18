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
});
