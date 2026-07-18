import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse } from "yaml";

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

      const store = new GlobalConfigStore(path.join(root, "does-not-exist.yaml"));

      const result = await new CompanionResolver(store).resolveWithDiagnostics(repoPath);

      expect(result.ambiguousMatches).toHaveLength(2);
      expect(result.ambiguousMatches.map((m) => m.companionPath).sort()).toEqual(
        [companionA, companionB].sort(),
      );
    });
  });
});
