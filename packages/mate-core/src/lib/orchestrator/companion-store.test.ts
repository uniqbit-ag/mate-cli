import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { companionRootedStore, CompanionStore } from "./companion-store";
import { ConfigStore } from "./config-store";
import { repoLocalRegistryPath } from "./repo-local-registry";
import { ConfigError } from "./types";
import { WorkingRepoStore } from "./working-repo-store";

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
  workingRepoStore: WorkingRepoStore;
}> {
  const repoPath = path.join(root, "working");
  await fs.mkdir(repoPath, { recursive: true });

  const configStore = new ConfigStore(path.join(root, "framework.yaml"));
  const workingRepoStore = new WorkingRepoStore(path.join(root, "registry.yaml"));
  await workingRepoStore.save(WorkingRepoStore.defaultConfig());

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
  const workingRepoStore = new WorkingRepoStore(path.join(configDir, "registry.yaml"));
  await workingRepoStore.save(WorkingRepoStore.defaultConfig());

  return { store: new CompanionStore(configStore, workingRepoStore), companionPath, repoPath };
}

describe("CompanionStore missing registry", () => {
  test("registers a repository even when the companion has no registry.yaml yet", async () => {
    const root = await makeTempDir("companion-store-missing-registry-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const store = new CompanionStore(
      new ConfigStore(path.join(root, "framework.yaml")),
      new WorkingRepoStore(path.join(root, "registry.yaml")),
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
