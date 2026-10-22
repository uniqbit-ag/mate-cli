import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ARTIFACT_REFUSAL_HEADLINE } from "../runtime/artifact-refusal";
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
    const result = await evaluate(
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

    const result = await evaluate(
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
      (
        await evaluate(
          { tool_name: "Write", tool_input: { file_path: path.join(repo, "design.md") } },
          {},
          repo,
        )
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
      (
        await evaluate(
          { tool_name: "Write", tool_input: { file_path: path.join(launched, "design.md") } },
          env,
          repo,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await evaluate(
          { tool_name: "Write", tool_input: { file_path: path.join(projected, "design.md") } },
          env,
          repo,
        )
      ).exitCode,
    ).toBe(2);
  });

  test("allows writes under the companion path", async () => {
    const repo = await makeTempDir("mate-hook-companion-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });

    const result = await evaluate(
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

    const result = await evaluate(
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

    const result = await evaluate(
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

    const result = await evaluate(
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

    const result = await evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "scratch", "note.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);
  });

  test("notes the companion CLAUDE.md location when blocking CLAUDE.md", async () => {
    const repo = await makeTempDir("mate-hook-claudemd-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);

    const result = await evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "CLAUDE.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`${companion}/CLAUDE.md`);
  });

  test("explains a relative redirect after cd into the companion", async () => {
    const repo = await makeTempDir("mate-hook-cd-");
    const companion = await makeTempDir("mate-hook-cd-companion-");
    await initGitRepo(repo);

    const result = await evaluate(
      { tool_name: "Bash", tool_input: { command: `cd ${companion} && cat > notes/handoff.md` } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(` resolved:  ${path.join(repo, "notes", "handoff.md")}`);
    expect(result.stderr).toContain("Relative paths resolve against the working repository");
    expect(result.stderr).toContain("`cd` is not followed");
    expect(result.stderr).toContain(` suggested: ${path.join(companion, "notes", "handoff.md")}`);
  });

  test("suggests a companion path for an absolute in-repo target", async () => {
    const repo = await makeTempDir("mate-hook-abs-");
    const companion = await makeTempDir("mate-hook-abs-companion-");
    await initGitRepo(repo);

    const result = await evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "scratch", "plan.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(` suggested: ${path.join(companion, "scratch", "plan.md")}`);
    expect(result.stderr).not.toContain("resolved:");
    expect(result.stderr).not.toContain("Relative paths resolve");
  });

  test("suggests nothing for a target outside the working repo", async () => {
    const repo = await makeTempDir("mate-hook-out-");
    const companion = await makeTempDir("mate-hook-out-companion-");
    const elsewhere = await makeTempDir("mate-hook-out-elsewhere-");
    await initGitRepo(repo);

    const result = await evaluate(
      {
        tool_name: "Bash",
        tool_input: { command: `echo x > ${path.join(elsewhere, "notes.md")}` },
      },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(` companion: ${companion}`);
    expect(result.stderr).not.toContain("suggested:");
  });

  describe("heredoc bodies", () => {
    async function bashVerdict(command: string): Promise<number> {
      const repo = await makeTempDir("mate-hook-heredoc-");
      const companion = await makeTempDir("mate-hook-heredoc-companion-");
      await initGitRepo(repo);
      const result = await evaluate(
        { tool_name: "Bash", tool_input: { command } },
        { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      );
      return result.exitCode;
    }

    test("ignores redirect-like text in a heredoc body", async () => {
      const command = [
        "cat >> src/app.ts <<'EOF'",
        "const files = roots.flatMap((root) =>",
        '  ["CLAUDE.md", "AGENTS.md"].map((name) => path.join(root, name)),',
        ");",
        "echo notes > scratch/plan.md",
        "EOF",
      ].join("\n");
      expect(await bashVerdict(command)).toBe(0);
    });

    test("still judges a redirect after the heredoc marker", async () => {
      expect(await bashVerdict("cat <<'EOF' > notes/x.md\nbody\nEOF")).toBe(2);
    });

    test("still judges a redirect before the heredoc marker", async () => {
      expect(await bashVerdict("cat > notes/x.md <<EOF\nbody\nEOF")).toBe(2);
    });

    test("still judges a redirect after the heredoc ends", async () => {
      expect(await bashVerdict("cat <<EOF | sort\nbody\nEOF\necho x > notes/x.md")).toBe(2);
    });

    test("does not pair a line-end redirect with a later line", async () => {
      expect(await bashVerdict("node -e 'a =>\nnotes.md'")).toBe(0);
    });

    test("does not pair a line-end tee with a later line", async () => {
      expect(await bashVerdict("echo hi | tee\nnotes.md")).toBe(0);
    });
  });

  test("allows gitignored bash tee targets in the working repo", async () => {
    const repo = await makeTempDir("mate-hook-bash-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");

    const result = await evaluate(
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

    const result = await evaluate(
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
      const result = await evaluate(
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
      const result = await evaluate(
        { tool_name: "Write", tool_input: { file_path: filePath } },
        { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);
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

    const result = await evaluate(
      { tool_name: "Edit", tool_input: { file_path: skillPath } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(result.exitCode).toBe(0);
  });

  test("an inherited GIT_DIR does not change the tracked-path answer", async () => {
    const repo = await makeTempDir("mate-hook-git-dir-");
    const elsewhere = await makeTempDir("mate-hook-elsewhere-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await initGitRepo(elsewhere);
    const docPath = path.join(repo, "notes", "acme.md");
    await fs.mkdir(path.dirname(docPath), { recursive: true });
    await fs.writeFile(docPath, "tracked\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync(
      "git",
      ["-c", "user.name=Mate", "-c", "user.email=mate@example.test", "commit", "-qm", "initial"],
      { cwd: repo, stdio: "ignore" },
    );

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, ".git");
    try {
      const result = await evaluate(
        { tool_name: "Write", tool_input: { file_path: docPath } },
        { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
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

    expect(
      (await evaluate({ tool_name: "Edit", tool_input: { file_path: notePath } }, env)).exitCode,
    ).toBe(0);
    expect(
      (await evaluate({ tool_name: "Write", tool_input: { file_path: notePath } }, env)).exitCode,
    ).toBe(2);
    expect(
      (
        await evaluate(
          {
            tool_name: "Edit",
            tool_input: { file_path: path.join(repo, "scratch", "missing.md") },
          },
          env,
        )
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
      (
        await evaluate(
          {
            tool_name: "Write",
            tool_input: { file_path: path.join(home, ".claude", "plans", "my-plan.md") },
          },
          env,
        )
      ).exitCode,
    ).toBe(0);

    expect(
      (
        await evaluate(
          {
            tool_name: "Write",
            tool_input: { file_path: path.join(configDir, "plans", "my-plan.md") },
          },
          { ...env, CLAUDE_CONFIG_DIR: configDir },
        )
      ).exitCode,
    ).toBe(0);

    // An overridden config dir must not leave the default ~/.claude allowed.
    expect(
      (
        await evaluate(
          {
            tool_name: "Write",
            tool_input: { file_path: path.join(home, ".claude", "plans", "my-plan.md") },
          },
          { ...env, CLAUDE_CONFIG_DIR: configDir },
        )
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
      (await evaluate({ tool_name: "Write", tool_input: { file_path: throughLink } }, {}, repo))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await evaluate(
          { tool_name: "Write", tool_input: { file_path: path.join(repo, "proposal.md") } },
          {},
          repo,
        )
      ).exitCode,
    ).toBe(2);
  });

  test("judges an operator's own link by where it lands", async () => {
    const repo = await makeTempDir("mate-hook-operator-link-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await fs.symlink(companion, path.join(repo, "artifacts"), "dir");

    const result = await evaluate(
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "artifacts", "design.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      repo,
    );
    expect(result.exitCode).toBe(0);
  });

  test("tolerates malformed payloads", async () => {
    expect((await evaluate(null, { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode).toBe(0);
    expect((await evaluate("garbage", { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode).toBe(0);
    expect(
      (await evaluate({ tool_name: "Write" }, { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode,
    ).toBe(0);
  });
});

describe("validate-artifact-path secret guardrails", () => {
  const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

  async function wrapped(): Promise<{ repo: string; companion: string }> {
    const repo = await makeTempDir("mate-hook-secrets-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, companion);
    return { repo, companion };
  }

  test("blocks Read of .env, naming the path but not the contents", async () => {
    const { repo } = await wrapped();
    await fs.writeFile(path.join(repo, ".env"), "API_KEY=supersecret\n");

    const result = await evaluate(
      { tool_name: "Read", tool_input: { file_path: path.join(repo, ".env") } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(path.join(repo, ".env"));
    expect(result.stderr).toContain("secrets");
    expect(result.stderr).not.toContain("supersecret");
  });

  test("blocks Write to .env.local", async () => {
    const { repo } = await wrapped();
    const result = await evaluate(
      { tool_name: "Write", tool_input: { file_path: ".env.local", content: "KEY=1\n" } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
  });

  test("blocks NotebookEdit on a key file", async () => {
    const { repo } = await wrapped();
    const result = await evaluate(
      { tool_name: "NotebookEdit", tool_input: { notebook_path: "certs/server.key" } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
  });

  test("lets Read of .env.example through", async () => {
    const { repo } = await wrapped();
    const result = await evaluate(
      { tool_name: "Read", tool_input: { file_path: path.join(repo, ".env.example") } },
      {},
      repo,
    );
    expect(result).toEqual({ exitCode: 0, stderr: "" });
  });

  test("blocks Grep in .env or with a glob aimed at secret files, but not an ordinary search", async () => {
    const { repo } = await wrapped();
    const inFile = await evaluate(
      { tool_name: "Grep", tool_input: { pattern: "KEY", path: path.join(repo, ".env") } },
      {},
      repo,
    );
    expect(inFile.exitCode).toBe(2);
    const byGlob = await evaluate(
      { tool_name: "Grep", tool_input: { pattern: "KEY", path: repo, glob: ".env*" } },
      {},
      repo,
    );
    expect(byGlob.exitCode).toBe(2);
    const ordinary = await evaluate(
      { tool_name: "Grep", tool_input: { pattern: "KEY", path: repo, glob: "*.ts" } },
      {},
      repo,
    );
    expect(ordinary.exitCode).toBe(0);
  });

  test("blocks a Bash command that names a secret file", async () => {
    const { repo } = await wrapped();
    for (const command of ["cat acme/.env", "echo TOKEN=x >> .env"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential is clearer here
      const result = await evaluate({ tool_name: "Bash", tool_input: { command } }, {}, repo);
      expect(result.exitCode).toBe(2);
    }
    const example = await evaluate(
      { tool_name: "Bash", tool_input: { command: "cat .env.example" } },
      {},
      repo,
    );
    expect(example.exitCode).toBe(0);
  });

  test("blocks a companion write that carries a token, without echoing it", async () => {
    const { repo, companion } = await wrapped();
    const result = await evaluate(
      {
        tool_name: "Write",
        tool_input: {
          file_path: path.join(companion, "notes", "design.md"),
          content: `token: ${GITHUB_TOKEN}\n`,
        },
      },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("@secretlint/secretlint-rule-github");
    expect(result.stderr).not.toContain(GITHUB_TOKEN);
  });

  test("does not content-scan a product code write", async () => {
    const { repo } = await wrapped();
    const result = await evaluate(
      {
        tool_name: "Edit",
        tool_input: { file_path: path.join(repo, "src", "app.ts"), new_string: GITHUB_TOKEN },
      },
      {},
      repo,
    );
    expect(result.exitCode).toBe(0);
  });

  test("allows everything once the companion opts out", async () => {
    const { repo, companion } = await wrapped();
    const configPath = path.join(companion, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "secrets:\n  guardrails: false\n", "utf8");

    const result = await evaluate(
      { tool_name: "Read", tool_input: { file_path: path.join(repo, ".env") } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(0);
  });
});
