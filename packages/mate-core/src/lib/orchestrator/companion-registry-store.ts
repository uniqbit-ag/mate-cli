import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { migrateRegistryData } from "./migration";
import { YamlFileStore } from "./yaml-file-store";
import { ConfigError, type CompanionRegistryConfig } from "./types";

export function getDefaultCompanionRegistryPath(): string {
  return `.${FRAMEWORK_NAME}/config/registry.yaml`;
}

/**
 * Companion-side reverse index (`{ repos: [...] }`) at
 * `<companion>/.mate/config/registry.yaml` — distinct from the repo-local
 * cache ({@link RepoLocalRegistryStore}) despite the shared "registry.yaml"
 * filename. Renamed from `WorkingRepoStore`: every call site pointed this
 * at a companion's config dir, never an actual working repo.
 */
export class CompanionRegistryStore extends YamlFileStore<CompanionRegistryConfig> {
  constructor(configPath = getDefaultCompanionRegistryPath()) {
    super(path.resolve(configPath));
  }

  override async load(): Promise<CompanionRegistryConfig> {
    await migrateRegistryData(this.configPath);
    const config = await super.load();
    // Silently drop legacy per-repo policy fields (profile/overrides); the
    // clean shape persists on the next save.
    return {
      ...config,
      repos: (config.repos ?? []).map(({ id, path: repoPath }) => ({ id, path: repoPath })),
    };
  }

  protected async onMissing(): Promise<CompanionRegistryConfig> {
    throw new ConfigError(
      `Working repo config not found. Please run \`${FRAMEWORK_NAME} companion setup\` to initialize the framework.`,
    );
  }

  static defaultConfig(): CompanionRegistryConfig {
    return { repos: [] };
  }
}
