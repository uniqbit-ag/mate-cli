import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree } from "../../test/git-checkouts";
import { projectedClone } from "../../test/projected-clone";
import { readContext, readStalenessLines } from "./companion-policy";
import { resolveOpenCodeGuidance } from "./projected-guidance";

/** Plain `opencode` in an untouched worktree stays out of scope (share-repository-link-across-worktrees, design Decision 9). */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenCode ignores a borrowed projection", () => {
  test("the policy context, the staleness lines and the guidance resolve nothing in the borrowing worktree", () => {
    const clone = projectedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));

    expect(readContext(clone.env, worktree).companionPath).toBeFalsy();
    expect(readStalenessLines(clone.env, worktree)).toEqual([]);
    expect(resolveOpenCodeGuidance(clone.env, worktree).guidance).toBeNull();
  });

  test("the lender itself still resolves", () => {
    const clone = projectedClone(roots);
    addWorktree(clone.main, path.join(clone.root, "acme-fix"));

    expect(readContext(clone.env, clone.main).companionPath).toBe(clone.companionPath);
    expect(resolveOpenCodeGuidance(clone.env, clone.main).guidance).not.toBeNull();
  });
});
