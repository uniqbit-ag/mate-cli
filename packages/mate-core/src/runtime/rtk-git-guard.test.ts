import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createTempDir } from "../../../../test/fixtures";
import { companionFrameworkConfigPath } from "./policy";
import { companionSelectsRtk, runnableGitCommand, type RewriteRunner } from "./rtk-git-guard";

/** RTK 1.1.0's observed `rtk rewrite` output; null where it printed nothing. */
const OBSERVED: Record<string, string | null> = {
  "git status": "rtk git status",
  "cd /x && git status": "cd /x && rtk git status",
  "git status && ls": "rtk git status && rtk ls",
  "FOO=1 git status": "FOO=1 rtk git status",
  "RTK_DISABLED=1 git status && git log": "RTK_DISABLED=1 git status && rtk git log",
  "git -C /x log | head": "rtk git -C /x log | head",
  "RTK_DISABLED=1 git status": null,
  "gh pr view": "rtk gh pr view",
  "ls -la": "rtk ls -la",
  "echo hi": null,
};

const observed: RewriteRunner = (command) => OBSERVED[command] ?? null;

describe("runnableGitCommand", () => {
  test("names RTK's rewrite with each rtk git opted out", () => {
    expect(runnableGitCommand("git status", observed)).toBe("RTK_DISABLED=1 git status");
    expect(runnableGitCommand("cd /x && git status", observed)).toBe(
      "cd /x && RTK_DISABLED=1 git status",
    );
    expect(runnableGitCommand("FOO=1 git status", observed)).toBe(
      "FOO=1 RTK_DISABLED=1 git status",
    );
    expect(runnableGitCommand("git -C /x log | head", observed)).toBe(
      "RTK_DISABLED=1 git -C /x log | head",
    );
  });

  test("keeps every other segment as RTK rewrites it", () => {
    expect(runnableGitCommand("git status && ls", observed)).toBe(
      "RTK_DISABLED=1 git status && rtk ls",
    );
    expect(runnableGitCommand("RTK_DISABLED=1 git status && git log", observed)).toBe(
      "RTK_DISABLED=1 git status && RTK_DISABLED=1 git log",
    );
  });

  test("makes no decision when RTK runs no git", () => {
    expect(runnableGitCommand("RTK_DISABLED=1 git status", observed)).toBeNull();
    expect(runnableGitCommand("gh pr view", observed)).toBeNull();
    expect(runnableGitCommand("ls -la", observed)).toBeNull();
    expect(runnableGitCommand("echo hi", observed)).toBeNull();
    expect(runnableGitCommand("rtk gitlab", () => "rtk gitlab")).toBeNull();
  });

  test("makes no decision when the runner fails", () => {
    expect(
      runnableGitCommand("git status", () => {
        throw new Error("spawn rtk ENOENT");
      }),
    ).toBeNull();
  });
});

describe("companionSelectsRtk", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function companion(capabilities: string[]): Promise<string> {
    const root = await createTempDir("mate-rtk-guard-");
    roots.push(root);
    const config = companionFrameworkConfigPath(root);
    await fs.mkdir(path.dirname(config), { recursive: true });
    const lines = capabilities.map((name) => `  - name: ${name}`);
    await fs.writeFile(config, ["capabilities:", ...lines, ""].join("\n"));
    return root;
  }

  test("reads the launch environment's companion", async () => {
    const selected = await companion(["openspec", "rtk"]);
    const other = await companion(["openspec"]);

    expect(companionSelectsRtk(selected, { MATE_ARTIFACT_PATH: selected })).toBe(true);
    expect(companionSelectsRtk(other, { MATE_ARTIFACT_PATH: other })).toBe(false);
  });

  test("no companion selects nothing", async () => {
    const root = await companion([]);
    expect(companionSelectsRtk(root, {})).toBe(false);
  });
});
