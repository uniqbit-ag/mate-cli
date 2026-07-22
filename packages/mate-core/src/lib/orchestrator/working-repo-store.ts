import path from "node:path";

import { frameworkConfig } from "../../framework";
import { migrateRegistryData } from "./migration";
import { YamlFileStore } from "./yaml-file-store";
import { ConfigError, type WorkingRepoConfig } from "./types";

export function getDefaultWorkingRepoPath(): string {
  return `.${frameworkConfig.name}/config/registry.yaml`;
}

export class WorkingRepoStore extends YamlFileStore<WorkingRepoConfig> {
  constructor(configPath = getDefaultWorkingRepoPath()) {
    super(path.resolve(configPath));
  }

  override async load(): Promise<WorkingRepoConfig> {
    await migrateRegistryData(this.configPath);
    return super.load();
  }

  protected async onMissing(): Promise<WorkingRepoConfig> {
    throw new ConfigError(
      `Working repo config not found. Please run \`${frameworkConfig.name} companion setup\` to initialize the framework.`,
    );
  }

  static defaultConfig(): WorkingRepoConfig {
    return { repos: [] };
  }
}
