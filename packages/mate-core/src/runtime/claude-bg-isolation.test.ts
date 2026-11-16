import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createTempDir } from "../../../../test/fixtures";
import { claudeSessionIsolation } from "./claude-bg-isolation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Setup {
  root: string;
  repo: string;
  config: string;
  /** A background session's environment, as its tools see it. */
  env: Record<string, string>;
}

/** A main checkout `acme` and a background job with `state`. */
async function setup(state: object = {}): Promise<Setup> {
  const root = await createTempDir("mate-bg-isolation-");
  roots.push(root);
  const repo = path.join(root, "acme");
  const config = path.join(root, "claude-config");
  const jobDir = path.join(config, "jobs", "acme");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  await fs.mkdir(path.join(repo, ".claude"), { recursive: true });
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "state.json"), JSON.stringify(state));
  return { root, repo, config, env: { CLAUDE_JOB_DIR: jobDir, CLAUDE_CONFIG_DIR: config } };
}

async function writeSettings(file: string, bgIsolation: string): Promise<void> {
  await fs.writeFile(file, JSON.stringify({ worktree: { bgIsolation } }));
}

/** Makes `checkout` a linked worktree of a clone beside it. */
async function linkWorktree(checkout: string): Promise<void> {
  const gitDir = path.join(checkout, "..", "main", ".git", "worktrees", "acme");
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "commondir"), "../..\n");
  await fs.rm(path.join(checkout, ".git"), { recursive: true, force: true });
  await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${gitDir}\n`);
}

describe("claudeSessionIsolation", () => {
  test("a background session with no setting is isolated", async () => {
    const { repo, env } = await setup();
    expect(claudeSessionIsolation(env, repo)).toEqual({ isolated: true, diagnostics: [] });
  });

  test("a visible session kind also marks a background session", async () => {
    const { repo, config } = await setup();
    const env = { CLAUDE_CODE_SESSION_KIND: "bg", CLAUDE_CONFIG_DIR: config };
    expect(claudeSessionIsolation(env, repo).isolated).toBe(true);
  });

  test("an interactive session is never isolated", async () => {
    const { repo, config } = await setup();
    expect(claudeSessionIsolation({ CLAUDE_CONFIG_DIR: config }, repo).isolated).toBe(false);
    expect(
      claudeSessionIsolation(
        { CLAUDE_CODE_SESSION_KIND: "interactive", CLAUDE_BG_ISOLATION: "worktree" },
        repo,
      ).isolated,
    ).toBe(false);
  });

  test("the repository can turn isolation off", async () => {
    const { repo, env } = await setup();
    await writeSettings(path.join(repo, ".claude", "settings.json"), "none");
    expect(claudeSessionIsolation(env, repo).isolated).toBe(false);
  });

  test("local settings win over project and user settings", async () => {
    const { repo, config, env } = await setup();
    await writeSettings(path.join(repo, ".claude", "settings.local.json"), "worktree");
    await writeSettings(path.join(repo, ".claude", "settings.json"), "none");
    await writeSettings(path.join(config, "settings.json"), "none");
    expect(claudeSessionIsolation(env, repo).isolated).toBe(true);
  });

  test("user settings apply when the repository sets nothing", async () => {
    const { repo, config, env } = await setup();
    await writeSettings(path.join(config, "settings.json"), "none");
    expect(claudeSessionIsolation(env, repo).isolated).toBe(false);
  });

  test("the variable wins over the job and settings", async () => {
    const { repo, config, env } = await setup({ bgIsolation: "worktree" });
    await writeSettings(path.join(config, "settings.json"), "worktree");
    const visible = { ...env, CLAUDE_BG_ISOLATION: "none" };
    expect(claudeSessionIsolation(visible, repo).isolated).toBe(false);
  });

  test("an invalid variable falls through to settings", async () => {
    const { repo, env } = await setup();
    await writeSettings(path.join(repo, ".claude", "settings.json"), "none");
    expect(claudeSessionIsolation({ ...env, CLAUDE_BG_ISOLATION: "off" }, repo)).toEqual({
      isolated: false,
      diagnostics: ['CLAUDE_BG_ISOLATION is "off", not "worktree" or "none"; ignored'],
    });
  });

  test("an unparseable or invalid file is skipped", async () => {
    const { repo, config, env } = await setup();
    await fs.writeFile(path.join(repo, ".claude", "settings.local.json"), "{ not json");
    const project = path.join(repo, ".claude", "settings.json");
    await writeSettings(project, "sometimes");
    await writeSettings(path.join(config, "settings.json"), "none");
    expect(claudeSessionIsolation(env, repo)).toEqual({
      isolated: false,
      diagnostics: [
        `worktree.bgIsolation in ${project} is "sometimes", not "worktree" or "none"; ignored`,
      ],
    });
  });

  test("a subfolder of a main checkout is isolated", async () => {
    const { repo, env } = await setup();
    const sub = path.join(repo, "packages", "acme");
    await fs.mkdir(sub, { recursive: true });
    expect(claudeSessionIsolation(env, sub).isolated).toBe(true);
  });

  test("a linked worktree, or a folder in one, is never isolated", async () => {
    const { repo, env } = await setup();
    await linkWorktree(repo);
    const sub = path.join(repo, "packages", "acme");
    await fs.mkdir(sub, { recursive: true });
    expect(claudeSessionIsolation(env, repo).isolated).toBe(false);
    expect(claudeSessionIsolation(env, sub).isolated).toBe(false);
  });

  test("a folder outside Git, such as an Umbrella Repository, is never isolated", async () => {
    const { root, env } = await setup();
    const umbrella = path.join(root, "umbrella");
    await fs.mkdir(path.join(umbrella, "acme", ".git"), { recursive: true });
    expect(claudeSessionIsolation(env, umbrella).isolated).toBe(false);
    expect(claudeSessionIsolation(env, path.join(root, "missing")).isolated).toBe(false);
  });

  describe("the job's own state", () => {
    test("its isolation wins over settings", async () => {
      const { repo, env } = await setup({ bgIsolation: "none" });
      await writeSettings(path.join(repo, ".claude", "settings.json"), "worktree");
      expect(claudeSessionIsolation(env, repo).isolated).toBe(false);
    });

    test("the --settings it was launched with win over settings files", async () => {
      const inline = JSON.stringify({ worktree: { bgIsolation: "none" } });
      const { repo, env } = await setup({ respawnFlags: ["--bg", "--settings", inline] });
      await writeSettings(path.join(repo, ".claude", "settings.local.json"), "worktree");
      expect(claudeSessionIsolation(env, repo)).toEqual({ isolated: false, diagnostics: [] });
    });

    test("a --settings file is read, and a later one wins", async () => {
      const { root, repo, env } = await setup();
      const file = path.join(root, "launch.bg.json");
      await writeSettings(file, "none");
      const flags = ["--settings", file, `--settings=${JSON.stringify({ model: "acme" })}`];
      await fs.writeFile(
        path.join(env.CLAUDE_JOB_DIR, "state.json"),
        JSON.stringify({ respawnFlags: flags }),
      );
      expect(claudeSessionIsolation(env, repo).isolated).toBe(false);
      const later = [...flags, "--settings", JSON.stringify({ worktree: { bgIsolation: "x" } })];
      await fs.writeFile(
        path.join(env.CLAUDE_JOB_DIR, "state.json"),
        JSON.stringify({ respawnFlags: [...later, "--settings", "{ not json"] }),
      );
      expect(claudeSessionIsolation(env, repo)).toEqual({
        isolated: false,
        diagnostics: [
          'worktree.bgIsolation in --settings is "x", not "worktree" or "none"; ignored',
        ],
      });
    });

    test("a variable inherited from another session does not count", async () => {
      const { repo, env } = await setup();
      const inherited = { ...env, MATE_CLAUDE_BG_ISOLATION: "none" };
      expect(claudeSessionIsolation(inherited, repo).isolated).toBe(true);
    });
  });
});
