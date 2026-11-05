import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initBareRepo, initRepo } from "../../test/git-checkouts";
import { servingClaudeWrapRoot } from "./serving-claude-wrap";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serving-wrap-")));
  roots.push(root);
  return root;
}

describe("servingClaudeWrapRoot", () => {
  test("a main worktree serves itself", () => {
    const main = initRepo(path.join(tempRoot(), "acme"));

    expect(servingClaudeWrapRoot(main, "darwin")).toBe(main);
  });

  test("the main worktree serves a sibling and a nested worktree on macOS and Linux", () => {
    const root = tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const sibling = addWorktree(main, path.join(root, "acme-fix"));
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));

    expect(servingClaudeWrapRoot(sibling, "darwin")).toBe(main);
    expect(servingClaudeWrapRoot(nested, "linux")).toBe(main);
  });

  test("a bare repository's worktree serves itself", () => {
    const root = tempRoot();
    const worktree = addWorktree(initBareRepo(root), path.join(root, "acme-b"));

    expect(servingClaudeWrapRoot(worktree, "darwin")).toBe(worktree);
  });

  test("on Windows every Checkout serves itself", () => {
    const root = tempRoot();
    const sibling = addWorktree(initRepo(path.join(root, "acme")), path.join(root, "acme-fix"));

    expect(servingClaudeWrapRoot(sibling, "win32")).toBe(sibling);
  });

  test("a folder outside Git serves itself", () => {
    const folder = tempRoot();

    expect(servingClaudeWrapRoot(folder, "darwin")).toBe(folder);
  });
});
