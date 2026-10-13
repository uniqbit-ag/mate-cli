import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { companionRootedStore, CompanionStore } from "./companion-store";
import { ConfigStore } from "./config-store";
import { resolveFrameworkContext } from "./framework-context";
import { GlobalConfigStore } from "./global-config-store";
import { repoLocalRegistryPath } from "./repo-local-registry";
import { ConfigError } from "./types";
import { CompanionRegistryStore } from "./companion-registry-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeStore(root: string): Promise<{
  store: CompanionStore;
  repoPath: string;
  workingRepoStore: CompanionRegistryStore;
}> {
  const repoPath = path.join(root, "working");
  await fs.mkdir(repoPath, { recursive: true });

  const configStore = new ConfigStore(path.join(root, "framework.yaml"));
  const workingRepoStore = new CompanionRegistryStore(path.join(root, "registry.yaml"));
  await workingRepoStore.save(CompanionRegistryStore.defaultConfig());

  return {
    store: new CompanionStore(configStore, workingRepoStore),
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
  const configStore = new ConfigStore(path.join(configDir, "framework.yaml"));
  const workingRepoStore = new CompanionRegistryStore(path.join(configDir, "registry.yaml"));
  await workingRepoStore.save(CompanionRegistryStore.defaultConfig());

  return { store: new CompanionStore(configStore, workingRepoStore), companionPath, repoPath };
}

describe("CompanionStore missing registry", () => {
  test("registers a repository even when the companion has no registry.yaml yet", async () => {
    const root = await makeTempDir("companion-store-missing-registry-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const store = new CompanionStore(
      new ConfigStore(path.join(root, "framework.yaml")),
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

    await new CompanionStore(context.configStore, context.workingRepoStore).registerRepository({
      id: "app",
      path: repoPath,
    });

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.companions).toEqual([
      { path: context.companionPath, repositoryId: "app", source: "git" },
    ]);
  });
});
