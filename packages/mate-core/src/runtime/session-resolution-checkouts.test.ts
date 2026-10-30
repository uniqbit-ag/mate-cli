import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, initRepo } from "../../test/git-checkouts";
import { link, project, projectedClone, type ProjectedClone } from "../../test/projected-clone";
import { repoLocalDirPath } from "./repo-local";
import { resolveSession, type ResolvedSession } from "./session-resolution";

/**
 * Session Resolution across the Checkouts of one clone
 * (share-repository-link-across-worktrees, design Decisions 9, 11 and 17).
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const linkedClone = () => projectedClone(roots);

function expectProjection(session: ResolvedSession) {
  expect(session.kind).toBe("projection");
  if (session.kind !== "projection") throw new Error(`expected a projection, got ${session.kind}`);
  return session;
}

describe("a linked worktree borrows a projection", () => {
  test("a sibling worktree borrows the main worktree's", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    fs.mkdirSync(path.join(worktree, "src"));

    const session = expectProjection(resolveSession(clone.env, path.join(worktree, "src")));

    expect(session.checkoutRoot).toBe(worktree);
    expect(session.repositoryId).toBe("acme-app");
    expect(session.companionPath).toBe(clone.companionPath);
    expect(session.projection.repoRoot).toBe(clone.main);
    expect(session.projection.borrowedFrom).toBe(clone.main);
    expect(session.projection.repositoryPath).toBe(worktree);
  });

  test("a nested worktree borrows the main worktree's", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.main, ".claude", "worktrees", "fix"));

    const session = expectProjection(resolveSession(clone.env, worktree));

    expect(session.checkoutRoot).toBe(worktree);
    expect(session.projection.borrowedFrom).toBe(clone.main);
  });

  test("without a main worktree projection, the first linked worktree by record name lends", () => {
    const clone = linkedClone();
    fs.rmSync(repoLocalDirPath(clone.main), { recursive: true });
    const lender = addWorktree(clone.main, path.join(clone.root, "b-lender"));
    project(clone, lender);
    addWorktree(clone.main, path.join(clone.root, "c-lender"));
    project(clone, path.join(clone.root, "c-lender"));
    const borrower = addWorktree(clone.main, path.join(clone.root, "d-borrower"));

    const session = expectProjection(resolveSession(clone.env, borrower));

    expect(session.projection.borrowedFrom).toBe(lender);
    expect(session.checkoutRoot).toBe(borrower);
  });

  test("a projection copied from the main worktree is borrowed too", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-copy"));
    fs.cpSync(repoLocalDirPath(clone.main), repoLocalDirPath(worktree), { recursive: true });

    const session = expectProjection(resolveSession(clone.env, worktree));

    expect(session.projection.borrowedFrom).toBe(clone.main);
    expect(session.checkoutRoot).toBe(worktree);
  });

  test("a worktree's own projection wins, trusted through the clone's entry", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    project(clone, worktree);

    const session = expectProjection(resolveSession(clone.env, worktree));

    expect(session.projection.borrowedFrom).toBeUndefined();
    expect(session.projection.repoRoot).toBe(worktree);
    expect(session.checkoutRoot).toBe(worktree);
  });

  test("with no lender nothing resolves", () => {
    const clone = linkedClone();
    fs.rmSync(repoLocalDirPath(clone.main), { recursive: true });
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));

    expect(resolveSession(clone.env, worktree)).toEqual({ kind: "none" });
  });

  test("a borrowed projection whose ID the registry links at no Checkout of the clone is refused", () => {
    const clone = linkedClone();
    const elsewhere = initRepo(path.join(clone.root, "elsewhere"));
    link(clone, [{ id: "acme-app", path: elsewhere }]);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));

    const session = resolveSession(clone.env, worktree);

    expect(session.kind === "none" && session.refusal?.code).toBe("repository-not-linked");
  });

  test("a projection copied into a separate clone is refused", () => {
    const clone = linkedClone();
    const separate = initRepo(path.join(clone.root, "separate"));
    fs.cpSync(repoLocalDirPath(clone.main), repoLocalDirPath(separate), { recursive: true });

    const session = resolveSession(clone.env, separate);

    expect(session.kind === "none" && session.refusal?.code).toBe("repository-not-linked");
  });

  test("an entry whose folder is gone links the live Checkouts of the shared Git folder it records", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    project(clone, worktree);
    link(clone, [
      {
        id: "acme-app",
        path: path.join(clone.root, "gone"),
        gitCommonDir: path.join(clone.main, ".git"),
      },
    ]);

    expect(expectProjection(resolveSession(clone.env, worktree)).checkoutRoot).toBe(worktree);
  });
});

describe("inside a Mate launch, the folder picks the Checkout", () => {
  function launchEnv(clone: ProjectedClone) {
    return {
      ...clone.env,
      MATE_ARTIFACT_PATH: clone.companionPath,
      MATE_REPO_PATH: clone.main,
      MATE_REPO_ID: "acme-app",
      MATE_POLICY_JSON: '{"launch":true}',
    };
  }

  test("a folder in another Checkout of the clone serves that Checkout", () => {
    const clone = linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    fs.mkdirSync(path.join(worktree, "src"));

    const session = resolveSession(launchEnv(clone), path.join(worktree, "src"));

    expect(session.kind).toBe("launch");
    if (session.kind !== "launch") return;
    expect(session.checkoutRoot).toBe(worktree);
    expect(session.companionPath).toBe(clone.companionPath);
    expect(session.repositoryId).toBe("acme-app");
    expect(session.policyJson()).toBe('{"launch":true}');
    expect(fs.existsSync(repoLocalDirPath(worktree))).toBe(false);
  });

  test("a folder outside the clone keeps MATE_REPO_PATH", () => {
    const clone = linkedClone();
    const separate = initRepo(path.join(clone.root, "separate"));

    const session = resolveSession(launchEnv(clone), separate);

    expect(session.kind === "launch" && session.checkoutRoot).toBe(clone.main);
  });
});
