import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frameworkConfig } from "../../framework";
import {
  resolveForCapability,
  resolveForLaunch,
  resolveFrameworkContext,
} from "./framework-context";
import { GlobalConfigStore } from "./global-config-store";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import {
  AmbiguousCompanionError,
  RepositoryNotFoundError,
  WorkingRepoRequiredError,
} from "./types";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.MATE_ARTIFACT_PATH;
  delete process.env.MATE_REPO_ID;
});

describe("resolveFrameworkContext", () => {
  test("uses MATE_ARTIFACT_PATH env var when set", async () => {
    const root = await makeTempDir("ctx-env-");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });
    process.env.MATE_ARTIFACT_PATH = companionPath;

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const ctx = await resolveFrameworkContext(root, store);

    expect(ctx.companionPath).toBe(path.resolve(companionPath));
  });

  test("resolves from local config when present", async () => {
    const root = await makeTempDir("ctx-local-");
    const localConfigPath = path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const ctx = await resolveFrameworkContext(root, store);

    expect(ctx.companionPath).toBe(root);
  });

  test("throws RepositoryNotFoundError when nothing is found", async () => {
    const root = await makeTempDir("ctx-missing-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    await expect(resolveFrameworkContext(root, store)).rejects.toThrow(RepositoryNotFoundError);
  });

  test("resolves via repo-local working repo link metadata", async () => {
    const root = await makeTempDir("ctx-repo-local-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    await store.register(companionPath);

    const ctx = await resolveFrameworkContext(repoPath, store);

    expect(ctx.companionPath).toBe(companionPath);
  });
});

describe("resolveForLaunch", () => {
  test("uses MATE_ARTIFACT_PATH env var and returns repositoryId from env", async () => {
    const root = await makeTempDir("launch-env-");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });
    process.env.MATE_ARTIFACT_PATH = companionPath;
    process.env.MATE_REPO_ID = "my-repo";

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const ctx = await resolveForLaunch(root, store);

    expect(ctx.companionPath).toBe(path.resolve(companionPath));
    expect(ctx.repositoryId).toBe("my-repo");
  });

  test("uses explicit working repo environment when running from a companion", async () => {
    const root = await makeTempDir("launch-env-repo-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });
    process.env.MATE_ARTIFACT_PATH = companionPath;
    process.env.MATE_REPO_PATH = repoPath;
    process.env.MATE_REPO_ID = "my-repo";
    process.env.MATE_REPO_PROFILE = "default";

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const ctx = await resolveForLaunch(companionPath, store);

    expect(ctx.repository).toEqual({ id: "my-repo", path: repoPath, profile: "default" });
    expect(ctx.repositoryId).toBe("my-repo");
  });

  test("resolves from working repo via repo-local metadata and returns repositoryId", async () => {
    const root = await makeTempDir("launch-repo-local-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    await store.register(companionPath);

    const ctx = await resolveForLaunch(repoPath, store);

    expect(ctx.companionPath).toBe(companionPath);
    expect(ctx.repositoryId).toBe("app");
  });

  test("throws WorkingRepoRequiredError when cwd is a companion directory", async () => {
    const root = await makeTempDir("launch-companion-cwd-");
    const localConfigPath = path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    await expect(resolveForLaunch(root, store)).rejects.toThrow(WorkingRepoRequiredError);
  });

  test("throws WorkingRepoRequiredError with mate companion link hint when no companion covers cwd", async () => {
    const root = await makeTempDir("launch-unregistered-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    const error = await resolveForLaunch(root, store).catch((e) => e);

    expect(error).toBeInstanceOf(WorkingRepoRequiredError);
    expect(error.message).toContain("mate companion link");
    expect(error.message).toContain("mate companion list");
  });

  test("throws AmbiguousCompanionError when multiple companions link the same repo", async () => {
    const root = await makeTempDir("launch-ambiguous-");
    const repoPath = path.join(root, "working");
    const companionA = path.join(root, "companion-a");
    const companionB = path.join(root, "companion-b");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(companionA, { recursive: true });
    await fs.mkdir(companionB, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repoPath,
      companionA,
      { id: "app-a", path: repoPath, profile: "default" },
      "git",
    );
    await writeRepoLocalRegistryEntry(
      repoPath,
      companionB,
      { id: "app-b", path: repoPath, profile: "default" },
      "git",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    await store.register(companionA);
    await store.register(companionB);

    await expect(resolveForLaunch(repoPath, store)).rejects.toThrow(AmbiguousCompanionError);
  });
});

describe("resolveForCapability", () => {
  test("prefers companion env vars over a linked working repo", async () => {
    const root = await makeTempDir("cap-working-cwd-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "working");
    const wrongCompanionPath = path.join(root, "wrong-companion");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(wrongCompanionPath, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repoPath,
      companionPath,
      { id: "app", path: repoPath, profile: "default" },
      "git",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    await store.register(companionPath);

    process.env.MATE_ARTIFACT_PATH = wrongCompanionPath;
    process.env.MATE_REPO_ID = "wrong-repo";

    const ctx = await resolveForCapability(repoPath, store);

    expect(ctx.companionPath).toBe(wrongCompanionPath);
    expect(ctx.repositoryId).toBe("wrong-repo");
  });

  test("resolves from companion directory local config using MATE_REPO_ID", async () => {
    const root = await makeTempDir("cap-companion-cwd-");
    const localConfigPath = path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    process.env.MATE_REPO_ID = "second-repo";

    const ctx = await resolveForCapability(root, store);

    expect(ctx.companionPath).toBe(root);
    expect(ctx.repositoryId).toBe("second-repo");
  });

  test("returns an empty repositoryId for companion-root capability context when MATE_REPO_ID is unset", async () => {
    const root = await makeTempDir("cap-companion-no-env-");
    const localConfigPath = path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    const ctx = await resolveForCapability(root, store);

    expect(ctx.companionPath).toBe(root);
    expect(ctx.repositoryId).toBe("");
  });

  test("throws WorkingRepoRequiredError when no companion or registry match", async () => {
    const root = await makeTempDir("cap-unregistered-");

    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const error = await resolveForCapability(root, store).catch((e) => e);

    expect(error).toBeInstanceOf(WorkingRepoRequiredError);
    expect(error.message).toContain("mate: cap must be run from a working repository directory.");
    expect(error.message).toContain(
      "Run `mate cap` from inside a directory you have registered with:",
    );
  });
});
