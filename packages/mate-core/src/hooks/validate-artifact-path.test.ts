import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ARTIFACT_REFUSAL_HEADLINE } from "../runtime/artifact-refusal";
import { writeProjectionPair, type MateProjection } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
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

  test("blocks a commit with a model co-author trailer in a wrapped repository", async () => {
    const repo = await makeTempDir("mate-hook-attribution-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    await wrapRepo(repo, companion);

    const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";
    const bash = (command: string) =>
      evaluate({ tool_name: "Bash", tool_input: { command } }, {}, repo);

    const refused = await bash(`git commit -m "fix: x" -m "${trailer}"`);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("No commit was created");

    /** Before the artifact checks: the attribution refusal wins over a redirect target. */
    const redirected = await bash(`git commit -m "${trailer}" > design.md`);
    expect(redirected.stderr).toContain("No commit was created");

    /** After the secret check: the secret refusal wins. */
    const secret = await bash(`git commit -m "${trailer}" && cat .env`);
    expect(secret.stderr).toContain("secret files are off-limits");

    expect((await bash(`git commit -m "Co-Authored-By: Jane <jane@acme.example>"`)).exitCode).toBe(
      0,
    );
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

  test("an artifact refusal is exit 2 with the message and a trailing newline", async () => {
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
    expect(result.stderr.endsWith("\n")).toBe(true);
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

  test("Edit and MultiEdit translate to edits and Write to a create", async () => {
    const repo = await makeTempDir("mate-hook-existing-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const notePath = path.join(repo, "scratch", "note.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "existing untracked artifact\n", "utf8");
    const env = { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo };
    const verdict = async (tool_name: string, tool_input: Record<string, unknown>) =>
      (await evaluate({ tool_name, tool_input }, env)).exitCode;

    expect(await verdict("Edit", { file_path: notePath })).toBe(0);
    expect(await verdict("MultiEdit", { file_path: notePath, edits: [{ new_string: "x" }] })).toBe(
      0,
    );
    expect(await verdict("Write", { file_path: notePath })).toBe(2);
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

  test("a config directory spelled with `link/..` is the folder the kernel reaches", async () => {
    const repo = await makeTempDir("mate-hook-config-link-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const root = await makeTempDir("mate-hook-config-link-root-");
    // `forward` leads to `other/sub`, so `forward/../claude` is `other/claude`.
    await fs.mkdir(path.join(root, "other", "sub"), { recursive: true });
    await fs.mkdir(path.join(root, "other", "claude"));
    await fs.symlink(path.join(root, "other", "sub"), path.join(root, "forward"));
    const env = {
      MATE_ARTIFACT_PATH: companion,
      MATE_REPO_PATH: repo,
      CLAUDE_CONFIG_DIR: `${path.join(root, "forward")}/../claude`,
    };
    const writeTo = (filePath: string) =>
      evaluate({ tool_name: "Write", tool_input: { file_path: filePath } }, env, repo);

    expect((await writeTo(path.join(root, "other", "claude", "plans", "p.md"))).exitCode).toBe(0);
    // The normalised spelling names another folder, which is not Claude Code's.
    expect((await writeTo(path.join(root, "claude", "plans", "p.md"))).exitCode).toBe(2);
  });

  test("tolerates malformed payloads", async () => {
    expect((await evaluate(null, { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode).toBe(0);
    expect((await evaluate("garbage", { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode).toBe(0);
    expect(
      (await evaluate({ tool_name: "Write" }, { MATE_ARTIFACT_PATH: "/tmp/companion" })).exitCode,
    ).toBe(0);
  });

  test("judges a malformed path or command rather than nothing", async () => {
    const repo = await makeTempDir("mate-hook-malformed-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await initGitRepo(repo);
    const env = { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo };
    const outcome = (toolName: string, toolInput: Record<string, unknown>) =>
      evaluate({ tool_name: toolName, tool_input: toolInput }, env, repo);

    expect((await outcome("Write", { file_path: ["notes.md"] })).exitCode).toBe(2);
    expect((await outcome("Read", { file_path: [".env"] })).stderr).toContain(
      "secret files are off-limits",
    );
    expect((await outcome("Bash", { command: ["cat .env"] })).stderr).toContain(
      "secret files are off-limits",
    );
    expect((await outcome("Write", { file_path: null })).exitCode).toBe(0);
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

  test("blocks Read of a differently-cased .Env", async () => {
    const { repo } = await wrapped();
    const result = await evaluate(
      { tool_name: "Read", tool_input: { file_path: path.join(repo, ".Env") } },
      {},
      repo,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(path.join(repo, ".Env"));
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
