import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree } from "../../test/git-checkouts";
import { project, projectedClone } from "../../test/projected-clone";
import { resolveCompanionRuntime } from "./env";
import { projectionCheckout, resolveProjection, type ResolvedProjection } from "./projection";
import { repoLocalDirPath } from "./repo-local";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const linkedClone = () => projectedClone(roots);

function resolved(folder: string): ResolvedProjection {
  const projection = resolveProjection(folder);
  if (!projection) throw new Error(`expected a projection at ${folder}`);
  return projection;
}

describe("a linked worktree borrows a projection", () => {
  test("a sibling worktree borrows the main worktree's", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    fs.mkdirSync(path.join(worktree, "src"));

    const projection = resolved(path.join(worktree, "src"));

    expect(projection.repositoryId).toBe("acme-app");
    expect(projection.companionPath).toBe(clone.companionPath);
    expect(projection.repoRoot).toBe(clone.main);
    expect(projection.borrowedFrom).toBe(clone.main);
    expect(projectionCheckout(projection)).toBe(worktree);
  });

  test("a nested worktree borrows the main worktree's", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.main, ".claude", "worktrees", "fix"));

    const projection = resolved(worktree);

    expect(projection.borrowedFrom).toBe(clone.main);
    expect(projectionCheckout(projection)).toBe(worktree);
  });

  test("without a main worktree projection, the first linked worktree by record name lends", () => {
    const clone = linkedClone();
    fs.rmSync(repoLocalDirPath(clone.main), { recursive: true });
    const lender = addWorktree(clone.main, path.join(clone.root, "b-lender"));
    project(clone, lender);
    addWorktree(clone.main, path.join(clone.root, "c-lender"));
    project(clone, path.join(clone.root, "c-lender"));
    const borrower = addWorktree(clone.main, path.join(clone.root, "d-borrower"));

    const projection = resolved(borrower);

    expect(projection.borrowedFrom).toBe(lender);
    expect(projectionCheckout(projection)).toBe(borrower);
  });

  test("a projection copied from the main worktree is borrowed too", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-copy"));
    fs.cpSync(repoLocalDirPath(clone.main), repoLocalDirPath(worktree), { recursive: true });

    const projection = resolved(worktree);

    expect(projection.borrowedFrom).toBe(clone.main);
    expect(projectionCheckout(projection)).toBe(worktree);
  });

  test("a worktree's own projection wins", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    project(clone, worktree);

    const projection = resolved(worktree);

    expect(projection.borrowedFrom).toBeUndefined();
    expect(projectionCheckout(projection)).toBe(worktree);
  });

  test("with no lender nothing resolves", () => {
    const clone = linkedClone();
    fs.rmSync(repoLocalDirPath(clone.main), { recursive: true });
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));

    expect(resolveProjection(worktree)).toBeNull();
  });
});

test("a managed session in a borrowing worktree reports the worktree", () => {
  const clone = linkedClone();
  const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
  const env = {
    ...clone.env,
    MATE_ARTIFACT_PATH: clone.companionPath,
    MATE_REPO_PATH: clone.main,
    MATE_REPO_ID: "acme-app",
  };

  expect(resolveCompanionRuntime(env, worktree).context.repositoryPath).toBe(worktree);
});
