import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, git, initBareRepo, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import {
  checkoutRootOf,
  cloneAt,
  cloneOf,
  gitExcludePath,
  isDirectory,
  otherCheckouts,
  readGitLayout,
  sameClone,
} from "./git-layout";

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

describe("checkoutRootOf", () => {
  test("a subfolder of a main worktree names the main worktree", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const deep = path.join(main, "src", "deep");
    await fs.mkdir(deep, { recursive: true });

    expect(checkoutRootOf(deep)).toEqual({ root: main, layout: readGitLayout(main)! });
  });

  test("a sibling worktree is its own root", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));
    await fs.mkdir(path.join(sibling, "src"));

    expect(checkoutRootOf(path.join(sibling, "src"))?.root).toBe(sibling);
    expect(checkoutRootOf(sibling)?.layout.kind).toBe("linked");
  });

  test("a nested worktree is its own root, not the main worktree", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    await fs.mkdir(path.join(nested, "lib"));

    expect(checkoutRootOf(path.join(nested, "lib"))?.root).toBe(nested);
  });

  test("a bare repository's worktree is its own root", async () => {
    const root = await tempRoot();
    const bare = initBareRepo(root);
    const worktree = addWorktree(bare, path.join(root, "acme-a"));

    expect(checkoutRootOf(worktree)?.root).toBe(worktree);
    expect(checkoutRootOf(worktree)?.layout.commonDir).toBe(bare);
  });

  test("a submodule is its own root with its own layout", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");

    expect(checkoutRootOf(path.join(superproject, "lib"))?.layout.kind).toBe("own");
    expect(checkoutRootOf(path.join(superproject, "lib"))?.root).toBe(
      path.join(superproject, "lib"),
    );
  });

  test("a folder outside Git has no root", async () => {
    expect(checkoutRootOf(await tempRoot())).toBeNull();
  });
});

describe("cloneOf", () => {
  test("lists the main worktree and each live linked worktree by record name", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const second = addWorktree(main, path.join(path.dirname(main), "acme-b"));
    const first = addWorktree(main, path.join(path.dirname(main), "acme-a"));

    const clone = cloneOf(second);
    expect(clone).toEqual({
      commonDir: path.join(main, ".git"),
      bare: false,
      mainWorktree: main,
      linkedWorktrees: [
        { recordName: "acme-a", path: first, live: true },
        { recordName: "acme-b", path: second, live: true },
      ],
    });
    expect(cloneOf(main)).toEqual(clone);
  });

  test("a bare repository has no main worktree", async () => {
    const root = await tempRoot();
    const bare = initBareRepo(root);
    const worktree = addWorktree(bare, path.join(root, "acme-a"));

    expect(cloneOf(worktree)).toEqual({
      commonDir: bare,
      bare: true,
      mainWorktree: null,
      linkedWorktrees: [{ recordName: "acme-a", path: worktree, live: true }],
    });
  });

  test("a locked worktree whose folder is away is listed as not live", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const away = addWorktree(main, path.join(path.dirname(main), "acme-away"));
    git(main, "worktree", "lock", away);
    await fs.rm(away, { recursive: true, force: true });

    expect(cloneOf(main)?.linkedWorktrees).toEqual([
      { recordName: "acme-away", path: away, live: false },
    ]);
  });

  test("a removed or redirected worktree is not listed", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const gone = addWorktree(main, path.join(path.dirname(main), "acme-gone"));
    const moved = addWorktree(main, path.join(path.dirname(main), "acme-moved"));
    await fs.rm(gone, { recursive: true, force: true });
    await fs.writeFile(
      path.join(main, ".git", "worktrees", "acme-moved", "gitdir"),
      `${path.join(path.dirname(main), "elsewhere", ".git")}\n`,
    );

    expect(cloneOf(main)?.linkedWorktrees).toEqual([]);
    expect(moved).toBeTruthy();
  });

  test("the shared Git folder alone names the clone", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));

    expect(cloneAt(path.join(main, ".git"))?.linkedWorktrees.map((entry) => entry.path)).toEqual([
      sibling,
    ]);
  });

  test("a submodule or a folder outside Git has no clone", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");

    expect(cloneOf(path.join(superproject, "lib"))).toBeNull();
    expect(cloneOf(path.join(root, "nothing"))).toBeNull();
  });
});

describe("sameClone", () => {
  test("a main worktree and its live worktrees, in any order", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const sibling = addWorktree(main, path.join(path.dirname(main), "acme-feature"));
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));

    expect(sameClone(main, sibling)).toBe(true);
    expect(sameClone(sibling, nested)).toBe(true);
    expect(sameClone(nested, main)).toBe(true);
  });

  test("separate clones of one remote are not the same clone", async () => {
    const root = await tempRoot();
    const origin = initRepo(path.join(root, "origin"));
    git(root, "clone", "-q", origin, path.join(root, "acme-1"));
    git(root, "clone", "-q", origin, path.join(root, "acme-2"));

    expect(sameClone(path.join(root, "acme-1"), path.join(root, "acme-2"))).toBe(false);
  });

  test("a submodule is not the outer Checkout's clone", async () => {
    const root = await tempRoot();
    const library = initRepo(path.join(root, "acme-lib"));
    const superproject = initRepo(path.join(root, "acme"));
    git(superproject, "submodule", "add", "-q", library, "lib");

    expect(sameClone(superproject, path.join(superproject, "lib"))).toBe(false);
  });

  test("a worktree whose record points elsewhere is not a Checkout of the clone", async () => {
    const main = initRepo(path.join(await tempRoot(), "acme"));
    const moved = addWorktree(main, path.join(path.dirname(main), "acme-moved"));
    await fs.writeFile(
      path.join(main, ".git", "worktrees", "acme-moved", "gitdir"),
      `${path.join(path.dirname(main), "elsewhere", ".git")}\n`,
    );

    expect(sameClone(main, moved)).toBe(false);
  });
});

describe("a path that runs through a file", () => {
  test("reads as no Git layout and no Checkout", async () => {
    const root = await tempRoot();
    const blocker = path.join(root, "not-a-directory");
    await fs.writeFile(blocker, "");
    const inside = path.join(blocker, "repo");

    expect(readGitLayout(inside)).toBeNull();
    expect(checkoutRootOf(inside)).toBeNull();
    expect(isDirectory(inside)).toBe(false);
  });
});
