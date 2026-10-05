import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { parse } from "yaml";

import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import type { GitOps } from "../artifact/finish/git";
import { defaultGitOps } from "../artifact/finish/git";
import {
  companionUpdateDeps,
  diffChangedPaths,
  DELETED,
  runCompanionUpdateCommand,
  snapshotChangedPaths,
} from "./update";

const original = { ...companionUpdateDeps };
const COMPANION = "/tmp/acme-companion";
const CONFIG: FrameworkConfig = { type: "companion", allowedAgents: ["claude"] };

/** In-memory working tree: uncommitted paths and their content. */
interface World {
  changed: Set<string>;
  content: Map<string, string>;
}

function write(world: World, filePath: string, content: string): void {
  world.changed.add(filePath);
  world.content.set(filePath, content);
}

function fakeGit(world: World, overrides: Partial<GitOps> = {}): GitOps {
  return {
    currentBranch: async () => "main",
    defaultBranch: async () => "main",
    changedPaths: async () => [...world.changed],
    stagedPaths: async () => [],
    add: mock(async () => {}),
    hasStagedChanges: async () => false,
    commit: mock(async () => {}),
    hasUpstream: async () => true,
    fetch: async () => {},
    rebaseOntoUpstream: async () => ({ ok: true, conflictedPaths: [] }),
    tagExists: async () => false,
    tag: async () => {},
    push: mock(async () => ({ ok: true, error: "" })),
    ...overrides,
  };
}

interface Setup {
  world: World;
  git: GitOps;
  sync: ReturnType<typeof mock>;
  skills: ReturnType<typeof mock>;
  floor: ReturnType<typeof mock>;
  confirm: ReturnType<typeof mock>;
}

function setup(
  options: {
    current?: string;
    latest?: string | Error;
    sync?: (world: World) => void | Promise<void>;
    floorWrites?: boolean;
    skillsLock?: boolean;
    skills?: () => Promise<void>;
    answers?: boolean[];
    interactive?: boolean;
    git?: Partial<GitOps>;
    world?: World;
  } = {},
): Setup {
  const world = options.world ?? { changed: new Set(), content: new Map() };
  const git = fakeGit(world, options.git);
  const sync = mock(async () => {
    await options.sync?.(world);
  });
  const skills = mock(options.skills ?? (async () => {}));
  const floor = mock(async () => {
    if (options.floorWrites === false) return false;
    write(world, ".mate/config/framework.yaml", "engines-bumped");
    return true;
  });
  const answers = [...(options.answers ?? [])];
  const confirm = mock(async () => answers.shift() ?? false);
  Object.assign(companionUpdateDeps, {
    resolveCompanionPath: async () => COMPANION,
    resolveProjectedCompanionPath: () => undefined,
    getCurrentVersion: () => options.current ?? "0.17.0",
    fetchLatestVersion: async () => {
      const latest = options.latest ?? "0.17.0";
      if (latest instanceof Error) throw latest;
      return latest;
    },
    loadConfig: async () => CONFIG,
    syncCompanionFiles: sync,
    writeEngineFloor: floor,
    hasSkillsLock: async () => options.skillsLock ?? false,
    runSkillsUpdate: skills,
    createGitOps: () => git,
    snapshotPath: async (_companion: string, filePath: string) =>
      world.content.get(filePath) ?? DELETED,
    confirm,
    isInteractive: () => options.interactive ?? true,
  });
  return { world, git, sync, skills, floor, confirm };
}

function captureOutput(): { out: () => string; err: () => string; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

async function run(argv: string[] = []): Promise<{ out: string; err: string }> {
  const captured = captureOutput();
  try {
    await runCompanionUpdateCommand(argv);
  } finally {
    captured.restore();
  }
  return { out: captured.out(), err: captured.err() };
}

const regenerateSkill = (world: World) =>
  write(world, ".claude/skills/mate-grill-me/SKILL.md", "new skill");

let originalExitCode: number | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  Object.assign(companionUpdateDeps, original);
  process.exitCode = originalExitCode ?? 0;
});

