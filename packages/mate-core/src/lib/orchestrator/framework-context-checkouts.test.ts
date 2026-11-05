import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { addWorktree } from "../../../test/git-checkouts";
import { linkedClone as cloneIn, type LinkedClone } from "../../../test/linked-clone";
import { readProjectionFile } from "../../runtime/projection";
import { stringify } from "yaml";
import { resolveForCapability, resolveForLaunch } from "./framework-context";
import { companionRegistryPath, findRepoLocalLinkedRepository } from "./repository-link";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const linkedClone = () => cloneIn(roots);

const LAYOUTS = {
  sibling: async (clone: LinkedClone) => addWorktree(clone.main, path.join(clone.root, "acme-fix")),
  nested: async (clone: LinkedClone) =>
    addWorktree(clone.main, path.join(clone.main, ".claude", "worktrees", "fix")),
  "copied .mate/": async (clone: LinkedClone) => {
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-copy"));
    await fs.cp(path.join(clone.main, ".mate"), path.join(worktree, ".mate"), { recursive: true });
    return worktree;
  },
};

const RESOLVERS = { resolveForLaunch, resolveForCapability };

describe("Adoption in resolution", () => {
  for (const [layout, makeWorktree] of Object.entries(LAYOUTS)) {
    for (const [name, resolve] of Object.entries(RESOLVERS)) {
      test(`${name} adopts a ${layout} worktree`, async () => {
        const clone = await linkedClone();
        const worktree = await makeWorktree(clone);

        const context = await resolve(worktree, clone.store);

        expect(context.repository).toEqual({ id: "acme", path: worktree });
        expect(context.repositoryId).toBe("acme");
        expect(await findRepoLocalLinkedRepository(worktree)).toEqual({
          id: "acme",
          path: worktree,
        });
        const projection = readProjectionFile(worktree)?.projection;
        expect(projection?.repositoryPath).toBe(worktree);
        expect(projection?.repositoryId).toBe("acme");
        expect(projection?.graphifyOut).toContain(path.join(".graphify", "acme"));
        expect(await fs.readFile(companionRegistryPath(clone.companionPath), "utf8")).toBe(
          clone.registry,
        );
      });
    }
  }

  test("a worktree that can't be written warns, and resolution still answers", async () => {
    const clone = await linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-ro"));
    await fs.chmod(worktree, 0o555);
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => void errors.push(args.join(" ")),
    );

    try {
      const context = await resolveForCapability(worktree, clone.store);
      expect(context.repositoryId).toBe("acme");
      expect(context.companionPath).toBe(clone.companionPath);
    } finally {
      error.mockRestore();
      await fs.chmod(worktree, 0o755);
    }
    expect(errors.join("\n")).toContain(`failed to write the repository link in ${worktree}`);
  });
});

describe("a launch in a hand-linked worktree", () => {
  test("merges its entry and launches with the kept ID", async () => {
    const clone = await linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    await fs.writeFile(
      companionRegistryPath(clone.companionPath),
      stringify({
        repos: [
          { id: "acme", path: clone.main, gitCommonDir: path.join(clone.main, ".git") },
          { id: "acme-fix", path: worktree },
        ],
      }),
    );
    const local = path.join(worktree, ".mate", "config", "registry.yaml");
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(
      local,
      stringify({
        repository: { id: "acme-fix", path: worktree },
        companions: [{ path: clone.companionPath, repositoryId: "acme-fix" }],
      }),
    );
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const context = await resolveForLaunch(worktree, clone.store);
      expect(context.repositoryId).toBe("acme");
      expect(context.repository).toEqual({ id: "acme", path: worktree });
    } finally {
      error.mockRestore();
    }
    expect(readProjectionFile(worktree)?.projection.repositoryId).toBe("acme");
  });
});

describe("inside a Mate launch, the folder picks the Checkout", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const name of ["MATE_ARTIFACT_PATH", "MATE_REPO_PATH", "MATE_REPO_ID"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  function launchedFrom(clone: LinkedClone): void {
    process.env.MATE_ARTIFACT_PATH = clone.companionPath;
    process.env.MATE_REPO_PATH = clone.main;
    process.env.MATE_REPO_ID = "acme";
  }

  test("a folder in another Checkout of the clone is that Checkout, and nothing is written", async () => {
    const clone = await linkedClone();
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    await fs.mkdir(path.join(worktree, "src"));
    launchedFrom(clone);

    const context = await resolveForLaunch(path.join(worktree, "src"), clone.store);

    expect(context.repository).toEqual({ id: "acme", path: worktree });
    expect(context.repositoryId).toBe("acme");
    expect(context.companionPath).toBe(clone.companionPath);
    expect(await fs.exists(path.join(worktree, ".mate"))).toBe(false);
  });

  test("a folder outside the clone keeps MATE_REPO_PATH", async () => {
    const clone = await linkedClone();
    const outside = path.join(clone.root, "outside");
    await fs.mkdir(outside);
    launchedFrom(clone);

    const context = await resolveForCapability(outside, clone.store);

    expect(context.repository).toEqual({ id: "acme", path: clone.main });
  });
});
