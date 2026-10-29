import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stringify } from "yaml";

import { addWorktree, initRepo } from "../../../test/git-checkouts";
import { createTempDir } from "../../../../../test/fixtures";
import { readProjectionFile } from "../../runtime/projection";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import { resolveForCapability, resolveForLaunch } from "./framework-context";
import { GlobalConfigStore } from "./global-config-store";
import { companionRegistryPath, findRepoLocalLinkedRepository } from "./repository-link";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Clone {
  root: string;
  companionPath: string;
  main: string;
  store: GlobalConfigStore;
  registry: string;
}

/** A companion listing a clone at its main worktree, which carries its own link. */
async function linkedClone(): Promise<Clone> {
  const root = await createTempDir("mate-adoption-");
  roots.push(root);
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    stringify({ type: "companion", allowedAgents: ["claude", "opencode"] }),
  );
  const main = initRepo(path.join(root, "acme"));
  const registry = stringify({
    repos: [{ id: "acme", path: main, gitCommonDir: path.join(main, ".git") }],
  });
  await fs.writeFile(companionRegistryPath(companionPath), registry);
  const local = repoLocalRegistryPath(main);
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(
    local,
    stringify({
      repository: { id: "acme", path: main },
      companions: [{ path: companionPath, repositoryId: "acme" }],
    }),
  );
  const store = new GlobalConfigStore(path.join(root, "config.yaml"));
  await store.register(companionPath);
  return { root, companionPath, main, store, registry };
}

const LAYOUTS = {
  sibling: async (clone: Clone) => addWorktree(clone.main, path.join(clone.root, "acme-fix")),
  nested: async (clone: Clone) =>
    addWorktree(clone.main, path.join(clone.main, ".claude", "worktrees", "fix")),
  "copied .mate/": async (clone: Clone) => {
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
});
