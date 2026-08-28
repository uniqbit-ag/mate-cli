import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { fileExists } from "../../lib/fs-utils";
import {
  repoLocalDirPath,
  writeRepoLocalRegistryEntry,
} from "../../lib/orchestrator/repo-local-registry";
import {
  projectionEnvPath,
  projectionYamlPath,
  writeProjectionPair,
} from "../../runtime/projection";
import { ensureWorkingRepoLocalExcludes } from "./working-repo-local-state";
import { cleanupWorkingRepository } from "./working-repo-cleanup";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeRepo(prefix: string): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoPath);
  await execFileAsync("git", ["init", "-q", repoPath]);
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("cleanupWorkingRepository", () => {
  test("removes Mate-owned state while preserving user agent files and settings", async () => {
    const repoPath = await makeRepo("mate-working-cleanup-");
    const companionPath = path.join(repoPath, "..", "companion");
    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath },
      "existing",
    );
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: `${companionPath}/.claude/hooks/mate-session-banner` },
              ],
            },
            { hooks: [{ type: "command", command: "echo user" }] },
          ],
        },
        permissions: {
          additionalDirectories: [companionPath, "/tmp/shared"],
          allow: ["Bash(ls:*)"],
        },
        customSetting: true,
      }),
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, ".claude", "notes.md"), "keep\n", "utf8");
    await fs.mkdir(path.join(repoPath, ".opencode"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".opencode", "user.json"), "{}\n", "utf8");
    await ensureWorkingRepoLocalExcludes(repoPath);

    const result = await cleanupWorkingRepository(repoPath, [companionPath]);
    const settings = JSON.parse(
      await fs.readFile(path.join(repoPath, ".claude", "settings.local.json"), "utf8"),
    );

    expect(result.changed).toBe(true);
    await expect(fs.access(repoLocalDirPath(repoPath))).rejects.toThrow();
    expect(settings).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] },
      permissions: { additionalDirectories: ["/tmp/shared"], allow: ["Bash(ls:*)"] },
      customSetting: true,
    });
    expect(await fs.readFile(path.join(repoPath, ".claude", "notes.md"), "utf8")).toBe("keep\n");
    expect(await fs.readFile(path.join(repoPath, ".opencode", "user.json"), "utf8")).toBe("{}\n");
  });

  test("prunes an empty managed settings file but preserves capability data and dirty Git state", async () => {
    const repoPath = await makeRepo("mate-working-cleanup-dirty-");
    const companionPath = path.join(repoPath, "..", "companion");
    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath },
      "existing",
    );
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "tracked.txt"]);
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

    const beforeStatus = (await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"]))
      .stdout;
    const result = await cleanupWorkingRepository(repoPath, [companionPath]);
    const afterStatus = (await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"]))
      .stdout;

    expect(afterStatus).toBe(beforeStatus);
    expect(result.retained).toContain("capability-excludes");
    await expect(
      fs.access(path.join(repoPath, ".claude", "settings.local.json")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(repoPath, ".tokensave", "store.db"), "utf8")).toBe("keep\n");
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).toContain(
      ".tokensave/\n",
    );
  });

  test("is idempotent and local state can be recreated", async () => {
    const repoPath = await makeRepo("mate-working-cleanup-repeat-");
    const companionPath = path.join(repoPath, "..", "companion");
    const repository = { id: "app", path: repoPath };
    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "existing");

    const first = await cleanupWorkingRepository(repoPath, [companionPath]);
    const second = await cleanupWorkingRepository(repoPath, [companionPath]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);

    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "existing");
    await fs.access(repoLocalDirPath(repoPath));
    expect(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8")).toContain(
      "/.mate/\n",
    );
  });

  test("removes both generated projection files with the repo-local directory", async () => {
    const repoPath = await makeRepo("mate-working-cleanup-projection-");
    const companionPath = path.join(repoPath, "..", "companion");
    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath },
      "existing",
    );
    writeProjectionPair(repoPath, {
      stamp: "stamp",
      projection: {
        version: "0.15.5",
        companionPath,
        repositoryPath: repoPath,
        repositoryId: "app",
        wrapperBinPath: "/install/mate/wrappers/bin",
        reactDoctorBinPath: "/install/mate/node_modules/.bin/react-doctor",
        graphifyOut: path.join(companionPath, ".graphify", "app", "graphify-out"),
      },
    });
    expect(await fileExists(projectionYamlPath(repoPath))).toBe(true);
    expect(await fileExists(projectionEnvPath(repoPath))).toBe(true);

    await cleanupWorkingRepository(repoPath);

    expect(await fileExists(projectionYamlPath(repoPath))).toBe(false);
    expect(await fileExists(projectionEnvPath(repoPath))).toBe(false);
    expect(await fileExists(repoLocalDirPath(repoPath))).toBe(false);
  });
});
