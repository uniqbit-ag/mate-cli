import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse, stringify } from "yaml";

import { addWorktree, git, initBareRepo, initRepo } from "../../../test/git-checkouts";
import { createTempDir } from "../../../../../test/fixtures";
import { readCompanionRegistrySync } from "../../runtime/companion-registry-read";
import { readProjectionFile } from "../../runtime/projection";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import { CompanionRegistryStore } from "./companion-registry-store";
import { entryAtCheckout } from "./registry-checkouts";
import { normalizeLinkedRepository } from "./repo-local-store";
import { GlobalConfigStore } from "./global-config-store";
import {
  backfillCompanionRegistration,
  CompanionResolver,
  companionRegistryPath,
  companionRootedStore,
  findRepoLocalLinkedRepository,
  findRepoLocalRegistryFile,
  readCompanionRegistry,
  registeredCheckoutOf,
} from "./repository-link";
import type { LinkedRepository } from "./types";
import { projectWorkingRepository } from "./working-repo-projection";

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

// ---------------------------------------------------------------------------
// The companion registry keeps one entry per clone
// ---------------------------------------------------------------------------

async function companion(root: string): Promise<string> {
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  return companionPath;
}

async function writeRegistry(companionPath: string, repos: LinkedRepository[]): Promise<void> {
  await fs.writeFile(companionRegistryPath(companionPath), stringify({ repos }));
}

async function readRegistry(companionPath: string): Promise<LinkedRepository[]> {
  const parsed = parse(await fs.readFile(companionRegistryPath(companionPath), "utf8")) as {
    repos: LinkedRepository[];
  };
  return parsed.repos;
}

/** An unrelated folder to register, so a write runs without touching the clone. */
async function unrelated(root: string): Promise<LinkedRepository> {
  const other = path.join(root, "other");
  await fs.mkdir(other, { recursive: true });
  return { id: "other", path: other };
}

describe("gitCommonDir in the companion registry", () => {
  test("the update read keeps it and a save writes it back", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    await writeRegistry(companionPath, [{ id: "acme", path: "/acme", gitCommonDir: "/acme/.git" }]);
    const store = new CompanionRegistryStore(companionRegistryPath(companionPath));

    const loaded = await store.load();
    expect(loaded.repos).toEqual([{ id: "acme", path: "/acme", gitCommonDir: "/acme/.git" }]);
    await store.save(loaded);
    expect(await readRegistry(companionPath)).toEqual([
      { id: "acme", path: "/acme", gitCommonDir: "/acme/.git" },
    ]);
  });

  test("the pure reads keep it and the repo-local shape drops it", async () => {
    const companionPath = await companion(await tempRoot());
    await writeRegistry(companionPath, [{ id: "acme", path: "/acme", gitCommonDir: "/acme/.git" }]);

    expect((await readCompanionRegistry(companionPath)).repos).toEqual([
      { id: "acme", path: "/acme", gitCommonDir: "/acme/.git" },
    ]);
    expect(readCompanionRegistrySync(companionPath)).toEqual([
      { id: "acme", path: "/acme", gitCommonDir: "/acme/.git" },
    ]);
    expect(
      normalizeLinkedRepository({ id: "acme", path: "/acme", gitCommonDir: "/acme/.git" }),
    ).toEqual({ id: "acme", path: "/acme" });
  });
});

