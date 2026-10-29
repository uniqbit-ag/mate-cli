import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { repoLocalFrameworkPath, repoLocalRegistryPath } from "../../runtime/repo-local";
import { CompanionRegistryStore } from "./companion-registry-store";
import { resolveFrameworkContext } from "./framework-context";
import { GlobalConfigStore } from "./global-config-store";
import { RepoLocalRegistryStore, writeRepoLocalFrameworkConfig } from "./repo-local-store";
import {
  companionRegistryPath,
  CompanionResolver,
  companionRootedStore,
  CompanionStore,
  findDescendantRepoLocalRegistries,
  findRepoLocalLinkedRepository,
  findRepoLocalRegistryFile,
  readCompanionRegistry,
  writeRepoLocalRegistryEntry,
} from "./repository-link";
import { ConfigError } from "./types";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// --- from companion-store.ts ---

async function makeStore(root: string): Promise<{
  store: CompanionStore;
  repoPath: string;
  workingRepoStore: CompanionRegistryStore;
}> {
  const repoPath = path.join(root, "working");
  await fs.mkdir(repoPath, { recursive: true });

  const workingRepoStore = new CompanionRegistryStore(path.join(root, "registry.yaml"));
  await workingRepoStore.save(CompanionRegistryStore.defaultConfig());

  return {
    store: new CompanionStore(root, workingRepoStore),
    repoPath,
    workingRepoStore,
  };
}

