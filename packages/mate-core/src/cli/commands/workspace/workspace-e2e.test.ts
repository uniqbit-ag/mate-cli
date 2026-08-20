import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Self-contained real-binary e2e coverage for `mate workspace list` and
// `mate workspace materialize`, run from an arbitrary directory that is not
// any linked working repository — proving both commands are
// context-independent and that stdout stays exactly one JSON document.
// Deliberately duplicates the small subset of scenario/runMate plumbing that
// cli-e2e-real-agents.test.ts uses, for the same decoupling reason its
// sibling suites give.

const APP_ROOT = path.resolve(import.meta.dirname, "../../../../../../apps/mate-cli");
const WATCHDOG_MS = 30_000;
setDefaultTimeout(WATCHDOG_MS + 10_000);

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function seedUpdateState(home: string): Promise<void> {
  const updateDir = path.join(home, ".mate");
  await fs.mkdir(updateDir, { recursive: true });
  await fs.writeFile(
    path.join(updateDir, "update-state-uniqbit-mate.yaml"),
    ["lastChecked: 2099-01-01T00:00:00.000Z", "latestVersion: null", ""].join("\n"),
    "utf8",
  );
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runMate(cwd: string, home: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [path.join(APP_ROOT, "src/cli.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        TERM_PROGRAM: "",
        VSCODE_IPC_HOOK: "",
        __CFBundleIdentifier: "",
        CI: "",
        MATE_ARTIFACT_PATH: "",
        MATE_REPO_ID: "",
        MATE_REPO_PATH: "",
        MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`runMate timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, WATCHDOG_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("mate workspace (real CLI, e2e)", () => {
  test("list reports a healthy pairing and a missing companion, isolated, from an unlinked cwd", async () => {
    const root = await makeTempDir("workspace-e2e-list-");
    const home = path.join(root, "home");
    const companionPath = path.join(home, ".mate", "companions", "app");
    const repoPath = path.join(root, "repo");
    const missingCompanionPath = path.join(home, ".mate", "companions", "gone");
    const unlinkedCwd = path.join(root, "unrelated");

    await Promise.all([
      fs.mkdir(companionPath, { recursive: true }),
      fs.mkdir(repoPath, { recursive: true }),
      fs.mkdir(unlinkedCwd, { recursive: true }),
    ]);
    await seedUpdateState(home);
    await fs.writeFile(
      path.join(home, ".mate", "config.yaml"),
      `version: 1\ncompanions:\n  - path: ${companionPath}\n  - path: ${missingCompanionPath}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, ".mate", "config", "registry.yaml"),
      `repos:\n  - id: app\n    path: ${repoPath}\n`,
      "utf8",
    );

    const result = await runMate(unlinkedCwd, home, ["workspace", "list", "--json"]);

    expect(result.code).toBe(0);
    const inventory = JSON.parse(result.stdout.trim());
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.companions).toEqual(
      expect.arrayContaining([
        { path: companionPath, health: "ready" },
        { path: missingCompanionPath, health: "missing" },
      ]),
    );
    expect(inventory.pairings).toEqual([
      {
        companionPath,
        repository: { id: "app", path: repoPath },
        health: "ready",
        ambiguous: false,
      },
    ]);
  });

  test("resolve returns one versioned envelope and does not create runtime state", async () => {
    const root = await makeTempDir("workspace-e2e-resolve-");
    const home = path.join(root, "home");
    const companionPath = path.join(home, ".mate", "companions", "app");
    const repoPath = path.join(root, "repo");
    const unlinkedCwd = path.join(root, "unrelated");

    await Promise.all([
      fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true }),
      fs.mkdir(repoPath, { recursive: true }),
      fs.mkdir(unlinkedCwd, { recursive: true }),
    ]);
    await seedUpdateState(home);
    await fs.writeFile(
      path.join(home, ".mate", "config.yaml"),
      `version: 1\ncompanions:\n  - path: ${companionPath}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents: [claude]\ncapabilities: []\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".mate", "config", "registry.yaml"),
      `repos:\n  - id: app\n    path: ${repoPath}\n`,
      "utf8",
    );

    const result = await runMate(unlinkedCwd, home, [
      "workspace",
      "resolve",
      "--host",
      "vscode-chat",
      "--cwd",
      repoPath,
      "--active",
      path.join(repoPath, "src", "index.ts"),
      "--workspace-root",
      repoPath,
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      schemaVersion: 1,
      status: "resolved",
      diagnostics: [],
      envelope: expect.objectContaining({
        schemaVersion: 1,
        host: "vscode-chat",
        workingRepositoryPath: repoPath,
        companionRepositoryPath: companionPath,
        permittedRoots: [repoPath, companionPath],
      }),
    });
    await expect(fs.stat(path.join(repoPath, ".mate"))).rejects.toThrow();
  });

  test("materialize writes the ordered workspace document for a valid pairing", async () => {
    const root = await makeTempDir("workspace-e2e-materialize-ok-");
    const home = path.join(root, "home");
    const companionPath = path.join(home, ".mate", "companions", "app");
    const repoPath = path.join(root, "repo");

    await Promise.all([
      fs.mkdir(companionPath, { recursive: true }),
      fs.mkdir(repoPath, { recursive: true }),
    ]);
    await seedUpdateState(home);
    await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, ".mate", "config", "registry.yaml"),
      `repos:\n  - id: app\n    path: ${repoPath}\n`,
      "utf8",
    );

    const result = await runMate(root, home, [
      "workspace",
      "materialize",
      "--repository",
      "app",
      "--companion",
      companionPath,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    expect(response).toEqual({
      schemaVersion: 1,
      workspacePath: path.join(repoPath, ".mate", "workspace.code-workspace"),
      folders: [repoPath, companionPath],
    });
    const written = JSON.parse(await fs.readFile(response.workspacePath, "utf8"));
    expect(written.folders).toEqual([{ path: repoPath }, { path: companionPath }]);
  });

  test("materialize fails with a machine-readable diagnostic and writes nothing for an unknown pairing", async () => {
    const root = await makeTempDir("workspace-e2e-materialize-unknown-");
    const home = path.join(root, "home");
    const companionPath = path.join(home, ".mate", "companions", "app");
    await fs.mkdir(companionPath, { recursive: true });
    await seedUpdateState(home);
    await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, ".mate", "config", "registry.yaml"),
      "repos: []\n",
      "utf8",
    );

    const result = await runMate(root, home, [
      "workspace",
      "materialize",
      "--repository",
      "unknown-repo",
      "--companion",
      companionPath,
      "--json",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("unknown-repo");
  });
});
