import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { createTempDir } from "../../../../test/fixtures";
import { movedIntoLinkedWorktree } from "./entered-worktree";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await createTempDir("mate-entered-worktree-");
  roots.push(root);
  return root;
}

describe("movedIntoLinkedWorktree", () => {
  test("a session that entered a Workset worktree moved", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme.worktrees", "ws1"));
    await fs.mkdir(path.join(worktree, "src"));

    expect(movedIntoLinkedWorktree(worktree, main)).toBe(true);
    expect(movedIntoLinkedWorktree(path.join(worktree, "src"), main)).toBe(true);
  });

  test("a session that entered an umbrella child's worktree moved", async () => {
    const root = await tempRoot();
    const umbrella = path.join(root, "acme-umbrella");
    await fs.mkdir(umbrella);
    const child = initRepo(path.join(umbrella, "acme"));
    const worktree = addWorktree(child, path.join(root, "acme-umbrella.worktrees", "ws1", "acme"));

    expect(movedIntoLinkedWorktree(worktree, umbrella)).toBe(true);
  });

  test("a session started in the worktree did not move", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme.worktrees", "ws1"));
    await fs.mkdir(path.join(worktree, "src"));

    expect(movedIntoLinkedWorktree(worktree, worktree)).toBe(false);
    expect(movedIntoLinkedWorktree(worktree, path.join(worktree, "src"))).toBe(false);
  });

  test("a Claude-managed worktree is left to RTK", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));

    expect(movedIntoLinkedWorktree(worktree, main)).toBe(false);
  });

  test("the main checkout, a missing start folder and a non-Git folder are not moved", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme.worktrees", "ws1"));
    const plain = path.join(root, "plain");
    await fs.mkdir(plain);

    expect(movedIntoLinkedWorktree(main, worktree)).toBe(false);
    expect(movedIntoLinkedWorktree(worktree, undefined)).toBe(false);
    expect(movedIntoLinkedWorktree(worktree, "")).toBe(false);
    expect(movedIntoLinkedWorktree(worktree, path.join(root, "gone"))).toBe(false);
    expect(movedIntoLinkedWorktree(plain, main)).toBe(false);
  });
});
