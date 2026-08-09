import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore } from "./config-store";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import { type CompanionSource, ConfigError, type LinkedRepository } from "./types";
import { WorkingRepoStore } from "./working-repo-store";

/** Builds a {@link CompanionStore} whose config/registry files live under `<companionPath>/.mate/config`, regardless of `process.cwd()`. */
export function companionRootedStore(companionPath: string): CompanionStore {
  const configDir = path.join(path.resolve(companionPath), `.${FRAMEWORK_NAME}`, "config");
  return new CompanionStore(
    new ConfigStore(path.join(configDir, "framework.yaml")),
    new WorkingRepoStore(path.join(configDir, "registry.yaml")),
  );
}

export class CompanionStore {
  constructor(
    private readonly configStore = new ConfigStore(),
    private readonly workingRepoStore = new WorkingRepoStore(),
  ) {}

  async registerRepository(
    repository: LinkedRepository,
    options: { companionSource?: CompanionSource } = {},
  ): Promise<LinkedRepository> {
    const stats = await fs.stat(repository.path).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new ConfigError(
        `Linked repository path must exist and be a directory: ${repository.path}`,
      );
    }

    // A companion's registry.yaml may not exist yet (its first-ever link):
    // that is not a real error here, unlike a working repo reading its own
    // missing config, so fall back to an empty registry instead of throwing.
    const working = await this.workingRepoStore.load().catch((error) => {
      if (error instanceof ConfigError) return WorkingRepoStore.defaultConfig();
      throw error;
    });
    const existing = working.repos.findIndex((r) => r.id === repository.id);
    if (existing >= 0) {
      working.repos[existing] = repository;
    } else {
      working.repos.push(repository);
    }
    await this.workingRepoStore.save(working);

    // Repo-local registry write is a cache, not the source of truth: the
    // companion-side write above already succeeded, so a failure here (e.g. a
    // read-only working tree) must not fail the overall link operation.
    try {
      const companionRoot = path.resolve(path.dirname(this.configStore.configPath), "..", "..");
      await writeRepoLocalRegistryEntry(
        repository.path,
        companionRoot,
        repository,
        options.companionSource ?? "git",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `mate: warning: failed to write repo-local registry for ${repository.path}: ${message}`,
      );
    }

    return repository;
  }

  async getRepository(repositoryId: string): Promise<LinkedRepository | undefined> {
    const working = await this.workingRepoStore.load();
    return working.repos.find((r) => r.id === repositoryId);
  }

  async listRepositories(): Promise<LinkedRepository[]> {
    const working = await this.workingRepoStore.load();
    return working.repos;
  }
}
