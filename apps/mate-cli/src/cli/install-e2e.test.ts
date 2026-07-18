import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];
const cliPath = path.join(import.meta.dirname, "..", "cli.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scenario(): Promise<{ root: string; companion: string; working: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-e2e-"));
  roots.push(root);
  const companion = path.join(root, "companion");
  const working = path.join(root, "working");
  await fs.mkdir(companion, { recursive: true });
  await fs.mkdir(working, { recursive: true });
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  await fs
    .writeFile(
      path.join(root, "home", ".mate", "update-state.yaml"),
      "lastChecked: 2099-01-01T00:00:00.000Z\nlatestVersion: null\n",
    )
    .catch(async () => {
      await fs.mkdir(path.join(root, "home", ".mate"), { recursive: true });
      await fs.writeFile(
        path.join(root, "home", ".mate", "update-state.yaml"),
        "lastChecked: 2099-01-01T00:00:00.000Z\nlatestVersion: null\n",
      );
    });
  return { root, companion, working };
}

async function writeCompanionConfig(companion: string, capabilities: string[] = []): Promise<void> {
  const configDir = path.join(companion, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  const capabilityLines = capabilities.map((name) => `  - name: ${name}`).join("\n");
  await fs.writeFile(
    path.join(configDir, "framework.yaml"),
    [
      "type: companion",
      "profiles:",
      "  default:",
      "    name: default",
      "    allowedAgents: [claude]",
      "packageManagers: [bun]",
      "capabilities:",
      capabilityLines || "  []",
      "",
    ].join("\n"),
  );
}

async function runMate(root: string, cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        MATE_ARTIFACT_PATH: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

describe("install lifecycle CLI", () => {
  test("blocks first normal use, installs core state, and blocks stale state", async () => {
    const entry = await scenario();
    const before = await runMate(entry.root, entry.root, ["report"]);
    expect(before.status).toBe(1);
    expect(before.stderr).toContain("Run `mate install`");

    const installed = await runMate(entry.root, entry.root, ["install", "--yes"]);
    expect(installed.status).toBe(0);
    expect(installed.stdout).toContain("Mate installation complete.");

    const statePath = path.join(entry.root, "home", ".mate", "install-state", "core.yaml");
    const state = await fs.readFile(statePath, "utf8");
    await fs.writeFile(statePath, state.replace("contractRevision: 1", "contractRevision: 0"));
    const stale = await runMate(entry.root, entry.root, ["report"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("install contract has changed");
  });

  test("installs a current companion without enabling unselected capabilities", async () => {
    const entry = await scenario();
    await writeCompanionConfig(entry.companion, ["react-doctor"]);
    const result = await runMate(entry.root, entry.companion, ["install", "--yes"]);
    expect(result.status).toBe(0);
    expect(
      await fs.stat(path.join(entry.companion, ".claude", "skills", "react-doctor")),
    ).toBeDefined();
    expect(
      await fs.stat(path.join(entry.companion, ".mate", "config", "framework.yaml")),
    ).toBeDefined();
    await expect(
      fs.stat(path.join(entry.companion, ".claude", "skills", "graphify")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("blocks a linked companion without companion install state", async () => {
    const entry = await scenario();
    await writeCompanionConfig(entry.companion, ["openspec"]);
    await fs.mkdir(path.join(entry.working, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(entry.working, ".mate", "config", "registry.yaml"),
      `repository:\n  id: working\n  path: ${entry.working}\n  profile: default\ncompanions:\n  - path: ${entry.companion}\n    repositoryId: working\n    source: existing\n`,
    );
    const result = await runMate(entry.root, entry.working, ["report"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run `mate install`");
  });
});
