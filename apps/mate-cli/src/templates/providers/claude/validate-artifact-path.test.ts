import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const HOOK_PATH = path.resolve(import.meta.dirname, "./.claude/hooks/validate-artifact-path");
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function initGitRepo(root: string): Promise<void> {
  spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

function runHook(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { exitCode: number; stderr: string } {
  const result = spawnSync("python3", [HOOK_PATH], {
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr,
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("validate-artifact-path", () => {
  test("allows gitignored working-repo artifact paths", async () => {
    const repo = await makeTempDir("mate-claude-hook-ignored-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const result = runHook(
      {
        tool_name: "Write",
        tool_input: {
          file_path: path.join(repo, "scratch", "note.md"),
        },
      },
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
      },
    );

    expect(result.exitCode).toBe(0);
  });

  test("blocks non-gitignored working-repo artifact paths", async () => {
    const repo = await makeTempDir("mate-claude-hook-blocked-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = runHook(
      {
        tool_name: "Write",
        tool_input: {
          file_path: path.join(repo, "scratch", "note.md"),
        },
      },
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("artifact writes must go to the companion framework path");
  });

  test("blocks Codex apply_patch artifact targets", async () => {
    const repo = await makeTempDir("mate-codex-hook-patch-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = runHook(
      {
        tool_name: "apply_patch",
        tool_input: {
          patch: "*** Begin Patch\n*** Add File: docs/decisions/new.md\n+artifact\n*** End Patch",
        },
      },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("artifact writes must go to the companion framework path");
  });

  test("allows gitignored bash tee targets in the working repo", async () => {
    const repo = await makeTempDir("mate-claude-hook-bash-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const result = runHook(
      {
        tool_name: "Bash",
        tool_input: {
          command: "printf hello | tee scratch/note.md",
        },
      },
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
      },
    );

    expect(result.exitCode).toBe(0);
  });

  test("allows product documentation and storybook paths", async () => {
    const repo = await makeTempDir("mate-claude-hook-docs-allow-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(path.join(repo, "apps", "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "apps", "docs", "package.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "package.json"), "{}\n", "utf8");
    await initGitRepo(repo);

    for (const filePath of [
      path.join(repo, "apps", "docs", "content", "docs", "index.mdx"),
      path.join(repo, "docs", "content", "index.mdx"),
      path.join(repo, ".storybook", "preview.ts"),
      path.join(repo, "storybook", "intro.mdx"),
    ]) {
      const result = runHook(
        {
          tool_name: "Write",
          tool_input: { file_path: filePath },
        },
        {
          MATE_ARTIFACT_PATH: companion,
          MATE_REPO_PATH: repo,
        },
      );

      expect(result.exitCode).toBe(0);
    }
  });

  test("allows editing files already tracked in the working repo (product code)", async () => {
    const repo = await makeTempDir("mate-claude-hook-tracked-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const skillPath = path.join(repo, "src", "templates", "skills", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "packaged skill template\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync(
      "git",
      ["-c", "user.name=Mate", "-c", "user.email=mate@example.test", "commit", "-qm", "initial"],
      {
        cwd: repo,
        stdio: "ignore",
      },
    );

    const result = runHook(
      {
        tool_name: "Edit",
        tool_input: { file_path: skillPath },
      },
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
      },
    );

    expect(result.exitCode).toBe(0);
  });

  test("still blocks artifact folders under product docs", async () => {
    const repo = await makeTempDir("mate-claude-hook-docs-block-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(path.join(repo, "apps", "docs-without-package"), { recursive: true });
    await initGitRepo(repo);

    for (const filePath of [
      path.join(repo, "apps", "docs-without-package", "guide.md"),
      path.join(repo, "docs", "usage.md"),
      path.join(repo, "docs", "decisions", "ADR-001.md"),
      path.join(repo, "docs", "prd", "new-feature.md"),
      path.join(repo, "docs", "usage", "tasks.md"),
    ]) {
      const result = runHook(
        {
          tool_name: "Write",
          tool_input: { file_path: filePath },
        },
        {
          MATE_ARTIFACT_PATH: companion,
          MATE_REPO_PATH: repo,
        },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("artifact writes must go to the companion framework path");
    }
  });
});
