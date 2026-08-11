import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repo-local-registry";

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

async function seedPairing(home: string, companionPath: string, repoPath: string): Promise<void> {
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".mate", "config.yaml"),
    `version: 1\ncompanions:\n  - path: ${companionPath}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "registry.yaml"),
    `repos:\n  - id: app\n    path: ${repoPath}\n`,
    "utf8",
  );
}

describe("mate working cleanup (real CLI, e2e)", () => {
  test("cleans from a subdirectory, preserves dirty work, and succeeds repeatedly", async () => {
    const root = await makeTempDir("working-cleanup-e2e-");
    const home = path.join(root, "home");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "repo");
    const nested = path.join(repoPath, "src", "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    await seedUpdateState(home);
    await Bun.$`git init -q ${repoPath}`;
    await seedPairing(home, companionPath, repoPath);
    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath },
      "existing",
    );
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf8");
    await Bun.$`git -C ${repoPath} add tracked.txt`;
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "keep\n", "utf8");
    await fs.mkdir(path.join(repoPath, ".tokensave"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".tokensave", "store.db"), "keep\n", "utf8");
    await fs.appendFile(path.join(repoPath, ".git", "info", "exclude"), ".tokensave/\n");
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { additionalDirectories: [companionPath] } }),
      "utf8",
    );
    const beforeStatus = (await Bun.$`git -C ${repoPath} status --porcelain`.text()).trim();

    const inventory = await runMate(nested, home, ["workspace", "list", "--json"]);
    const first = await runMate(nested, home, ["working", "cleanup"]);
    const afterStatus = (await Bun.$`git -C ${repoPath} status --porcelain`.text()).trim();
    const second = await runMate(nested, home, ["working", "cleanup"]);

    if (first.code !== 0) {
      throw new Error(
        `${first.stderr || first.stdout}\ninventory: ${inventory.stdout || inventory.stderr}`,
      );
    }
    if (second.code !== 0) throw new Error(second.stderr || second.stdout);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("cleaned working repository");
    expect(afterStatus).toBe(beforeStatus);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already clean");
    await expect(fs.access(path.join(repoPath, ".mate"))).rejects.toThrow();
    expect(await fs.readFile(path.join(repoPath, ".tokensave", "store.db"), "utf8")).toBe("keep\n");
    const exclude = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("# mate managed: start");
    expect(exclude).toContain(".tokensave/\n");
  });

  test("rejects unregistered, companion, and hub repositories without removing local state", async () => {
    const root = await makeTempDir("working-cleanup-reject-e2e-");
    const home = path.join(root, "home");
    await seedUpdateState(home);
    for (const kind of ["unregistered", "companion", "hub"] as const) {
      const repoPath = path.join(root, kind);
      await fs.mkdir(path.join(repoPath, ".mate", "config"), { recursive: true });
      await Bun.$`git init -q ${repoPath}`;
      if (kind !== "unregistered") {
        await fs.writeFile(
          path.join(repoPath, ".mate", "config", "framework.yaml"),
          `type: ${kind}\n`,
          "utf8",
        );
      }
      const result = await runMate(repoPath, home, ["working", "cleanup"]);
      expect(result.code).not.toBe(0);
      await fs.access(path.join(repoPath, ".mate"));
    }
  });
});