describe("mate companion update — companion resolution", () => {
  test("updates the companion the repo-local resolver answers", async () => {
    const { sync } = setup({ sync: regenerateSkill });
    await run();
    expect(sync).toHaveBeenCalledWith(COMPANION, CONFIG);
  });

  test("falls back to the Projection Root for a Wrapped Repository", async () => {
    const { sync } = setup({ sync: regenerateSkill });
    Object.assign(companionUpdateDeps, {
      resolveCompanionPath: async () => undefined,
      resolveProjectedCompanionPath: () => "/tmp/acme-projected",
    });
    await run();
    expect(sync).toHaveBeenCalledWith("/tmp/acme-projected", CONFIG);
  });

  test("refuses with link guidance when no companion resolves", async () => {
    const { sync } = setup();
    Object.assign(companionUpdateDeps, {
      resolveCompanionPath: async () => undefined,
      resolveProjectedCompanionPath: () => undefined,
    });
    const { err } = await run();
    expect(err).toContain("companion link");
    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("rejects unknown arguments", async () => {
    const { sync } = setup();
    const { err } = await run(["--acme"]);
    expect(err).toContain("--acme");
    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("mate companion update — version precondition", () => {
  test("proceeds when the running version is the newest stable", async () => {
    const { sync } = setup({ sync: regenerateSkill });
    await run();
    expect(sync).toHaveBeenCalled();
  });

  test("refuses when behind, naming both versions and `mate update`", async () => {
    const { sync, floor } = setup({ current: "0.16.2", latest: "0.17.0" });
    const { err } = await run();
    expect(err).toContain("0.16.2");
    expect(err).toContain("0.17.0");
    expect(err).toContain("mate update");
    expect(sync).not.toHaveBeenCalled();
    expect(floor).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("refuses a canary without consulting the registry", async () => {
    const fetchLatest = mock(async () => "0.17.0");
    const { sync } = setup({ current: "0.17.0-canary.11" });
    companionUpdateDeps.fetchLatestVersion = fetchLatest;
    const { err } = await run();
    expect(err).toContain("requires a stable mate");
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("refuses when the registry is unreachable", async () => {
    const { sync, floor } = setup({ latest: new Error("ENOTFOUND registry.acme.test") });
    const { err } = await run();
    expect(err).toContain("could not check the registry");
    expect(sync).not.toHaveBeenCalled();
    expect(floor).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("mate companion update — regeneration", () => {
  test("a failed synchronization offers no commit and does not raise the floor", async () => {
    const { git, floor, confirm } = setup({
      sync: () => {
        throw new Error("openspec update failed");
      },
    });
    const { err } = await run();
    expect(err).toContain("openspec update failed");
    expect(floor).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("refreshes third-party skills when skills-lock.json exists and commits their output", async () => {
    const world: World = { changed: new Set(), content: new Map() };
    const { skills, git } = setup({
      world,
      floorWrites: false,
      skillsLock: true,
      skills: async () => {
        write(world, ".claude/skills/acme-skill/SKILL.md", "refreshed");
        write(world, "skills-lock.json", "relocked");
      },
      answers: [true, true],
    });
    await run();
    expect(skills).toHaveBeenCalledWith(COMPANION);
    expect(git.commit).toHaveBeenCalledWith("chore(mate): update companion to mate 0.17.0", [
      ".claude/skills/acme-skill/SKILL.md",
      "skills-lock.json",
    ]);
  });

  test("skips the skills CLI when skills-lock.json is absent", async () => {
    const { skills } = setup({ sync: regenerateSkill, skillsLock: false });
    await run();
    expect(skills).not.toHaveBeenCalled();
  });

  test("a failed skill refresh warns and continues to the floor and commit prompt", async () => {
    const { floor, confirm } = setup({
      skillsLock: true,
      skills: async () => {
        throw new Error("npx skills update exited with code 1");
      },
      answers: [false],
    });
    const { err } = await run();
    expect(err).toContain("warning");
    expect(err).toContain("exited with code 1");
    expect(floor).toHaveBeenCalledWith(COMPANION, ">=0.17.0");
    expect(confirm).toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("mate companion update — commit scope", () => {
  test("excludes an unrelated local edit from the commit", async () => {
    const world: World = { changed: new Set(), content: new Map() };
    write(world, "notes/acme.md", "local edit");
    const { git } = setup({ world, sync: regenerateSkill, answers: [true, false] });
    await run();
    const committed = (git.commit as ReturnType<typeof mock>).mock.calls[0]?.[1] as string[];
    expect(committed).toEqual([
      ".claude/skills/mate-grill-me/SKILL.md",
      ".mate/config/framework.yaml",
    ]);
    expect(committed).not.toContain("notes/acme.md");
  });

  test("refuses to commit when the update rewrote a locally edited file", async () => {
    const world: World = { changed: new Set(), content: new Map() };
    write(world, ".claude/skills/mate-grill-me/SKILL.md", "local edit");
    const { git, confirm } = setup({ world, sync: regenerateSkill });
    const { err } = await run();
    expect(err).toContain(".claude/skills/mate-grill-me/SKILL.md");
    expect(err).toContain("can no longer be separated");
    expect(confirm).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("reports up to date without prompting when nothing was written", async () => {
    const { confirm, git } = setup({ floorWrites: false });
    const { out } = await run();
    expect(out).toContain("already up to date with mate 0.17.0");
    expect(confirm).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("mate companion update — commit and push prompts", () => {
  test("commits with the conventional message and pushes on confirmation", async () => {
    const { git, confirm } = setup({ sync: regenerateSkill, answers: [true, true] });
    const { out } = await run();
    expect(out).toContain(".claude/skills/mate-grill-me/SKILL.md");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(git.commit).toHaveBeenCalledWith("chore(mate): update companion to mate 0.17.0", [
      ".claude/skills/mate-grill-me/SKILL.md",
      ".mate/config/framework.yaml",
    ]);
    expect(git.push).toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("declining the commit asks no push question", async () => {
    const { git, confirm } = setup({ sync: regenerateSkill, answers: [false] });
    await run();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("never consults the companion's git policy", async () => {
    const { confirm } = setup({ sync: regenerateSkill, answers: [true, true] });
    await run();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("--yes answers both prompts", async () => {
    const { git, confirm } = setup({ sync: regenerateSkill, interactive: false });
    await run(["--yes"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(git.commit).toHaveBeenCalled();
    expect(git.push).toHaveBeenCalled();
  });

  test("a non-interactive shell without --yes leaves changes uncommitted", async () => {
    const { git, confirm } = setup({ sync: regenerateSkill, interactive: false });
    const { out } = await run();
    expect(out).toContain("left uncommitted");
    expect(confirm).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("no upstream keeps the local commit", async () => {
    const { git } = setup({
      sync: regenerateSkill,
      answers: [true, true],
      git: { hasUpstream: async () => false },
    });
    const { out } = await run();
    expect(out).toContain("no upstream");
    expect(git.commit).toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a rejected push reports and exits non-zero", async () => {
    setup({
      sync: regenerateSkill,
      answers: [true, true],
      git: { push: async () => ({ ok: false, error: "rejected (fetch first)" }) },
    });
    const { err } = await run();
    expect(err).toContain("push failed");
    expect(err).toContain("rejected (fetch first)");
    expect(process.exitCode).toBe(1);
  });
});

describe("mate companion update — real working tree", () => {
  let root: string;

  function git(...args: string[]): void {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-companion-"));
    git("init", "-q");
    git("config", "user.email", "acme@example.test");
    git("config", "user.name", "Acme");
    await fs.mkdir(path.join(root, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents:\n  - claude\n",
    );
    await fs.writeFile(path.join(root, "tracked.md"), "v1\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("detects writes inside an untracked directory and deletions, and flags rewritten local edits", async () => {
    await fs.mkdir(path.join(root, "skills", "acme"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "acme", "SKILL.md"), "local\n");
    await fs.writeFile(path.join(root, "notes.md"), "untouched\n");
    const ops = defaultGitOps(root, undefined);
    const before = await snapshotChangedPaths(root, ops);

    await fs.writeFile(path.join(root, "skills", "acme", "SKILL.md"), "regenerated\n");
    await fs.rm(path.join(root, "tracked.md"));
    await fs.mkdir(path.join(root, "fresh"), { recursive: true });
    await fs.writeFile(path.join(root, "fresh", "SKILL.md"), "new\n");

    const changes = await diffChangedPaths(root, ops, before);
    expect(changes.written).toEqual(["fresh/", "skills/", "tracked.md"]);
    expect(changes.conflict).toEqual(["skills/"]);
  });

  test("raises engines.mate, preserves other keys, and leaves an equal floor untouched", async () => {
    const configPath = path.join(root, ".mate", "config", "framework.yaml");
    expect(await companionUpdateDeps.writeEngineFloor(root, ">=0.17.0")).toBe(true);
    const raised = parse(await fs.readFile(configPath, "utf8"));
    expect(raised).toEqual({
      type: "companion",
      allowedAgents: ["claude"],
      engines: { mate: ">=0.17.0" },
    });

    const stat = await fs.stat(configPath);
    expect(await companionUpdateDeps.writeEngineFloor(root, ">=0.17.0")).toBe(false);
    expect((await fs.stat(configPath)).mtimeMs).toBe(stat.mtimeMs);
  });

  test("replaces an older floor", async () => {
    const configPath = path.join(root, ".mate", "config", "framework.yaml");
    await fs.writeFile(
      configPath,
      'type: companion\nengines:\n  mate: ">=0.15.0"\n  acme: ">=1.0.0"\n',
    );
    await companionUpdateDeps.writeEngineFloor(root, ">=0.17.0");
    expect(parse(await fs.readFile(configPath, "utf8")).engines).toEqual({
      mate: ">=0.17.0",
      acme: ">=1.0.0",
    });
  });
});