describe("registerRepository with Checkouts", () => {
  test("records the shared Git folder of a linked Checkout, and none for a plain folder", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const plain = await unrelated(root);

    await companionRootedStore(companionPath).registerRepository({ id: "acme", path: main });
    await companionRootedStore(companionPath).registerRepository(plain);

    expect(await readRegistry(companionPath)).toEqual([
      { id: "acme", path: main, gitCommonDir: path.join(main, ".git") },
      plain,
    ]);
  });

  test("fills the field on an entry an older version wrote", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    await writeRegistry(companionPath, [{ id: "acme", path: main }]);

    await companionRootedStore(companionPath).registerRepository(await unrelated(root));

    expect((await readRegistry(companionPath))[0]).toEqual({
      id: "acme",
      path: main,
      gitCommonDir: path.join(main, ".git"),
    });
  });

  test("hands a removed worktree's entry over to the main worktree", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [
      { id: "acme", path: worktree, gitCommonDir: path.join(main, ".git") },
    ]);
    await fs.rm(worktree, { recursive: true, force: true });

    await companionRootedStore(companionPath).registerRepository(await unrelated(root));

    expect((await readRegistry(companionPath))[0]).toEqual({
      id: "acme",
      path: main,
      gitCommonDir: path.join(main, ".git"),
    });
  });

  test("hands a bare repository's entry to the first live worktree by record name, never a locked one that is away", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const bare = initBareRepo(root);
    const away = addWorktree(bare, path.join(root, "acme-a"));
    const removed = addWorktree(bare, path.join(root, "acme-b"));
    const live = addWorktree(bare, path.join(root, "acme-c"));
    addWorktree(bare, path.join(root, "acme-d"));
    git(bare, "worktree", "lock", away);
    await fs.rm(away, { recursive: true, force: true });
    await fs.rm(removed, { recursive: true, force: true });
    await writeRegistry(companionPath, [{ id: "acme", path: removed, gitCommonDir: bare }]);

    await companionRootedStore(companionPath).registerRepository(await unrelated(root));

    expect((await readRegistry(companionPath))[0]).toEqual({
      id: "acme",
      path: live,
      gitCommonDir: bare,
    });
  });

  test("drops an entry whose clone has no live Checkout, or that records no shared Git folder", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    await fs.rm(main, { recursive: true, force: true });
    await writeRegistry(companionPath, [
      { id: "acme", path: main, gitCommonDir: path.join(main, ".git") },
      { id: "old", path: path.join(root, "old") },
    ]);
    const other = await unrelated(root);

    await companionRootedStore(companionPath).registerRepository(other);

    expect(await readRegistry(companionPath)).toEqual([other]);
  });

  test("merges a hand-linked worktree into the main worktree's entry", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [
      { id: "acme-fix", path: worktree },
      { id: "acme", path: main },
    ]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let notice = "";

    try {
      await companionRootedStore(companionPath).registerRepository(await unrelated(root));
      notice = errors.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      errors.mockRestore();
    }

    expect((await readRegistry(companionPath)).map((entry) => entry.id)).toEqual(["acme", "other"]);
    expect(notice).toContain("acme-fix");
    expect(notice).toContain(path.join(companionPath, ".graphify", "acme-fix"));
  });

  test("points a merged-away worktree's link and projection at the kept ID", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [
      { id: "acme", path: main },
      { id: "acme-fix", path: worktree },
    ]);
    await writeRepoLocalLink(worktree, { id: "acme-fix", path: worktree }, companionPath);
    await projectWorkingRepository(companionPath, { id: "acme-fix", path: worktree });
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      await companionRootedStore(companionPath).registerRepository(await unrelated(root));
    } finally {
      errors.mockRestore();
    }

    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "acme", path: worktree });
    expect(readProjectionFile(worktree)?.projection.repositoryId).toBe("acme");
  });

  test("still merges when the merged-away worktree cannot be written, and warns", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [
      { id: "acme", path: main },
      { id: "acme-fix", path: worktree },
    ]);
    await fs.chmod(worktree, 0o555);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let output = "";

    try {
      await companionRootedStore(companionPath).registerRepository(await unrelated(root));
      output = errors.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      errors.mockRestore();
      await fs.chmod(worktree, 0o755);
    }

    expect((await readRegistry(companionPath)).map((entry) => entry.id)).toEqual(["acme", "other"]);
    expect(output).toContain(`warning: failed to point ${worktree} at acme`);
  });

  test("keeps the first listed entry of a bare repository's worktrees", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const bare = initBareRepo(root);
    const first = addWorktree(bare, path.join(root, "acme-b"));
    const second = addWorktree(bare, path.join(root, "acme-a"));
    await writeRegistry(companionPath, [
      { id: "acme-b", path: first },
      { id: "acme-a", path: second },
    ]);
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      await companionRootedStore(companionPath).registerRepository(await unrelated(root));
    } finally {
      errors.mockRestore();
    }

    expect((await readRegistry(companionPath)).map((entry) => entry.id)).toEqual([
      "acme-b",
      "other",
    ]);
  });

  test("never merges separate clones", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const origin = initRepo(path.join(root, "origin"));
    git(root, "clone", "-q", origin, path.join(root, "acme-1"));
    git(root, "clone", "-q", origin, path.join(root, "acme-2"));
    await writeRegistry(companionPath, [
      { id: "acme-1", path: path.join(root, "acme-1") },
      { id: "acme-2", path: path.join(root, "acme-2") },
    ]);

    await companionRootedStore(companionPath).registerRepository(await unrelated(root));

    expect((await readRegistry(companionPath)).map((entry) => entry.id)).toEqual([
      "acme-1",
      "acme-2",
      "other",
    ]);
  });

  test("linking another Checkout of a listed clone reuses its entry", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [{ id: "acme", path: main }]);

    const kept = await companionRootedStore(companionPath).registerRepository({
      id: "acme-fix",
      path: worktree,
    });

    expect(kept).toEqual({ id: "acme", path: main, gitCommonDir: path.join(main, ".git") });
    expect(await readRegistry(companionPath)).toEqual([kept]);
    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "acme", path: worktree });
  });

  test("returns the entry it kept for a new link", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));

    expect(
      await companionRootedStore(companionPath).registerRepository({ id: "acme", path: main }),
    ).toEqual({ id: "acme", path: main, gitCommonDir: path.join(main, ".git") });
  });
});

