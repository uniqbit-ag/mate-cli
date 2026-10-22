import { fakePluginInstallDeps } from "../../../../test/plugin-install";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { runPluginCommand } from "./plugin";

const tempRoots: string[] = [];
let originalArtifactPath: string | undefined;
let originalExitCode: number | undefined;
let originalStderrWrite: typeof process.stderr.write;
let originalLog: typeof console.log;

async function makeCompanion(): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-cmd-"));
  tempRoots.push(rootPath);
  const configDir = path.join(rootPath, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "framework.yaml"), "allowedAgents: []\n", "utf8");
  return rootPath;
}

beforeEach(() => {
  originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  originalStderrWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  originalLog = console.log;
  console.log = () => {};
});

afterEach(async () => {
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  process.exitCode = originalExitCode;
  process.stderr.write = originalStderrWrite;
  console.log = originalLog;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runPluginCommand install", () => {
  test("a failed install exits non-zero and keeps the declaration", async () => {
    const companionPath = await makeCompanion();
    process.env.MATE_ARTIFACT_PATH = companionPath;

    await runPluginCommand("install", ["@acme/private-tool"], {
      installDeps: fakePluginInstallDeps({
        runNpmInstall: async () => ({ ok: false, detail: "E401" }),
      }),
    });

    expect(process.exitCode).toBe(1);
    const config = parse(
      await fs.readFile(path.join(companionPath, ".mate", "config", "framework.yaml"), "utf8"),
    ) as { plugins?: unknown[] };
    expect(config.plugins).toEqual([{ package: "@acme/private-tool", version: "latest" }]);
  });

  test("a successful install exits zero", async () => {
    const companionPath = await makeCompanion();
    process.env.MATE_ARTIFACT_PATH = companionPath;

    await runPluginCommand("install", ["@acme/custom-plugin@1.2.0"], {
      installDeps: fakePluginInstallDeps({
        runNpmInstall: async (workspaceRoot: string) => {
          const root = path.join(workspaceRoot, "node_modules", "@acme", "custom-plugin");
          await fs.mkdir(root, { recursive: true });
          await fs.writeFile(
            path.join(root, "package.json"),
            JSON.stringify({ name: "@acme/custom-plugin", version: "1.2.0" }),
            "utf8",
          );
          return { ok: true };
        },
      }),
    });

    expect(process.exitCode).toBe(0);
  });
});
