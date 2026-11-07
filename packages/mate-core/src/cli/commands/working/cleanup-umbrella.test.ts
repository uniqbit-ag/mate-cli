import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir } from "../../../../../../test/fixtures";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repository-link";
import { cleanupWorkingRepository } from "../../../tools/setup/working-repo-cleanup";
import {
  resolveUmbrella,
  runWorkingCleanupCommand,
  type WorkingCleanupCommandDeps,
} from "./cleanup";

/** `mate working cleanup` in an Umbrella Repository and its mirrored worktree. */

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Fixture {
  companion: string;
  umbrella: string;
  children: string[];
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

async function child(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  git(dir, "remote", "add", "origin", `git@github.com:acme/${path.basename(dir)}.git`);
  git(
    dir,
    "-c",
    "user.name=acme",
    "-c",
    "user.email=acme@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  // Integration of the child's own that an umbrella cleanup must leave.
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude", "settings.local.json"), "{}\n");
  return dir;
}

async function umbrellaFixture(): Promise<Fixture> {
  const root = await createTempDir("mate-cleanup-umbrella-");
  roots.push(root);
  const companion = path.join(root, "companion");
  const umbrella = path.join(root, "acme");
  await fs.mkdir(companion, { recursive: true });
  const children = [
    await child(path.join(umbrella, "api")),
    await child(path.join(umbrella, "web")),
  ];
  await writeRepoLocalRegistryEntry(
    umbrella,
    companion,
    { id: "acme", path: umbrella },
    "existing",
  );
  return { companion, umbrella, children };
}

function depsFor(cwd: string, fixture: Fixture, cleanups: string[]): WorkingCleanupCommandDeps {
  return {
    cwd,
    resolveGitRoot: async () => null,
    resolveUmbrella,
    localRootKind: async () => "working",
    collectInventory: async () => ({
      schemaVersion: 1,
      companions: [],
      pairings: [
        {
          companionPath: fixture.companion,
          repository: { id: "acme", path: fixture.umbrella },
          health: "ready",
          ambiguous: false,
        },
      ],
    }),
    cleanup: async (repoPath, companions) => {
      cleanups.push(repoPath);
      return cleanupWorkingRepository(repoPath, companions);
    },
  };
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(
    () => true,
    () => false,
  );
}

async function run(deps: WorkingCleanupCommandDeps): Promise<string[]> {
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await runWorkingCleanupCommand([], deps);
  } finally {
    log.mockRestore();
    stderr.mockRestore();
  }
  return logs;
}

describe("runWorkingCleanupCommand in an Umbrella Repository", () => {
  test("cleans the umbrella and leaves its children alone", async () => {
    const fixture = await umbrellaFixture();
    const cleanups: string[] = [];
    const logs = await run(depsFor(fixture.umbrella, fixture, cleanups));

    expect(process.exitCode).toBe(0);
    expect(cleanups).toEqual([await fs.realpath(fixture.umbrella)]);
    expect(logs.join("\n")).toContain("cleaned working repository");
    expect(await exists(path.join(fixture.umbrella, ".mate"))).toBe(false);
    for (const dir of fixture.children) {
      expect(await exists(path.join(dir, ".git"))).toBe(true);
      expect(await exists(path.join(dir, ".claude", "settings.local.json"))).toBe(true);
    }
  });

  test("runs from a plain folder inside the umbrella", async () => {
    const fixture = await umbrellaFixture();
    const notes = path.join(fixture.umbrella, "notes");
    await fs.mkdir(notes);
    const cleanups: string[] = [];
    await run(depsFor(notes, fixture, cleanups));
    expect(cleanups).toEqual([await fs.realpath(fixture.umbrella)]);
  });

  test("cleans a mirrored worktree under the umbrella's pairing and keeps its child worktrees", async () => {
    const fixture = await umbrellaFixture();
    const mirrored = path.join(path.dirname(fixture.umbrella), "acme.worktrees", "acme-fix");
    await fs.mkdir(mirrored, { recursive: true });
    const worktrees = fixture.children.map((dir) => path.join(mirrored, path.basename(dir)));
    for (const [at, dir] of fixture.children.entries()) {
      git(dir, "worktree", "add", "-q", "-b", "workset/acme-fix", worktrees[at]!);
    }
    await writeRepoLocalRegistryEntry(
      mirrored,
      fixture.companion,
      { id: "acme", path: mirrored },
      "existing",
    );
    const cleanups: string[] = [];
    await run(depsFor(mirrored, fixture, cleanups));

    expect(process.exitCode).toBe(0);
    expect(cleanups).toEqual([await fs.realpath(mirrored)]);
    expect(await exists(path.join(mirrored, ".mate"))).toBe(false);
    expect(await exists(path.join(fixture.umbrella, ".mate"))).toBe(true);
    for (const dir of worktrees) expect(await exists(path.join(dir, ".git"))).toBe(true);
  });

  test("still refuses a plain folder outside any umbrella", async () => {
    const root = await createTempDir("mate-cleanup-plain-");
    roots.push(root);
    const cleanups: string[] = [];
    await run({
      ...depsFor(root, { companion: "/companion", umbrella: "/elsewhere", children: [] }, cleanups),
    });
    expect(process.exitCode).toBe(1);
    expect(cleanups).toEqual([]);
  });
});
