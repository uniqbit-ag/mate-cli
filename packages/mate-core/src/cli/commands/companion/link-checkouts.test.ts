import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";

import { createTempDir } from "../../../../../../test/fixtures";
import { addWorktree, initBareRepo, initRepo } from "../../../../test/git-checkouts";
import {
  companionRegistryPath,
  findRepoLocalLinkedRepository,
  writeRepoLocalRegistryEntry,
} from "../../../lib/orchestrator/repository-link";
import type { LinkedRepository } from "../../../lib/orchestrator/types";
import { runCompanionLinkCommandWithDeps } from "./link";

/** `mate companion link` in the Checkouts of one clone (design Decision 14). */

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ root: string; companionPath: string }> {
  const root = await createTempDir("mate-link-checkouts-");
  roots.push(root);
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  return { root, companionPath };
}

/** Links `cwd` to `companionPath` through the real registry write; returns what it printed. */
async function link(
  cwd: string,
  companionPath: string,
  shadowScan?: () => Promise<string[]>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalIsTTY = process.stdin.isTTY;
  const originalLog = console.log;
  const originalError = console.error;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  process.chdir(cwd);
  try {
    await runCompanionLinkCommandWithDeps([], {
      selectCompanionLinkInputs: async () => ({ source: "local", localPath: companionPath }),
      resolveCompanion: async () => null,
      listCompanions: async () => [],
      inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
      installCompanion: async () => {},
      registerCompanion: async () => {},
      ...(shadowScan ? { findDescendantRepoLocalRegistries: shadowScan } : {}),
    });
  } finally {
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors };
}

async function registry(companionPath: string): Promise<LinkedRepository[]> {
  return (
    parse(await fs.readFile(companionRegistryPath(companionPath), "utf8")) as {
      repos: LinkedRepository[];
    }
  ).repos;
}

describe("mate companion link in a worktree", () => {
  test("the first link from a worktree names the entry after the main worktree's folder", async () => {
    const { root, companionPath } = await scratch();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));

    const { logs } = await link(worktree, companionPath);

    expect((await registry(companionPath)).map(({ id }) => id)).toEqual(["acme"]);
    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "acme", path: worktree });
    expect(logs.join("\n")).toContain("Successfully linked companion for acme");
  });

  test("a bare clone's worktree is named after the bare folder without .git", async () => {
    const { root, companionPath } = await scratch();
    const worktree = addWorktree(initBareRepo(root, "widget.git"), path.join(root, "widget-b"));

    await link(worktree, companionPath);

    expect((await registry(companionPath)).map(({ id }) => id)).toEqual(["widget"]);
  });

  test("a worktree of a linked clone attaches to its entry and names the kept ID", async () => {
    const { root, companionPath } = await scratch();
    const main = initRepo(path.join(root, "acme"));
    await fs.writeFile(
      companionRegistryPath(companionPath),
      stringify({ repos: [{ id: "app", path: main }] }),
    );
    const worktree = addWorktree(main, path.join(root, "acme-fix"));

    const { logs } = await link(worktree, companionPath);

    expect((await registry(companionPath)).map(({ id, path: at }) => ({ id, path: at }))).toEqual([
      { id: "app", path: main },
    ]);
    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "app", path: worktree });
    expect(logs.join("\n")).toContain("Successfully linked companion for app");
  });
});

describe("the shadow scan after a link", () => {
  test("skips a nested worktree adopted for the companion just linked, and keeps others", async () => {
    const { root, companionPath } = await scratch();
    const main = initRepo(path.join(root, "acme"));
    const adopted = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    await writeRepoLocalRegistryEntry(adopted, companionPath, { id: "acme", path: adopted }, "git");
    const other = path.join(root, "other-companion");
    await fs.mkdir(other);
    const foreign = addWorktree(main, path.join(main, ".claude", "worktrees", "other"));
    await writeRepoLocalRegistryEntry(foreign, other, { id: "acme", path: foreign }, "git");

    const { errors } = await link(main, companionPath);

    expect(errors.join("\n")).toContain(foreign);
    expect(errors.join("\n")).not.toContain(adopted);
  });
});
