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
    test("resolves a globally registered pointer without scanning companion registries", async () => {
      const root = await makeTempDir("resolver-repo-local-fast-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [{ path: companionPath, repositoryId: "app" }],
      });

      // The companion has no companion-side registry.yaml, so the global
      // fallback scan could never resolve it — success proves the repo-local
      // pointer was used.
      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      await store.register(companionPath);

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

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      await store.register(companionPath);

      const result = await new CompanionResolver(store).resolve(subDir);

      expect(result?.repositoryId).toBe("app");
    });

    test("rejects an unregistered pointer with a warning and no match", async () => {
      const root = await makeTempDir("resolver-repo-local-untrusted-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [{ path: companionPath, repositoryId: "app" }],
      });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const resolver = new CompanionResolver(store);
      const result = await resolver.resolveWithDiagnostics(repoPath, { logFailures: true });

      expect(result.match).toBeNull();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.companionPath).toBe(path.resolve(companionPath));
      expect(result.failures[0]!.message).toContain("untrusted");
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(path.resolve(companionPath));

      // The untrusted pointer survives on disk — linking later establishes trust.
      const rewritten = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
      expect(rewritten.companions).toEqual([
        { path: path.resolve(companionPath), repositoryId: "app" },
      ]);

      errorSpy.mockRestore();
    });

    test("linking establishes trust: a previously rejected pointer resolves after registration", async () => {
      const root = await makeTempDir("resolver-repo-local-trust-later-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [{ path: companionPath, repositoryId: "app" }],
      });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      const resolver = new CompanionResolver(store);
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      expect(await resolver.resolve(repoPath)).toBeNull();
      errorSpy.mockRestore();

      await store.register(companionPath);

      expect(await resolver.resolve(repoPath)).toEqual({
        companionPath: path.resolve(companionPath),
        repositoryId: "app",
      });
    });

    test("only trusted pointers match when trusted and untrusted pointers coexist", async () => {
      const root = await makeTempDir("resolver-repo-local-mixed-trust-");
      const repoPath = path.join(root, "project");
      await fs.mkdir(repoPath, { recursive: true });

      const trustedCompanion = path.join(root, "companion-trusted");
      const untrustedCompanion = path.join(root, "companion-untrusted");
      await fs.mkdir(trustedCompanion, { recursive: true });
      await fs.mkdir(untrustedCompanion, { recursive: true });
      await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
        companions: [
          { path: untrustedCompanion, repositoryId: "from-untrusted" },
          { path: trustedCompanion, repositoryId: "from-trusted" },
        ],
      });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      await store.register(trustedCompanion);

      const result = await new CompanionResolver(store).resolveWithDiagnostics(repoPath);

      expect(result.match).toEqual({
        companionPath: path.resolve(trustedCompanion),
        repositoryId: "from-trusted",
      });
      expect(result.ambiguousMatches).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.companionPath).toBe(path.resolve(untrustedCompanion));
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
        companions: [{ path: goneCompanionPath, repositoryId: "app" }],
      });

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const result = await new CompanionResolver(store).resolve(repoPath);

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();

      const rewritten = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
      expect(rewritten.companions).toEqual([]);

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

      const store = new GlobalConfigStore(path.join(root, "config.yaml"));
      await store.register(companionA);
      await store.register(companionB);

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

      const resolver = new CompanionResolver(globalStore);
      const first = await resolver.resolve(repoPath);
      expect(first).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });

      // Corrupt the companion-side registry: a second fallback scan would now
      // fail, so continued resolution proves the healed fast path is used.
      // (The trust cross-check still reads the global config on every resolve.)
      await fs.writeFile(
        path.join(companionPath, ".mate", "config", "registry.yaml"),
        "repos: [unterminated",
        "utf8",
      );

      const second = await resolver.resolve(repoPath);
      expect(second).toEqual({ companionPath: path.resolve(companionPath), repositoryId: "app" });
    });
  });
});
