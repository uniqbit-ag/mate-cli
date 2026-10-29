import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, git, initBareRepo, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { gitExcludePath, otherCheckouts, readGitLayout } from "./git-layout";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTempDir("mate-git-layout-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readGitLayout", () => {
  test("a main worktree shares its own Git folder", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));

    expect(readGitLayout(main)).toEqual({
      kind: "main",
      gitDir: path.join(main, ".git"),
      commonDir: path.join(main, ".git"),
    });
    expect(otherCheckouts(main)).toEqual([sibling]);
  });

  test("a sibling worktree names the main worktree's Git folder as shared", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));

    expect(readGitLayout(sibling)).toEqual({
      kind: "linked",
      gitDir: path.join(main, ".git", "worktrees", "acme-feature"),
      commonDir: path.join(main, ".git"),
    });
    expect(otherCheckouts(sibling)).toEqual([main]);
  });

  test("a worktree nested inside the main worktree is a Checkout of its own", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const nested = addWorktree(main, path.join(main, ".worktrees", "feature"));

    expect(readGitLayout(nested)?.kind).toBe("linked");
    expect(readGitLayout(nested)?.commonDir).toBe(path.join(main, ".git"));
    expect(otherCheckouts(nested)).toEqual([main]);
    expect(otherCheckouts(main)).toEqual([nested]);
  });

  test("worktrees of a bare repository have no main worktree", async () => {
    const root = await tempRoot();
    const bare = initBareRepo(root);
    const first = addWorktree(bare, path.join(root, "acme-a"));
    const second = addWorktree(bare, path.join(root, "acme-b"));

    expect(readGitLayout(first)).toEqual({
      kind: "linked",
      gitDir: path.join(bare, "worktrees", "acme-a"),
      commonDir: bare,
    });
    expect(otherCheckouts(first)).toEqual([second]);
  });

  test("a submodule keeps its own Git folder", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");
    const submodule = path.join(superproject, "lib");

    expect(readGitLayout(submodule)).toEqual({
      kind: "own",
      gitDir: path.join(superproject, ".git", "modules", "lib"),
      commonDir: path.join(superproject, ".git", "modules", "lib"),
    });
    expect(otherCheckouts(submodule)).toEqual([]);
  });

  test("a clone with a separate Git folder keeps that folder", async () => {
    const root = await tempRoot();
    const gitDir = path.join(root, "acme-git");
    const checkout = path.join(root, "acme");
    git(root, "init", "-q", `--separate-git-dir=${gitDir}`, checkout);

    expect(readGitLayout(checkout)).toEqual({ kind: "own", gitDir, commonDir: gitDir });
    expect(otherCheckouts(checkout)).toEqual([]);
  });

  test("a worktree whose folder was deleted is no other Checkout", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const gone = addWorktree(main, path.join(path.dirname(main), "acme-gone"));
    const kept = addWorktree(main, path.join(path.dirname(main), "acme-kept"));
    await fs.rm(gone, { recursive: true, force: true });

    expect(otherCheckouts(main)).toEqual([kept]);
  });

  test("a locked worktree whose folder is away stays another Checkout", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const away = addWorktree(main, path.join(path.dirname(main), "acme-away"));
    git(main, "worktree", "lock", away);
    await fs.rm(away, { recursive: true, force: true });

    expect(otherCheckouts(main)).toEqual([away]);
  });

  test("a worktree reached through a symlinked folder resolves its relative gitdir", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const nested = path.join(root, "nest", "deep");
    await fs.mkdir(nested, { recursive: true });
    const worktree = addWorktree(main, path.join(nested, "acme-feature"));
    await fs.writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.relative(worktree, path.join(main, ".git", "worktrees", "acme-feature"))}\n`,
    );
    const link = path.join(root, "acme-link");
    await fs.symlink(worktree, link);

    expect(readGitLayout(link)?.commonDir).toBe(path.join(main, ".git"));
    expect(otherCheckouts(link)).toEqual([main]);
  });

  test("only a plain [core] section decides bareness", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));
    const config = path.join(main, ".git", "config");
    const original = await fs.readFile(config, "utf8");

    await fs.writeFile(config, `${original}[core "acme"]\n\tbare = true\n`);
    expect(otherCheckouts(sibling)).toEqual([main]);

    await fs.writeFile(config, original.replace(/bare = false/, "bare = false # not bare"));
    expect(otherCheckouts(sibling)).toEqual([main]);

    for (const spelling of ["yes", "on", "1", "TRUE"]) {
      await fs.writeFile(config, original.replace(/bare = false/, `bare = ${spelling}`));
      expect(otherCheckouts(sibling)).toEqual([]);
    }
  });

  test("a folder outside Git has no layout", async () => {
    const root = await tempRoot();

    expect(readGitLayout(root)).toBeNull();
    expect(otherCheckouts(root)).toEqual([]);
  });
});

describe("gitExcludePath", () => {
  test("a main worktree uses its own Git folder", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));

    expect(gitExcludePath(main)).toBe(path.join(main, ".git", "info", "exclude"));
  });

  test("a linked worktree uses the shared Git folder, not its private one", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const worktree = addWorktree(main, path.join(path.dirname(main), "acme-feature"));

    expect(gitExcludePath(worktree)).toBe(path.join(main, ".git", "info", "exclude"));
  });

  test("a worktree of a bare repository uses the bare repository", async () => {
    const root = await tempRoot();
    const bare = initBareRepo(root);
    const worktree = addWorktree(bare, path.join(root, "acme-a"));

    expect(gitExcludePath(worktree)).toBe(path.join(bare, "info", "exclude"));
  });

  test("a submodule uses its own Git folder", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");

    expect(gitExcludePath(path.join(superproject, "lib"))).toBe(
      path.join(superproject, ".git", "modules", "lib", "info", "exclude"),
    );
  });

  test("a folder outside Git has no exclude file", async () => {
    expect(gitExcludePath(await tempRoot())).toBeNull();
  });
});
