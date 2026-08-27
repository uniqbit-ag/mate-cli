import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeProjectionPair, type MateProjection } from "../runtime/projection";
import { companionLinkPath, repoLocalRegistryPath } from "../runtime/repo-local";
import { evaluate } from "./validate-artifact-path";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function initGitRepo(root: string): Promise<void> {
  spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

/** Wraps `repoRoot` against `companionPath` the way `mate wrap` does. */
async function wrapRepo(
  repoRoot: string,
  companionPath: string,
  stamp = "deadbeef",
): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  const projection: MateProjection = {
    version: "0.0.0",
    companionPath,
    repositoryPath: repoRoot,
    repositoryId: "acme",
    wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
    reactDoctorBinPath: path.join(companionPath, "react-doctor"),
    graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
  };
  writeProjectionPair(repoRoot, { stamp, projection });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("validate-artifact-path hook module", () => {
  test("fails open when neither the environment nor a projection resolves", async () => {
    const bare = await makeTempDir("mate-hook-unwrapped-");
    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: "/anywhere/design.md" } },
      {},
      bare,
    );
    expect(result.exitCode).toBe(0);
  });

  test("blocks an artifact write in a wrapped repository with an empty environment", async () => {
    const repo = await makeTempDir("mate-hook-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, companion);

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "design.md") } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(companion);
  });

  test("keeps guarding when the projection stamp does not match", async () => {
    const repo = await makeTempDir("mate-hook-stale-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, companion, "written-by-another-mate");

    expect(
      evaluate(
        { tool_name: "Write", tool_input: { file_path: path.join(repo, "design.md") } },
        {},
        repo,
      ).exitCode,
    ).toBe(2);
  });

  test("the launch environment outranks the projection", async () => {
    const repo = await makeTempDir("mate-hook-outranks-");
    const launched = path.join(repo, "launched");
    const projected = path.join(repo, "projected");
    await fs.mkdir(launched, { recursive: true });
    await fs.mkdir(projected, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, projected);

    const env = { MATE_ARTIFACT_PATH: launched, MATE_REPO_PATH: repo };
    expect(
      evaluate(
        { tool_name: "Write", tool_input: { file_path: path.join(launched, "design.md") } },
        env,
        repo,
      ).exitCode,
    ).toBe(0);
    expect(
      evaluate(
        { tool_name: "Write", tool_input: { file_path: path.join(projected, "design.md") } },
        env,
        repo,
      ).exitCode,
    ).toBe(2);
  });

  test("allows writes under the companion path", async () => {
    const repo = await makeTempDir("mate-hook-companion-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(companion, "design.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("allows non-artifact source writes to the working repo", async () => {
    const repo = await makeTempDir("mate-hook-source-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "src", "index.ts") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("allows README.md writes to the working repo", async () => {
    const repo = await makeTempDir("mate-hook-readme-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "README.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("allows gitignored working-repo artifact paths", async () => {
    const repo = await makeTempDir("mate-hook-ignored-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "scratch", "note.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("blocks non-gitignored working-repo artifact paths", async () => {
    const repo = await makeTempDir("mate-hook-blocked-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "scratch", "note.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("artifact writes must go to the companion framework path");
  });

  test("notes the companion CLAUDE.md location when blocking CLAUDE.md", async () => {
    const repo = await makeTempDir("mate-hook-claudemd-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "CLAUDE.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`${companion}/CLAUDE.md`);
  });

  test("allows gitignored bash tee targets in the working repo", async () => {
    const repo = await makeTempDir("mate-hook-bash-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const result = evaluate(
      { tool_name: "Bash", tool_input: { command: "printf hello | tee scratch/note.md" } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("blocks bash redirects that create working-repo artifacts", async () => {
    const repo = await makeTempDir("mate-hook-redirect-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = evaluate(
      { tool_name: "Bash", tool_input: { command: "echo notes >> scratch/note.md" } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
  });

  test("allows product documentation and storybook paths", async () => {
    const repo = await makeTempDir("mate-hook-docs-allow-");
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
      const result = evaluate(
        { tool_name: "Write", tool_input: { file_path: filePath } },
        { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      );
      expect(result.exitCode).toBe(0);
    }
  });

  test("still blocks artifact folders under product docs", async () => {
    const repo = await makeTempDir("mate-hook-docs-block-");
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
      const result = evaluate(
        { tool_name: "Write", tool_input: { file_path: filePath } },
        { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("artifact writes must go to the companion framework path");
    }
  });

  test("allows editing files already tracked in the working repo (product code)", async () => {
    const repo = await makeTempDir("mate-hook-tracked-");
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
      { cwd: repo, stdio: "ignore" },
    );

    const result = evaluate(
      { tool_name: "Edit", tool_input: { file_path: skillPath } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("allows editing existing working-repo artifact files, but still blocks Write", async () => {
    const repo = await makeTempDir("mate-hook-existing-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const notePath = path.join(repo, "scratch", "note.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "existing untracked artifact\n", "utf8");
    const env = { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo };

    expect(evaluate({ tool_name: "Edit", tool_input: { file_path: notePath } }, env).exitCode).toBe(
      0,
    );
    expect(
      evaluate({ tool_name: "Write", tool_input: { file_path: notePath } }, env).exitCode,
    ).toBe(2);
    expect(
      evaluate(
        { tool_name: "Edit", tool_input: { file_path: path.join(repo, "scratch", "missing.md") } },
        env,
      ).exitCode,
    ).toBe(2);
  });

  test("allows writes into Claude Code's own config directory (plan files)", async () => {
    const repo = await makeTempDir("mate-hook-config-dir-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const home = await makeTempDir("mate-hook-home-");
    const configDir = await makeTempDir("mate-hook-config-");
    const env = { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo, HOME: home };

    expect(
      evaluate(
        {
          tool_name: "Write",
          tool_input: { file_path: path.join(home, ".claude", "plans", "my-plan.md") },
        },
        env,
      ).exitCode,
    ).toBe(0);

    expect(
      evaluate(
        {
          tool_name: "Write",
          tool_input: { file_path: path.join(configDir, "plans", "my-plan.md") },
        },
        { ...env, CLAUDE_CONFIG_DIR: configDir },
      ).exitCode,
    ).toBe(0);

    // An overridden config dir must not leave the default ~/.claude allowed.
    expect(
      evaluate(
        {
          tool_name: "Write",
          tool_input: { file_path: path.join(home, ".claude", "plans", "my-plan.md") },
        },
        { ...env, CLAUDE_CONFIG_DIR: configDir },
      ).exitCode,
    ).toBe(2);
  });

  test("treats a write through the companion link as a companion write", async () => {
    const repo = await makeTempDir("mate-hook-link-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, companion);
    await fs.symlink(companion, companionLinkPath(repo), "dir");

    const throughLink = path.join(
      companionLinkPath(repo),
      "openspec",
      "changes",
      "acme",
      "proposal.md",
    );
    expect(
      evaluate({ tool_name: "Write", tool_input: { file_path: throughLink } }, {}, repo).exitCode,
    ).toBe(0);
    expect(
      evaluate(
        { tool_name: "Write", tool_input: { file_path: path.join(repo, "proposal.md") } },
        {},
        repo,
      ).exitCode,
    ).toBe(2);
  });

  test("judges an operator's own link by where it lands", async () => {
    const repo = await makeTempDir("mate-hook-operator-link-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.symlink(companion, path.join(repo, "artifacts"), "dir");

    const result = evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "artifacts", "design.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      repo,
    );
    expect(result.exitCode).toBe(0);
  });

  test("tolerates malformed payloads", () => {
    expect(evaluate(null, { MATE_ARTIFACT_PATH: "/tmp/companion" }).exitCode).toBe(0);
    expect(evaluate("garbage", { MATE_ARTIFACT_PATH: "/tmp/companion" }).exitCode).toBe(0);
    expect(
      evaluate({ tool_name: "Write" }, { MATE_ARTIFACT_PATH: "/tmp/companion" }).exitCode,
    ).toBe(0);
  });
});
