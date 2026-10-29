import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, git, initBareRepo, initRepo } from "../../../test/git-checkouts";
import { createTempDir } from "../../../../../test/fixtures";
import { fileExists } from "../fs-utils";
import { repoLocalDirPath } from "../../runtime/repo-local";
import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { GlobalConfigStore } from "./global-config-store";
import { unwrapWorkingRuntimeDocuments, project } from "./working-repo-projection";

/**
 * Mate in two Checkouts of one clone, which share one exclude file: whatever
 * one Checkout removes, the other's Mate files stay out of `git status`.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const MATE_PATHS = /^\?\? (\.mate|\.claude|\.opencode|\.agents|\.mcp\.json|openspec)\b/m;

function mateStatus(checkout: string): string {
  const status = git(checkout, "status", "--porcelain", "--untracked-files=all");
  return status
    .split("\n")
    .filter((line) => MATE_PATHS.test(line))
    .join("\n");
}

function carriesMate(checkout: string): Promise<boolean> {
  return fileExists(repoLocalDirPath(checkout));
}

async function expectMateHidden(checkouts: string[]): Promise<void> {
  for (const checkout of checkouts) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of Checkouts
    if (await carriesMate(checkout)) expect(mateStatus(checkout)).toBe("");
  }
}

async function wrap(checkout: string, companionPath: string, store: GlobalConfigStore) {
  const repository = { id: "acme", path: checkout };
  const config = { allowedAgents: ["claude", "opencode"], capabilities: [] };
  await project("link", { repoPath: checkout, companionPath, repository, source: "git" });
  await project("session", { repoPath: checkout, companionPath, repository });
  await project("wrap", {
    repoPath: checkout,
    companionPath,
    repository,
    config,
    globalConfigStore: store,
    runtimeDocuments: (await renderWorkingRuntimeDocuments(companionPath, config, checkout))
      .documents,
  });
}

interface Layout {
  name: string;
  /** Two Checkouts of one clone, and the exclude file Git reads for both. */
  make(root: string): { first: string; second: string; excludePath: string };
}

const layouts: Layout[] = [
  {
    name: "a main worktree and a sibling worktree",
    make: (root) => {
      const first = initRepo(path.join(root, "acme"));
      const second = addWorktree(first, path.join(root, "acme-feature"));
      return { first, second, excludePath: path.join(first, ".git", "info", "exclude") };
    },
  },
  {
    name: "two worktrees of a bare repository",
    make: (root) => {
      const bare = initBareRepo(root);
      const first = addWorktree(bare, path.join(root, "acme-a"));
      const second = addWorktree(bare, path.join(root, "acme-b"));
      return { first, second, excludePath: path.join(bare, "info", "exclude") };
    },
  },
];

async function setUp(make: Layout["make"]) {
  const root = await createTempDir("mate-worktree-excludes-");
  roots.push(root);
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".opencode", "commands"), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".opencode", "commands", "acme.md"), "acme\n");
  const store = new GlobalConfigStore(path.join(root, "global-config.yaml"));
  await store.register(companionPath);
  return { companionPath, store, ...make(root) };
}

describe.each(layouts)("Mate in $name", ({ make }) => {
  test("cleanup and unwrap in one Checkout keep the other's Mate files hidden", async () => {
    const { companionPath, store, first, second, excludePath } = await setUp(make);
    const before = await fs.readFile(excludePath, "utf8").catch(() => "");

    await wrap(first, companionPath, store);
    await wrap(second, companionPath, store);
    await expectMateHidden([first, second]);

    await cleanupWorkingRepository(first, [companionPath]);
    expect(await carriesMate(second)).toBe(true);
    await expectMateHidden([first, second]);

    await unwrapWorkingRuntimeDocuments(second, store);
    await expectMateHidden([first, second]);

    await cleanupWorkingRepository(second, [companionPath]);
    expect(await fs.readFile(excludePath, "utf8").catch(() => "")).toBe(before);
  });

  test("unwrapping an unwrapped Checkout still names the copy lines it kept", async () => {
    const { companionPath, store, first, second } = await setUp(make);
    await wrap(first, companionPath, store);
    await wrap(second, companionPath, store);
    await unwrapWorkingRuntimeDocuments(second, store);

    const again = await unwrapWorkingRuntimeDocuments(second, store);

    expect(again).toMatchObject({ kind: "absent", kept: { keptFor: [first] } });
  });
});
