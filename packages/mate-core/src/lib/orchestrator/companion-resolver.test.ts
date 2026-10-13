import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse } from "yaml";

import { CompanionRegistryStore } from "./companion-registry-store";
import { CompanionResolver } from "./companion-resolver";
import { GlobalConfigStore } from "./global-config-store";
import { RepoLocalRegistryStore, repoLocalRegistryPath } from "./repo-local-registry";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CompanionResolver", () => {
  test("returns null when no companions are registered", async () => {
    const root = await makeTempDir("resolver-empty-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    expect(await new CompanionResolver(store).resolve(path.join(root, "project"))).toBeNull();
  });

  test("does not resolve from global companion registration alone", async () => {
    const root = await makeTempDir("resolver-global-alone-");
    const repoPath = path.join(root, "project");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    await store.register(companionPath);

    const result = await new CompanionResolver(store).resolve(repoPath);

    expect(result).toBeNull();
  });

  describe("repo-local registry fast path", () => {
    test("resolves from the repo-local pointer without scanning the global registry", async () => {
      const root = await makeTempDir("resolver-repo-local-fast-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [{ path: companionPath, repositoryId: "app" }],
      });

      // A GlobalConfigStore pointed at a nonexistent file behaves as "no
      // companions registered" — if resolution still succeeds, it proves the
      // repo-local pointer was used instead of a global scan.
      const store = new GlobalConfigStore(path.join(root, "does-not-exist.yaml"));

      const result = await new CompanionResolver(store).resolve(repoPath);

      expect(result).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
    });

    test("resolves from the repo-local pointer when cwd is a subdirectory", async () => {
      const root = await makeTempDir("resolver-repo-local-subdir-");
      const repoPath = path.join(root, "project");
      const subDir = path.join(repoPath, "src");
      await fs.mkdir(subDir, { recursive: true });

      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [{ path: companionPath, repositoryId: "app" }],
      });

      const store = new GlobalConfigStore(path.join(root, "does-not-exist.yaml"));

      const result = await new CompanionResolver(store).resolve(subDir);

      expect(result?.repositoryId).toBe("app");
    });

    test("returns null when there is no repo-local registry", async () => {
      const root = await makeTempDir("resolver-repo-local-missing-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));

      const result = await new CompanionResolver(store).resolve(repoPath);

      expect(result).toBeNull();
    });

    test("returns null when the repo-local registry is unparsable", async () => {
      const root = await makeTempDir("resolver-repo-local-corrupt-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
      await fs.writeFile(repoLocalRegistryPath(repoPath), "companions: [unterminated", "utf8");

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));

      const result = await new CompanionResolver(store).resolve(repoPath);

      expect(result).toBeNull();
    });

    test("drops a stale repo-local pointer when no companion links the repo anymore", async () => {
      const root = await makeTempDir("resolver-repo-local-stale-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const goneCompanionPath = path.join(root, "companion-gone");
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        repository: { id: "app", path: repoPath },
        companions: [{ path: goneCompanionPath, repositoryId: "app" }],
      });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const result = await new CompanionResolver(store).resolve(repoPath);

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();

      const rewritten = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
      expect(rewritten.companions).toEqual([]);
      expect(rewritten.repository).toEqual({ id: "app", path: repoPath });

      errorSpy.mockRestore();
    });

    test("reports ambiguousMatches when the repo-local registry lists two still-valid companions", async () => {
      const root = await makeTempDir("resolver-repo-local-ambiguous-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const companionA = await fs.mkdtemp(path.join(root, "companion-a-"));
      const companionB = await fs.mkdtemp(path.join(root, "companion-b-"));
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [
          { path: companionA, repositoryId: "from-a" },
          { path: companionB, repositoryId: "from-b" },
        ],
      });

      const store = new GlobalConfigStore(path.join(root, "does-not-exist.yaml"));

      const result = await new CompanionResolver(store).resolveWithDiagnostics(repoPath);

      expect(result.ambiguousMatches).toHaveLength(2);
      expect(result.ambiguousMatches.map((m) => m.companionPath).sort()).toEqual(
        [companionA, companionB].sort(),
      );
    });
  });

  describe("global registry fallback", () => {
    async function writeCompanionRegistry(
      companionPath: string,
      repos: Array<{ id: string; path: string }>,
    ): Promise<void> {
      await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
      await new CompanionRegistryStore(
        path.join(companionPath, ".mate", "config", "registry.yaml"),
      ).save({
        repos,
      });
    }

    test("resolves via fallback and self-heals the repo-local cache when the file is missing", async () => {
      const root = await makeTempDir("resolver-fallback-missing-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      const companionPath = path.join(root, "companion");
      await writeCompanionRegistry(companionPath, [{ id: "app", path: repoPath }]);

      const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
      await globalStore.register(companionPath);

      const result = await new CompanionResolver(globalStore).resolve(repoPath);

      expect(result).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
      const healed = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
      expect(healed.companions).toEqual([
        { path: path.resolve(companionPath), repositoryId: "app" },
      ]);
      expect(healed.repository).toEqual({ id: "app", path: path.resolve(repoPath) });
    });

    test("falls back the same way when the repo-local file is corrupted", async () => {
      const root = await makeTempDir("resolver-fallback-corrupt-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
      await fs.writeFile(repoLocalRegistryPath(repoPath), "companions: [unterminated", "utf8");

      const companionPath = path.join(root, "companion");
      await writeCompanionRegistry(companionPath, [{ id: "app", path: repoPath }]);

      const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
      await globalStore.register(companionPath);

      const result = await new CompanionResolver(globalStore).resolve(repoPath);

      expect(result).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
    });

    test("returns no match when no registered companion lists the repository", async () => {
      const root = await makeTempDir("resolver-fallback-none-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      const companionPath = path.join(root, "companion");
      await writeCompanionRegistry(companionPath, [
        { id: "other", path: path.join(root, "other") },
      ]);

      const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
      await globalStore.register(companionPath);

      const result = await new CompanionResolver(globalStore).resolve(repoPath);

      expect(result).toBeNull();
    });

    test("surfaces multiple fallback matches as ambiguousMatches", async () => {
      const root = await makeTempDir("resolver-fallback-ambiguous-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      const companionA = path.join(root, "companion-a");
      const companionB = path.join(root, "companion-b");
      await writeCompanionRegistry(companionA, [{ id: "from-a", path: repoPath }]);
      await writeCompanionRegistry(companionB, [{ id: "from-b", path: repoPath }]);

      const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
      await globalStore.register(companionA);
      await globalStore.register(companionB);

      const result = await new CompanionResolver(globalStore).resolveWithDiagnostics(repoPath);

      expect(result.match).not.toBeNull();
      expect(result.ambiguousMatches).toHaveLength(2);
      expect(result.ambiguousMatches.map((m) => m.companionPath).sort()).toEqual(
        [path.resolve(companionA), path.resolve(companionB)].sort(),
      );

      // Ambiguous fallback matches must not self-heal onto an arbitrary winner.
      const healed = await fs.readFile(repoLocalRegistryPath(repoPath), "utf8").catch(() => null);
      expect(healed).toBeNull();
    });

    test("a second resolution after self-heal takes the fast path only, without scanning again", async () => {
      const root = await makeTempDir("resolver-fallback-heal-once-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });
      const companionPath = path.join(root, "companion");
      await writeCompanionRegistry(companionPath, [{ id: "app", path: repoPath }]);

      const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
      await globalStore.register(companionPath);
      const listSpy = spyOn(globalStore, "list");

      const resolver = new CompanionResolver(globalStore);
      const first = await resolver.resolve(repoPath);
      expect(first).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
      expect(listSpy).toHaveBeenCalledTimes(1);

      const second = await resolver.resolve(repoPath);
      expect(second).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
      expect(listSpy).toHaveBeenCalledTimes(1);

      listSpy.mockRestore();
    });
  });
});

describe("CompanionResolver link contract", () => {
  async function writeCompanionRegistry(
    companionPath: string,
    repos: Array<{ id: string; path: string }>,
  ): Promise<void> {
    await new CompanionRegistryStore(
      path.join(companionPath, ".mate", "config", "registry.yaml"),
    ).save({ repos });
  }

  test("prunes a stale pointer, keeps the live one with its source and other fields, and logs exactly", async () => {
    const root = await makeTempDir("resolver-contract-stale-");
    const repoPath = path.join(root, "project");
    const liveCompanion = path.join(root, "companion-live");
    const goneCompanion = path.join(root, "companion-gone");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(liveCompanion, { recursive: true });
    const cache = {
      repository: { id: "app", path: repoPath },
      companions: [
        { path: goneCompanion, repositoryId: "app", source: "existing" as const },
        { path: liveCompanion, repositoryId: "app", source: "git" as const },
      ],
      extra: "kept",
    };
    await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save(cache);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await new CompanionResolver(
        new GlobalConfigStore(path.join(root, "config.yaml")),
      ).resolveWithDiagnostics(repoPath, { logFailures: true });

      expect(result.match).toEqual({ companionPath: liveCompanion, repositoryId: "app" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `mate: dropping stale repo-local companion pointer (no longer exists): ${goneCompanion}`,
      );
    } finally {
      errorSpy.mockRestore();
    }

    const rewritten = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(rewritten).toEqual({
      repository: { id: "app", path: repoPath },
      companions: [{ path: liveCompanion, repositoryId: "app", source: "git" }],
      extra: "kept",
    });
  });

  test("still rewrites the file but prints nothing when logging is disabled", async () => {
    const root = await makeTempDir("resolver-contract-stale-quiet-");
    const repoPath = path.join(root, "project");
    const liveCompanion = path.join(root, "companion-live");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(liveCompanion, { recursive: true });
    await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
      companions: [
        { path: path.join(root, "companion-gone"), repositoryId: "app" },
        { path: liveCompanion, repositoryId: "app" },
      ],
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await new CompanionResolver(
        new GlobalConfigStore(path.join(root, "config.yaml")),
      ).resolveWithDiagnostics(repoPath);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    const rewritten = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(rewritten.companions).toEqual([{ path: liveCompanion, repositoryId: "app" }]);
  });

  test("walks up from a subdirectory to the nearest repo-local registry", async () => {
    const root = await makeTempDir("resolver-contract-ancestor-");
    const repoPath = path.join(root, "project");
    const deepDir = path.join(repoPath, "src", "nested", "deeper");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.mkdir(companionPath, { recursive: true });
    await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
      companions: [{ path: companionPath, repositoryId: "app" }],
    });

    const result = await new CompanionResolver(
      new GlobalConfigStore(path.join(root, "does-not-exist.yaml")),
    ).resolve(deepDir);

    expect(result).toEqual({ companionPath, repositoryId: "app" });
  });

  test("falls through to the companion scan when the cache has no companions array", async () => {
    const root = await makeTempDir("resolver-contract-no-companions-");
    const repoPath = path.join(root, "project");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(repoPath), "note: no companions here\n", "utf8");
    await writeCompanionRegistry(companionPath, [{ id: "app", path: repoPath }]);
    const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalStore.register(companionPath);

    const result = await new CompanionResolver(globalStore).resolve(repoPath);

    expect(result).toEqual({ companionPath, repositoryId: "app" });
  });

  test("a single fallback match replaces companions with one source-less pointer and writes nothing else", async () => {
    const root = await makeTempDir("resolver-contract-self-heal-");
    const repoPath = path.join(root, "project");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    const cache = { repository: { id: "old", path: "/elsewhere" }, companions: [], extra: "kept" };
    await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save(cache);
    await writeCompanionRegistry(companionPath, [{ id: "app", path: repoPath }]);
    const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalStore.register(companionPath);

    const result = await new CompanionResolver(globalStore).resolve(repoPath);

    expect(result).toEqual({ companionPath, repositoryId: "app" });
    expect(parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"))).toEqual({
      repository: { id: "app", path: repoPath },
      companions: [{ path: companionPath, repositoryId: "app" }],
      extra: "kept",
    });
    expect((await fs.readdir(repoPath)).sort()).toEqual([".mate"]);
    expect(await fs.readdir(path.join(repoPath, ".mate"))).toEqual(["config"]);
    expect(await fs.readdir(path.join(repoPath, ".mate", "config"))).toEqual(["registry.yaml"]);
  });

  test("multiple fallback matches return the first and write nothing", async () => {
    const root = await makeTempDir("resolver-contract-ambiguous-");
    const repoPath = path.join(root, "project");
    const companionA = path.join(root, "companion-a");
    const companionB = path.join(root, "companion-b");
    await fs.mkdir(repoPath, { recursive: true });
    await writeCompanionRegistry(companionA, [{ id: "from-a", path: repoPath }]);
    await writeCompanionRegistry(companionB, [{ id: "from-b", path: repoPath }]);
    const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalStore.register(companionA);
    await globalStore.register(companionB);
    const [first] = await globalStore.list();

    const result = await new CompanionResolver(globalStore).resolveWithDiagnostics(repoPath);

    expect(result.match?.companionPath).toBe(path.resolve(first!));
    expect(await fs.readdir(repoPath)).toEqual([]);
  });

  test("skips unreadable companions silently and keeps scanning", async () => {
    const root = await makeTempDir("resolver-contract-unreadable-");
    const repoPath = path.join(root, "project");
    const missingCompanion = path.join(root, "companion-missing");
    const corruptCompanion = path.join(root, "companion-corrupt");
    const goodCompanion = path.join(root, "companion-good");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(missingCompanion, { recursive: true });
    await fs.mkdir(path.join(corruptCompanion, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(corruptCompanion, ".mate", "config", "registry.yaml"),
      "repos: [unterminated",
      "utf8",
    );
    await writeCompanionRegistry(goodCompanion, [{ id: "app", path: repoPath }]);
    const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalStore.register(missingCompanion);
    await globalStore.register(corruptCompanion);
    await globalStore.register(goodCompanion);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await new CompanionResolver(globalStore).resolveWithDiagnostics(repoPath, {
        logFailures: true,
      });
      expect(result.match).toEqual({ companionPath: goodCompanion, repositoryId: "app" });
      expect(result.failures).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
