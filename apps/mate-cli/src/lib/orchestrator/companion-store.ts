import fs from "node:fs/promises";
import path from "node:path";

import { ConfigStore } from "./config-store";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import {
  type CompanionSource,
  ConfigError,
  type FrameworkConfig,
  type LinkedRepository,
  type PolicySettings,
} from "./types";
import { WorkingRepoStore } from "./working-repo-store";

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

    const working = await this.workingRepoStore.load();
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

  async resolvePolicy(repositoryId: string): Promise<PolicySettings> {
    const [config, working] = await Promise.all([
      this.configStore.load(),
      this.workingRepoStore.load(),
    ]);
    return resolvePolicyFromConfig(config, working.repos, repositoryId);
  }
}

export function resolvePolicyFromConfig(
  config: FrameworkConfig,
  repos: LinkedRepository[],
  repositoryId: string,
): PolicySettings {
  const repository = repos.find((r) => r.id === repositoryId);
  if (!repository) {
    throw new ConfigError(`Unknown linked repository: ${repositoryId}`);
  }

  const profile = config.profiles[repository.profile];
  if (!profile) {
    throw new ConfigError(`Unknown policy profile: ${repository.profile}`);
  }

  return {
    allowedAgents: repository.overrides?.allowedAgents ?? profile.allowedAgents,
  };
}