describe("CompanionStore", () => {
  test("registers a repository and returns it", async () => {
    const root = await makeTempDir("companion-store-add-");
    const { store, repoPath } = await makeStore(root);

    const result = await store.registerRepository({
      id: "app",
      path: repoPath,
    });

    expect(result.id).toBe("app");
  });

  test("throws ConfigError when repo path does not exist", async () => {
    const root = await makeTempDir("companion-store-bad-path-");
    const { store } = await makeStore(root);

    await expect(
      store.registerRepository({
        id: "missing",
        path: path.join(root, "nonexistent"),
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("updates an existing repository rather than duplicating it", async () => {
    const root = await makeTempDir("companion-store-update-");
    const { store, repoPath } = await makeStore(root);

    await store.registerRepository({ id: "app", path: repoPath });
    await store.registerRepository({ id: "app", path: repoPath });
    const repos = await store.listRepositories();

    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe("app");
  });

  test("getRepository returns undefined for an unknown id", async () => {
    const root = await makeTempDir("companion-store-get-");
    const { store } = await makeStore(root);

    expect(await store.getRepository("unknown")).toBeUndefined();
  });

  test("listRepositories returns all registered repos", async () => {
    const root = await makeTempDir("companion-store-list-");
    const { store, repoPath } = await makeStore(root);
    const repoPath2 = path.join(root, "working2");
    await fs.mkdir(repoPath2, { recursive: true });

    await store.registerRepository({ id: "a", path: repoPath });
    await store.registerRepository({ id: "b", path: repoPath2 });
    const repos = await store.listRepositories();

    expect(repos.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("CompanionStore prune-on-write", () => {
  test("drops a dead entry when an unrelated repository registers", async () => {
    const root = await makeTempDir("companion-store-prune-dead-");
    const { store, repoPath, workingRepoStore } = await makeStore(root);
    const goneRepoPath = path.join(root, "gone");
    const existing = CompanionRegistryStore.defaultConfig();
    existing.repos.push({ id: "gone", path: goneRepoPath });
    await workingRepoStore.save(existing);

    await store.registerRepository({ id: "app", path: repoPath });
    const repos = await store.listRepositories();

    expect(repos.map((r) => r.id)).toEqual(["app"]);
  });

  test("leaves a registry unchanged when every existing entry is still valid", async () => {
    const root = await makeTempDir("companion-store-prune-keep-");
    const { store, repoPath, workingRepoStore } = await makeStore(root);
    const otherRepoPath = path.join(root, "other");
    await fs.mkdir(otherRepoPath, { recursive: true });
    const existing = CompanionRegistryStore.defaultConfig();
    existing.repos.push({ id: "other", path: otherRepoPath });
    await workingRepoStore.save(existing);

    await store.registerRepository({ id: "app", path: repoPath });
    const repos = await store.listRepositories();

    expect(repos.map((r) => r.id).sort()).toEqual(["app", "other"]);
  });
});

async function makeCompanionRootedStore(root: string): Promise<{
  store: CompanionStore;
  companionPath: string;
  repoPath: string;
}> {
  const companionPath = path.join(root, "companion");
  const repoPath = path.join(root, "working");
  await fs.mkdir(repoPath, { recursive: true });

  const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
  const workingRepoStore = new CompanionRegistryStore(path.join(configDir, "registry.yaml"));
  await workingRepoStore.save(CompanionRegistryStore.defaultConfig());

  return { store: new CompanionStore(companionPath, workingRepoStore), companionPath, repoPath };
}

describe("CompanionStore missing registry", () => {
  test("registers a repository even when the companion has no registry.yaml yet", async () => {
    const root = await makeTempDir("companion-store-missing-registry-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const store = new CompanionStore(
      root,
      new CompanionRegistryStore(path.join(root, "registry.yaml")),
    );

    const result = await store.registerRepository({ id: "app", path: repoPath });

    expect(result.id).toBe("app");
    expect(await store.listRepositories()).toEqual([{ id: "app", path: repoPath }]);
  });
});

describe("companionRootedStore", () => {
  test("reads and writes registry.yaml under <companionPath>/.mate/config regardless of cwd", async () => {
    const root = await makeTempDir("companion-rooted-store-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });

    await companionRootedStore(companionPath).registerRepository({ id: "app", path: repoPath });

    const registry = parse(
      await fs.readFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
        "utf8",
      ),
    );
    expect(registry.repos).toEqual([{ id: "app", path: repoPath }]);
  });
});

describe("CompanionStore repo-local dual write", () => {
  test("writes the repo-local registry pointer alongside the companion-side registration", async () => {
    const root = await makeTempDir("companion-store-dual-write-");
    const { store, companionPath, repoPath } = await makeCompanionRootedStore(root);

    await store.registerRepository({ id: "app", path: repoPath });

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.companions).toEqual([
      { path: path.resolve(companionPath), repositoryId: "app", source: "git" },
    ]);
  });

  test("does not fail the link when the repo-local write fails", async () => {
    const root = await makeTempDir("companion-store-dual-write-failure-");
    const { store, repoPath } = await makeCompanionRootedStore(root);

    const repoLocalDir = path.join(repoPath, `.${FRAMEWORK_NAME}`);
    const realWriteFile = fs.writeFile.bind(fs);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args as [string, ...unknown[]];
      if (typeof filePath === "string" && filePath.startsWith(repoLocalDir)) {
        throw new Error("read-only filesystem");
      }
      return realWriteFile(...(args as Parameters<typeof fs.writeFile>));
    });

    try {
      const result = await store.registerRepository({
        id: "app",
        path: repoPath,
      });
      expect(result.id).toBe("app");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("CompanionStore link persistence contract", () => {
  test("writes the companion registry before the repo-local registry", async () => {
    const root = await makeTempDir("companion-store-write-order-");
    const { store, companionPath, repoPath } = await makeCompanionRootedStore(root);
    const companionRegistry = path.join(
      companionPath,
      `.${FRAMEWORK_NAME}`,
      "config",
      "registry.yaml",
    );
    const destinations: string[] = [];
    const realRename = fs.rename.bind(fs);
    const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      destinations.push(String(to));
      return realRename(from, to);
    });

    try {
      await store.registerRepository({ id: "app", path: repoPath });
    } finally {
      renameSpy.mockRestore();
    }

    const companionIndex = destinations.indexOf(companionRegistry);
    const repoLocalIndex = destinations.indexOf(repoLocalRegistryPath(repoPath));
    expect(companionIndex).toBeGreaterThanOrEqual(0);
    expect(repoLocalIndex).toBeGreaterThan(companionIndex);
  });

  test("keeps the companion entry and prints the exact warning when the repo-local write fails", async () => {
    const root = await makeTempDir("companion-store-repo-local-warning-");
    const { store, repoPath } = await makeCompanionRootedStore(root);
    const repoLocalDir = path.join(repoPath, `.${FRAMEWORK_NAME}`);
    const realWriteFile = fs.writeFile.bind(fs);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args as [string, ...unknown[]];
      if (typeof filePath === "string" && filePath.startsWith(repoLocalDir)) {
        throw new Error("read-only filesystem");
      }
      return realWriteFile(...(args as Parameters<typeof fs.writeFile>));
    });

    try {
      await store.registerRepository({ id: "app", path: repoPath });
      expect(errorSpy).toHaveBeenCalledWith(
        `mate: warning: failed to write repo-local registry for ${repoPath}: read-only filesystem`,
      );
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(await store.listRepositories()).toEqual([{ id: "app", path: repoPath }]);
  });

  test("rejects a non-directory path with the exact ConfigError text and writes neither file", async () => {
    const root = await makeTempDir("companion-store-not-dir-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "file.txt");
    await fs.writeFile(repoPath, "not a directory", "utf8");
    const store = companionRootedStore(companionPath);

    const linking = store.registerRepository({ id: "app", path: repoPath });

    await expect(linking).rejects.toThrow(ConfigError);
    await expect(linking).rejects.toThrow(
      `Linked repository path must exist and be a directory: ${repoPath}`,
    );
    const companionRegistry = path.join(
      companionPath,
      `.${FRAMEWORK_NAME}`,
      "config",
      "registry.yaml",
    );
    expect(await fs.stat(companionRegistry).catch(() => null)).toBeNull();
    expect(await fs.stat(repoLocalRegistryPath(repoPath)).catch(() => null)).toBeNull();
  });

  test("replaces a re-linked id in place and prunes dead entries in the same save", async () => {
    const root = await makeTempDir("companion-store-upsert-in-place-");
    const { store, repoPath, workingRepoStore } = await makeStore(root);
    const otherPath = path.join(root, "other");
    const movedPath = path.join(root, "moved");
    await fs.mkdir(otherPath, { recursive: true });
    await fs.mkdir(movedPath, { recursive: true });
    await workingRepoStore.save({
      repos: [
        { id: "gone", path: path.join(root, "gone") },
        { id: "app", path: repoPath },
        { id: "other", path: otherPath },
      ],
    });

    await store.registerRepository({ id: "app", path: movedPath });

    const saved = parse(await fs.readFile(workingRepoStore.configPath, "utf8"));
    expect(saved.repos).toEqual([
      { id: "app", path: movedPath },
      { id: "other", path: otherPath },
    ]);
  });

  test("creates the companion registry file on the first-ever link", async () => {
    const root = await makeTempDir("companion-store-first-link-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });

    await companionRootedStore(companionPath).registerRepository({ id: "app", path: repoPath });

    const companionRegistry = path.join(
      companionPath,
      `.${FRAMEWORK_NAME}`,
      "config",
      "registry.yaml",
    );
    expect(parse(await fs.readFile(companionRegistry, "utf8"))).toEqual({
      repos: [{ id: "app", path: repoPath }],
    });
  });
});

describe("CompanionStore update read", () => {
  test("removes a legacy activeRepoId from the file on disk when listing", async () => {
    const root = await makeTempDir("companion-store-update-read-legacy-");
    const { store, repoPath, workingRepoStore } = await makeStore(root);
    await fs.writeFile(
      workingRepoStore.configPath,
      `activeRepoId: app\nrepos:\n  - id: app\n    path: ${repoPath}\n`,
      "utf8",
    );

    expect(await store.listRepositories()).toEqual([{ id: "app", path: repoPath }]);

    const onDisk = parse(await fs.readFile(workingRepoStore.configPath, "utf8"));
    expect("activeRepoId" in onDisk).toBe(false);
  });

  test("removes a legacy activeRepoId from the file on disk when getting", async () => {
    const root = await makeTempDir("companion-store-update-read-legacy-get-");
    const { store, repoPath, workingRepoStore } = await makeStore(root);
    await fs.writeFile(
      workingRepoStore.configPath,
      `activeRepoId: app\nrepos:\n  - id: app\n    path: ${repoPath}\n`,
      "utf8",
    );

    expect(await store.getRepository("app")).toEqual({ id: "app", path: repoPath });

    expect(await fs.readFile(workingRepoStore.configPath, "utf8")).not.toContain("activeRepoId");
  });

  test("throws ConfigError from get and list when the registry is missing", async () => {
    const root = await makeTempDir("companion-store-update-read-missing-");
    const store = companionRootedStore(path.join(root, "companion"));

    await expect(store.getRepository("app")).rejects.toThrow(ConfigError);
    await expect(store.listRepositories()).rejects.toThrow(ConfigError);
  });
});

describe("CompanionStore built from a launch context", () => {
  afterEach(() => {
    delete process.env.MATE_ARTIFACT_PATH;
  });

  test("writes the repo-local pointer at the context's companionPath", async () => {
    const root = await makeTempDir("companion-store-make-context-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });
    process.env.MATE_ARTIFACT_PATH = companionPath;
    const context = await resolveFrameworkContext(
      root,
      new GlobalConfigStore(path.join(root, "config.yaml")),
    );

    await new CompanionStore(context.companionPath, context.workingRepoStore).registerRepository({
      id: "app",
      path: repoPath,
    });

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.companions).toEqual([
      { path: context.companionPath, repositoryId: "app", source: "git" },
    ]);
  });
});

// --- from companion-registry-reader.ts ---

async function writeRegistry(companionPath: string, contents: string): Promise<void> {
  const registryPath = companionRegistryPath(companionPath);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, contents, "utf8");
}

describe("readCompanionRegistry", () => {
  test("returns linked repos from a valid registry", async () => {
    const companionPath = await makeTempDir("companion-registry-valid-");
    await writeRegistry(companionPath, "repos:\n  - id: app\n    path: /repos/app\n");

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("drops malformed entries missing id or path", async () => {
    const companionPath = await makeTempDir("companion-registry-malformed-");
    await writeRegistry(
      companionPath,
      "repos:\n  - id: app\n    path: /repos/app\n  - path: /repos/no-id\n  - id: no-path\n",
    );

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("returns an empty list when repos is absent", async () => {
    const companionPath = await makeTempDir("companion-registry-norepos-");
    await writeRegistry(companionPath, "version: 1\n");

    const result = await readCompanionRegistry(companionPath);

    expect(result.repos).toEqual([]);
  });

  test("throws ENOENT when the registry file is missing", async () => {
    const companionPath = await makeTempDir("companion-registry-missing-");

    await expect(readCompanionRegistry(companionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not perform legacy-field migration writes", async () => {
    const companionPath = await makeTempDir("companion-registry-no-migration-");
    await writeRegistry(
      companionPath,
      "activeRepoId: app\nrepos:\n  - id: app\n    path: /repos/app\n",
    );
    const registryPath = companionRegistryPath(companionPath);
    const before = await fs.readFile(registryPath, "utf8");

    await readCompanionRegistry(companionPath);

    const after = await fs.readFile(registryPath, "utf8");
    expect(after).toBe(before);
  });

  test("registry path is nested under the companion's framework config dir", async () => {
    const companionPath = "/tmp/example-companion";

    expect(companionRegistryPath(companionPath)).toBe(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
    );
  });
});

// --- from companion-resolver.ts ---

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

// --- from repo-local-registry.ts ---

async function initGitRepo(repoPath: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-q", repoPath]);
}

describe("writeRepoLocalRegistryEntry", () => {
  test("creates the registry, framework config, and git-exclude entry", async () => {
    const root = await makeTempDir("repo-local-write-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.repository).toEqual({
      id: "app",
      path: path.resolve(repoPath),
    });
    expect(registry.companions).toEqual([
      { path: path.resolve("/tmp/companion"), repositoryId: "app", source: "git" },
    ]);

    const framework = parse(await fs.readFile(repoLocalFrameworkPath(repoPath), "utf8"));
    expect(framework.type).toBe("working");

    const exclude = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`/.${FRAMEWORK_NAME}/`);
  });

  test("upserts a pointer for the same companion path instead of duplicating it", async () => {
    const root = await makeTempDir("repo-local-upsert-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "renamed-app", path: repoPath },
      "existing",
    );

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.repository).toEqual({
      id: "renamed-app",
      path: path.resolve(repoPath),
    });
    expect(registry.companions).toEqual([
      { path: path.resolve("/tmp/companion"), repositoryId: "renamed-app", source: "existing" },
    ]);
  });

  test("records more than one companion when the repo links to multiple", async () => {
    const root = await makeTempDir("repo-local-multi-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion-a",
      { id: "app", path: repoPath },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion-b",
      { id: "app", path: repoPath },
      "existing",
    );

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.companions.map((c: { path: string }) => c.path).sort()).toEqual(
      [path.resolve("/tmp/companion-a"), path.resolve("/tmp/companion-b")].sort(),
    );
  });

  test("does not overwrite an already-written framework.yaml", async () => {
    const root = await makeTempDir("repo-local-framework-preserve-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalFrameworkConfig(repoPath);
    await fs.writeFile(repoLocalFrameworkPath(repoPath), "type: working\nextra: kept\n", "utf8");

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );

    const framework = parse(await fs.readFile(repoLocalFrameworkPath(repoPath), "utf8"));
    expect(framework.extra).toBe("kept");
  });
});

describe("the managed exclude block a Repository Link writes", () => {
  test("is skipped when the repo has no .git directory", async () => {
    const root = await makeTempDir("repo-local-nogit-");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repoPath,
      path.join(root, "companion"),
      { id: "acme", path: repoPath },
      "git",
    );

    await expect(fs.access(path.join(repoPath, ".git"))).rejects.toThrow();
  });

  test("does not duplicate the exclude entry on repeated links", async () => {
    const root = await makeTempDir("repo-local-exclude-dedupe-");
    const repoPath = path.join(root, "repo");
    const companionPath = path.join(root, "companion");
    await initGitRepo(repoPath);

    const repository = { id: "acme", path: repoPath };
    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");

    const exclude = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
    const matches = exclude.split("\n").filter((line) => line === `/.${FRAMEWORK_NAME}/`);
    expect(matches).toHaveLength(1);
  });
});

describe("findRepoLocalRegistryFile", () => {
  test("finds the registry from the repo root", async () => {
    const root = await makeTempDir("repo-local-find-root-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );

    const found = await findRepoLocalRegistryFile(repoPath);

    expect(found?.repoRoot).toBe(path.resolve(repoPath));
  });

  test("finds the registry when cwd is a subdirectory of the repo", async () => {
    const root = await makeTempDir("repo-local-find-subdir-");
    const repoPath = path.join(root, "repo");
    const subDir = path.join(repoPath, "src", "components");
    await initGitRepo(repoPath);
    await fs.mkdir(subDir, { recursive: true });
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );

    const found = await findRepoLocalRegistryFile(subDir);

    expect(found?.repoRoot).toBe(path.resolve(repoPath));
  });

  test("returns null when no ancestor has a repo-local registry", async () => {
    const root = await makeTempDir("repo-local-find-none-");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    expect(await findRepoLocalRegistryFile(repoPath)).toBeNull();
  });
});

describe("findDescendantRepoLocalRegistries", () => {
  test("returns no paths when no descendant has a repo-local registry", async () => {
    const root = await makeTempDir("repo-local-descendants-none-");
    await fs.mkdir(path.join(root, "repo"), { recursive: true });
    await fs.mkdir(path.dirname(repoLocalRegistryPath(root)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(root), "companions: []\n", "utf8");

    await expect(findDescendantRepoLocalRegistries(root)).resolves.toEqual([]);
  });

  test("finds one descendant registry and returns its parent directory", async () => {
    const root = await makeTempDir("repo-local-descendants-one-");
    const descendant = path.join(root, "workspace", "working-a");
    await fs.mkdir(path.dirname(repoLocalRegistryPath(descendant)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(descendant), "companions: []\n", "utf8");

    await expect(findDescendantRepoLocalRegistries(root)).resolves.toEqual([descendant]);
  });

  test("finds multiple descendant registries", async () => {
    const root = await makeTempDir("repo-local-descendants-many-");
    const descendants = [path.join(root, "working-a"), path.join(root, "nested", "working-b")];
    for (const descendant of descendants) {
      await fs.mkdir(path.dirname(repoLocalRegistryPath(descendant)), { recursive: true });
      await fs.writeFile(repoLocalRegistryPath(descendant), "companions: []\n", "utf8");
    }

    await expect(findDescendantRepoLocalRegistries(root)).resolves.toEqual(descendants.sort());
  });

  test("does not descend into skip-listed directories", async () => {
    const root = await makeTempDir("repo-local-descendants-skipped-");
    const skippedDescendant = path.join(root, "node_modules", "working-a");
    await fs.mkdir(path.dirname(repoLocalRegistryPath(skippedDescendant)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(skippedDescendant), "companions: []\n", "utf8");

    await expect(findDescendantRepoLocalRegistries(root)).resolves.toEqual([]);
  });

  test("skips unreadable directories without throwing", async () => {
    const root = await makeTempDir("repo-local-descendants-unreadable-");
    const unreadable = path.join(root, "unreadable");
    const readable = path.join(root, "readable");
    await fs.mkdir(unreadable, { recursive: true });
    await fs.mkdir(path.dirname(repoLocalRegistryPath(readable)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(readable), "companions: []\n", "utf8");

    await fs.chmod(unreadable, 0o000);
    try {
      await expect(findDescendantRepoLocalRegistries(root)).resolves.toEqual([readable]);
    } finally {
      await fs.chmod(unreadable, 0o755);
    }
  });
});

describe("findRepoLocalLinkedRepository", () => {
  test("returns the linked repository metadata from the repo-local registry", async () => {
    const root = await makeTempDir("repo-local-linked-repo-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath },
      "git",
    );

    expect(await findRepoLocalLinkedRepository(repoPath)).toEqual({
      id: "app",
      path: path.resolve(repoPath),
    });
  });

  test("strips legacy profile and overrides fields from a stale repo-local entry", async () => {
    const root = await makeTempDir("repo-local-linked-repo-legacy-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
    await fs.writeFile(
      repoLocalRegistryPath(repoPath),
      [
        "repository:",
        "  id: app",
        `  path: ${repoPath}`,
        "  profile: default",
        "  overrides:",
        "    allowedAgents:",
        "      - claude",
        "companions: []",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await findRepoLocalLinkedRepository(repoPath)).toEqual({
      id: "app",
      path: path.resolve(repoPath),
    });
  });

  test("returns null when the repo-local registry has no repository metadata", async () => {
    const root = await makeTempDir("repo-local-linked-repo-missing-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
    await fs.writeFile(repoLocalRegistryPath(repoPath), "companions: []\n", "utf8");

    expect(await findRepoLocalLinkedRepository(repoPath)).toBeNull();
  });
});

/**
 * `<root>/forward` links to `<root>/outside/sub`, so `<root>/forward/../companion`
 * leads to `<root>/outside/companion`; a lexical normalisation names the decoy
 * at `<root>/companion`, whose policy turns the guardrails off.
 */
describe("CompanionResolver: a companion written with a link before `..`", () => {
  async function linkFixture() {
    const root = await fs.realpath(await makeTempDir("resolver-link-dotdot-"));
    const repoPath = path.join(root, "project");
    const real = path.join(root, "outside", "companion");
    const decoy = path.join(root, "companion");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(root, "outside", "sub"), { recursive: true });
    await fs.symlink(path.join(root, "outside", "sub"), path.join(root, "forward"));
    for (const companion of [real, decoy]) {
      await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
    }
    await fs.writeFile(
      path.join(decoy, ".mate", "config", "framework.yaml"),
      "secrets:\n  guardrails: false\n",
      "utf8",
    );
    const linkRepo = (companion: string) =>
      new CompanionRegistryStore(companionRegistryPath(companion)).save({
        repos: [{ id: "app", path: repoPath }],
      });
    const configPath = path.join(root, "config.yaml");
    /** Joined by hand: `path.join` would normalise the `..` away. */
    const written = [root, "forward", "..", "companion"].join(path.sep);
    /** Written as is: `GlobalConfigStore.register` would normalise the spelling first. */
    const registerWritten = () =>
      fs.writeFile(configPath, `version: 1\ncompanions:\n  - path: ${written}\n`, "utf8");
    return {
      repoPath,
      real,
      decoy,
      written,
      linkRepo,
      registerWritten,
      store: new GlobalConfigStore(configPath),
    };
  }

  test("a repo-local pointer resolves to where the spelling leads", async () => {
    const { repoPath, real, written, store } = await linkFixture();
    await fs.mkdir(path.dirname(repoLocalRegistryPath(repoPath)), { recursive: true });
    await fs.writeFile(
      repoLocalRegistryPath(repoPath),
      `companions:\n  - path: ${written}\n    repositoryId: app\n`,
      "utf8",
    );

    expect(await new CompanionResolver(store).resolve(repoPath)).toEqual({
      companionPath: real,
      repositoryId: "app",
    });
  });

  test("a global registration resolves to where the spelling leads, through its registry", async () => {
    const { repoPath, real, linkRepo, registerWritten, store } = await linkFixture();
    await linkRepo(real);
    await registerWritten();

    expect(await new CompanionResolver(store).resolve(repoPath)).toEqual({
      companionPath: real,
      repositoryId: "app",
    });
  });

  test("the decoy's registry vouches for nothing", async () => {
    const { repoPath, decoy, linkRepo, registerWritten, store } = await linkFixture();
    await linkRepo(decoy);
    await registerWritten();

    expect(await new CompanionResolver(store).resolve(repoPath)).toBeNull();
  });

  test("a registration leading to a missing companion does not read the decoy's registry", async () => {
    const { repoPath, real, decoy, linkRepo, registerWritten, store } = await linkFixture();
    await fs.rm(real, { recursive: true });
    await linkRepo(decoy);
    await registerWritten();

    expect(await new CompanionResolver(store).resolve(repoPath)).toBeNull();
    await expect(fs.access(repoLocalRegistryPath(repoPath))).rejects.toThrow();
  });
});
