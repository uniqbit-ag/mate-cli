import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, git, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { findRepoLocalRegistryFileSync, repoLocalRegistryPath } from "./repo-local";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTempDir("mate-repo-local-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeRegistry(repoRoot: string): Promise<string> {
  const registry = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registry), { recursive: true });
  await fs.writeFile(registry, "companions: []\n");
  return registry;
}

describe("findRepoLocalRegistryFileSync", () => {
  test("a nested worktree does not reach the main worktree's registry", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    await writeRegistry(main);
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    await fs.mkdir(path.join(nested, "src"));

    expect(findRepoLocalRegistryFileSync(path.join(nested, "src"))).toBeNull();
    expect(findRepoLocalRegistryFileSync(nested)).toBeNull();
  });

  test("a nested worktree finds its own registry", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    await writeRegistry(main);
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    const registryPath = await writeRegistry(nested);
    await fs.mkdir(path.join(nested, "src"));

    expect(findRepoLocalRegistryFileSync(path.join(nested, "src"))).toEqual({
      repoRoot: nested,
      registryPath,
    });
  });

  test("a submodule still finds the outer repository's registry", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");
    const registryPath = await writeRegistry(superproject);

    expect(findRepoLocalRegistryFileSync(path.join(superproject, "lib"))).toEqual({
      repoRoot: superproject,
      registryPath,
    });
  });
});
