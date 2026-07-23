import path from "node:path";

import { frameworkConfig } from "../../framework";
import { getDefaultSetupSelections } from "./setup-compatibilities";
import { YamlFileStore } from "./yaml-file-store";
import { type FrameworkConfig } from "./types";

function defaultConfigPath(): string {
  return `.${frameworkConfig.name}/config/framework.yaml`;
}

export function defaultConfig(): FrameworkConfig {
  const defaults = getDefaultSetupSelections();
  return {
    type: "companion",
    profiles: {
      default: {
        name: "default",
        allowedAgents: defaults.allowedAgents,
      },
    },
    packageManagers: defaults.packageManagers,
    capabilities: defaults.capabilities,
  };
}

export function mergeWithDefaults(existing: FrameworkConfig): FrameworkConfig {
  const defaults = defaultConfig();
  return {
    ...existing,
    type: existing.type ?? defaults.type,
    packageManagers: existing.packageManagers ?? defaults.packageManagers,
    // Only backfill capabilities for legacy configs that predate the field
    // entirely. Once a capabilities array has been persisted, it reflects the
    // user's explicit selection — including deliberate deselection of
    // default-selected capabilities — and must not be padded back out.
    capabilities: existing.capabilities ?? defaults.capabilities,
  };
}

export class ConfigStore extends YamlFileStore<FrameworkConfig> {
  constructor(configPath = process.env.MATE_CONFIG ?? defaultConfigPath()) {
    super(path.resolve(configPath));
  }

  override async load(): Promise<FrameworkConfig> {
    return mergeWithDefaults(await super.load());
  }

  protected async onMissing(): Promise<FrameworkConfig> {
    const config = defaultConfig();
    await this.save(config);
    return config;
  }
}
