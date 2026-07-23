import os from "node:os";
import path from "node:path";

import { frameworkConfig } from "../../framework";
import { YamlFileStore } from "./yaml-file-store";
import { migrateConfigDir } from "./migration";

interface CompanionEntry {
  path: string;
}

interface GlobalConfig {
  version: 1;
  companions: CompanionEntry[];
}

function normalizeGlobalConfig(config: GlobalConfig | null): GlobalConfig {
  return {
    version: 1,
    companions: Array.isArray(config?.companions) ? config.companions : [],
  };
}

// Lazy: the distribution name is only known once createMate has run.
function defaultGlobalConfigPath(): string {
  return path.join(os.homedir(), `.${frameworkConfig.name}`, "config.yaml");
}

export class GlobalConfigStore extends YamlFileStore<GlobalConfig> {
  constructor(configPath = defaultGlobalConfigPath()) {
    super(configPath);
  }

  protected async onMissing(): Promise<GlobalConfig> {
    return { version: 1, companions: [] };
  }

  override async load(): Promise<GlobalConfig> {
    const currentDir = path.dirname(this.configPath);
    const legacyDirs = frameworkConfig.legacyNames.map((n) => path.join(os.homedir(), `.${n}`));
    await migrateConfigDir(currentDir, legacyDirs);
    return normalizeGlobalConfig(await super.load());
  }

  async list(): Promise<string[]> {
    const config = await this.load();
    return config.companions.map((c) => c.path);
  }

  async register(companionPath: string): Promise<void> {
    const resolved = path.resolve(companionPath);
    const config = await this.load();
    if (!config.companions.some((c) => c.path === resolved)) {
      config.companions.push({ path: resolved });
      await this.save(config);
    }
  }
}