describe("registeredCheckoutOf", () => {
  test("is the entry's folder while it exists, else its handover target, else none", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    const entry = { id: "acme", path: worktree, gitCommonDir: path.join(main, ".git") };

    expect(registeredCheckoutOf(entry)).toBe(worktree);
    await fs.rm(worktree, { recursive: true, force: true });
    expect(registeredCheckoutOf(entry)).toBe(main);
    expect(registeredCheckoutOf({ id: "acme", path: worktree })).toBeNull();
  });
});

describe("backfillCompanionRegistration with Checkouts", () => {
  test("a launch from a worktree leaves the entry in place", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(companionPath, [
      { id: "acme", path: main, gitCommonDir: path.join(main, ".git") },
    ]);
    const before = await fs.stat(companionRegistryPath(companionPath));

    await backfillCompanionRegistration(companionPath, { id: "acme", path: worktree });

    expect(await readRegistry(companionPath)).toEqual([
      { id: "acme", path: main, gitCommonDir: path.join(main, ".git") },
    ]);
    expect((await fs.stat(companionRegistryPath(companionPath))).mtimeMs).toBe(before.mtimeMs);
  });

  test("the first launch after the upgrade fills the shared Git folder once", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    await writeRegistry(companionPath, [{ id: "acme", path: main }]);

    await backfillCompanionRegistration(companionPath, { id: "acme", path: main });
    const filled = await fs.stat(companionRegistryPath(companionPath));
    await backfillCompanionRegistration(companionPath, { id: "acme", path: main });

    expect(await readRegistry(companionPath)).toEqual([
      { id: "acme", path: main, gitCommonDir: path.join(main, ".git") },
    ]);
    expect((await fs.stat(companionRegistryPath(companionPath))).mtimeMs).toBe(filled.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// The companion scan matches by clone
// ---------------------------------------------------------------------------

async function resolverFor(root: string, companions: string[]): Promise<CompanionResolver> {
  const store = new GlobalConfigStore(path.join(root, "config.yaml"));
  for (const companionPath of companions) {
    // oxlint-disable-next-line no-await-in-loop -- registration order is the catalogue order
    await store.register(companionPath);
  }
  return new CompanionResolver(store);
}

async function readRepoLocal(repoRoot: string): Promise<unknown> {
  return parse(await fs.readFile(repoLocalRegistryPath(repoRoot), "utf8"));
}

describe("CompanionResolver by clone", () => {
  for (const recorded of [true, false]) {
    test(`a worktree matches its clone's entry ${recorded ? "with" : "without"} a recorded shared Git folder`, async () => {
      const root = await tempRoot();
      const companionPath = await companion(root);
      const main = initRepo(path.join(root, "acme"));
      const worktree = addWorktree(main, path.join(root, "acme-fix"));
      await writeRegistry(companionPath, [
        { id: "acme", path: main, ...(recorded ? { gitCommonDir: path.join(main, ".git") } : {}) },
      ]);
      await fs.mkdir(path.join(worktree, "src"));
      const resolver = await resolverFor(root, [companionPath]);

      const result = await resolver.resolveWithDiagnostics(path.join(worktree, "src"));

      expect(result.match).toEqual({ companionPath, repositoryId: "acme" });
      expect(await readRepoLocal(worktree)).toEqual({
        repository: { id: "acme", path: worktree },
        companions: [{ path: companionPath, repositoryId: "acme" }],
      });
      expect(await readRegistry(companionPath)).toEqual([
        { id: "acme", path: main, ...(recorded ? { gitCommonDir: path.join(main, ".git") } : {}) },
      ]);
      expect(
        await fs.access(path.join(worktree, "src", ".mate")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });
  }

  test("a nested worktree matches by clone instead of reading the main worktree's cache", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    await writeRepoLocalLink(main, { id: "acme", path: main }, companionPath);
    const nested = addWorktree(main, path.join(main, ".claude", "worktrees", "fix"));
    await writeRegistry(companionPath, [{ id: "acme", path: main }]);
    const resolver = await resolverFor(root, [companionPath]);

    expect((await resolver.resolveWithDiagnostics(nested)).match?.repositoryId).toBe("acme");
    expect(await findRepoLocalLinkedRepository(nested)).toEqual({ id: "acme", path: nested });
  });

  test("a copied cache naming the main worktree is replaced by the worktree's own", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRepoLocalLink(worktree, { id: "acme", path: main }, companionPath);
    await writeRegistry(companionPath, [{ id: "acme", path: main }]);
    const resolver = await resolverFor(root, [companionPath]);

    expect((await resolver.resolveWithDiagnostics(worktree)).match?.repositoryId).toBe("acme");
    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "acme", path: worktree });
  });

  test("two companions listing the clone stay ambiguous and nothing is written", async () => {
    const root = await tempRoot();
    const first = await companion(path.join(root, "one"));
    const second = await companion(path.join(root, "two"));
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    await writeRegistry(first, [{ id: "acme", path: main }]);
    await writeRegistry(second, [{ id: "acme", path: main }]);
    const resolver = await resolverFor(root, [first, second]);

    const result = await resolver.resolveWithDiagnostics(worktree);

    expect(result.ambiguousMatches.map((match) => match.companionPath)).toEqual([first, second]);
    await expect(fs.access(repoLocalRegistryPath(worktree))).rejects.toThrow();
  });

  test("a separate clone does not match", async () => {
    const root = await tempRoot();
    const companionPath = await companion(root);
    const origin = initRepo(path.join(root, "origin"));
    git(root, "clone", "-q", origin, path.join(root, "acme-1"));
    git(root, "clone", "-q", origin, path.join(root, "acme-2"));
    await writeRegistry(companionPath, [{ id: "acme", path: path.join(root, "acme-1") }]);
    const resolver = await resolverFor(root, [companionPath]);

    expect((await resolver.resolveWithDiagnostics(path.join(root, "acme-2"))).match).toBeNull();
  });
});

describe("entryAtCheckout", () => {
  test("names the root of the other Checkout of the clone holding the folder", async () => {
    const root = await tempRoot();
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    const nested = path.join(worktree, "src");
    await fs.mkdir(nested);
    const entry = { id: "acme", path: main };

    expect(entryAtCheckout(entry, nested)).toEqual({ id: "acme", path: worktree });
    expect(entryAtCheckout(entry, main)).toBe(entry);
    expect(entryAtCheckout(entry, initRepo(path.join(root, "other")))).toBe(entry);
  });
});
