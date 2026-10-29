import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stringify } from "yaml";

import { addWorktree, git, initRepo } from "../../../test/git-checkouts";
import { createTempDir } from "../../../../../test/fixtures";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import { findRepoLocalLinkedRepository, findRepoLocalRegistryFile } from "./repository-link";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTempDir("mate-checkouts-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeRepoLocalLink(
  repoRoot: string,
  repository: { id: string; path: string },
  companionPath = "/companion",
): Promise<string> {
  const registry = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registry), { recursive: true });
  await fs.writeFile(
    registry,
    stringify({ repository, companions: [{ path: companionPath, repositoryId: repository.id }] }),
  );
  return registry;
}

describe("findRepoLocalRegistryFile in Checkouts", () => {
  test("a nested worktree does not reach the main worktree's registry", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    await writeRepoLocalLink(main, { id: "acme", path: main });
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    await fs.mkdir(path.join(nested, "src"));

    expect(await findRepoLocalRegistryFile(path.join(nested, "src"))).toBeNull();
  });

  test("a nested worktree finds its own registry", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    await writeRepoLocalLink(main, { id: "acme", path: main });
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    const registryPath = await writeRepoLocalLink(nested, { id: "acme", path: nested });

    expect(await findRepoLocalRegistryFile(nested)).toEqual({ repoRoot: nested, registryPath });
  });

  test("a submodule still finds the outer repository's registry", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");
    const registryPath = await writeRepoLocalLink(superproject, { id: "acme", path: superproject });

    expect(await findRepoLocalRegistryFile(path.join(superproject, "lib"))).toEqual({
      repoRoot: superproject,
      registryPath,
    });
  });
});

describe("findRepoLocalLinkedRepository in Checkouts", () => {
  test("a link copied from another live Checkout of the clone counts as absent", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-fix"));
    await writeRepoLocalLink(sibling, { id: "acme", path: main });

    expect(await findRepoLocalLinkedRepository(sibling)).toBeNull();
  });

  test("a link naming a missing folder is returned as before", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-fix"));
    const gone = path.join(path.dirname(main), "acme-gone");
    await writeRepoLocalLink(sibling, { id: "acme", path: gone });

    expect(await findRepoLocalLinkedRepository(sibling)).toEqual({ id: "acme", path: gone });
  });

  test("a worktree's own link is returned", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-fix"));
    await writeRepoLocalLink(sibling, { id: "acme", path: sibling });

    expect(await findRepoLocalLinkedRepository(path.join(sibling))).toEqual({
      id: "acme",
      path: sibling,
    });
  });
});
