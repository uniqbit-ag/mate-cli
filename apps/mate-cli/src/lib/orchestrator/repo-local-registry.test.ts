import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

import { frameworkConfig } from "../../framework";
import {
  ensureRepoLocalDirExcluded,
  findRepoLocalLinkedRepository,
  findRepoLocalRegistryFile,
  listOtherRepoLocalCompanionPaths,
  repoLocalFrameworkPath,
  repoLocalRegistryPath,
  writeRepoLocalFrameworkConfig,
  writeRepoLocalRegistryEntry,
} from "./repo-local-registry";

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
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.repository).toEqual({
      id: "app",
      path: path.resolve(repoPath),
      profile: "default",
    });
    expect(registry.companions).toEqual([
      { path: path.resolve("/tmp/companion"), repositoryId: "app", source: "git" },
    ]);

    const framework = parse(await fs.readFile(repoLocalFrameworkPath(repoPath), "utf8"));
    expect(framework.type).toBe("working");

    const exclude = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`.${frameworkConfig.name}/`);
  });

  test("upserts a pointer for the same companion path instead of duplicating it", async () => {
    const root = await makeTempDir("repo-local-upsert-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion",
      { id: "renamed-app", path: repoPath, profile: "research" },
      "existing",
    );

    const registry = parse(await fs.readFile(repoLocalRegistryPath(repoPath), "utf8"));
    expect(registry.repository).toEqual({
      id: "renamed-app",
      path: path.resolve(repoPath),
      profile: "research",
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
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion-b",
      { id: "app", path: repoPath, profile: "default" },
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
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const framework = parse(await fs.readFile(repoLocalFrameworkPath(repoPath), "utf8"));
    expect(framework.extra).toBe("kept");
  });
});

describe("ensureRepoLocalDirExcluded", () => {
  test("is a no-op when the repo has no .git directory", async () => {
    const root = await makeTempDir("repo-local-nogit-");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    await expect(ensureRepoLocalDirExcluded(repoPath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(repoPath, ".git"))).rejects.toThrow();
  });

  test("does not duplicate the exclude entry on repeated calls", async () => {
    const root = await makeTempDir("repo-local-exclude-dedupe-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);

    await ensureRepoLocalDirExcluded(repoPath);
    await ensureRepoLocalDirExcluded(repoPath);

    const exclude = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
    const matches = exclude.split("\n").filter((line) => line === `.${frameworkConfig.name}/`);
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
      { id: "app", path: repoPath, profile: "default" },
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
      { id: "app", path: repoPath, profile: "default" },
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

describe("listOtherRepoLocalCompanionPaths", () => {
  test("excludes the given path and returns the rest", async () => {
    const root = await makeTempDir("repo-local-others-");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion-a",
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      "/tmp/companion-b",
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const others = await listOtherRepoLocalCompanionPaths(repoPath, "/tmp/companion-a");

    expect(others).toEqual([path.resolve("/tmp/companion-b")]);
  });

  test("returns an empty array when the registry file is missing", async () => {
    const root = await makeTempDir("repo-local-others-missing-");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    expect(await listOtherRepoLocalCompanionPaths(repoPath, "/tmp/companion-a")).toEqual([]);
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
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    expect(await findRepoLocalLinkedRepository(repoPath)).toEqual({
      id: "app",
      path: path.resolve(repoPath),
      profile: "default",
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
