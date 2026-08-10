import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { pathIsDirectory } from "./repo-local-registry";
import { YamlFileStore } from "./yaml-file-store";

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

function defaultGlobalConfigPath(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`, "config.yaml");
}

export class GlobalConfigStore extends YamlFileStore<GlobalConfig> {
  constructor(configPath = defaultGlobalConfigPath()) {
    super(configPath);
  }

  protected async onMissing(): Promise<GlobalConfig> {
    return { version: 1, companions: [] };
  }

  override async load(): Promise<GlobalConfig> {
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

  /**
   * One-time/idempotent hygiene pass: drops entries whose path is not a
   * directory on disk (stale test-fixture pollution, removed companions).
   * Safe to call repeatedly — a clean registry is left unchanged and unsaved.
   */
  async prune(): Promise<{ removed: string[] }> {
    const config = await this.load();
    const checked = await Promise.all(
      config.companions.map(async (c) => ({ path: c.path, exists: await pathIsDirectory(c.path) })),
    );

    const removed: string[] = [];
    const kept: CompanionEntry[] = [];
    for (const entry of checked) {
      if (entry.exists) kept.push({ path: entry.path });
      else removed.push(entry.path);
    }
    if (removed.length === 0) return { removed };

    config.companions = kept;
    await this.save(config);
    return { removed };
  }
}
