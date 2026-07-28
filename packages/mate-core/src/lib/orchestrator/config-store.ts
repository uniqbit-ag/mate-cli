import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { getDefaultSetupSelections } from "./setup-compatibilities";
import { YamlFileStore } from "./yaml-file-store";
import { ConfigError, type FrameworkConfig } from "./types";

export const RTK_CAPABILITY_SPLIT_MIGRATION = "rtk-capability-split-v1";

function defaultConfigPath(): string {
  return `.${FRAMEWORK_NAME}/config/framework.yaml`;
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

export function migrateRtkCapabilitySplit(config: FrameworkConfig): FrameworkConfig {
  const migrations = config.migrations ?? [];
  if (migrations.includes(RTK_CAPABILITY_SPLIT_MIGRATION)) return config;

  const capabilities = config.capabilities ?? [];
  const hasHeadroom = capabilities.some((capability) => capability.name === "headroom");
  const hasRtk = capabilities.some((capability) => capability.name === "rtk");
  return {
    ...config,
    capabilities: hasHeadroom && !hasRtk ? [...capabilities, { name: "rtk" }] : capabilities,
    migrations: [...migrations, RTK_CAPABILITY_SPLIT_MIGRATION],
  };
}

export const PLUGIN_DECLARATION_POLICIES = ["default", "optional"] as const;

/**
 * Validates the `plugins` list of a loaded config. Declared plugins may not
 * claim `required` — required-ness is a distribution prerogative.
 */
export function validatePluginDeclarations(config: FrameworkConfig): void {
  for (const declaration of config.plugins ?? []) {
    const policy = declaration.policy as string | undefined;
    if (policy !== undefined && !PLUGIN_DECLARATION_POLICIES.includes(policy as never)) {
      throw new ConfigError(
        `plugins entry "${declaration.package}": policy "${policy}" is not allowed for declared plugins (allowed: ${PLUGIN_DECLARATION_POLICIES.join(", ")}).`,
      );
    }
  }
}

export class ConfigStore extends YamlFileStore<FrameworkConfig> {
  constructor(configPath = process.env.MATE_CONFIG ?? defaultConfigPath()) {
    super(path.resolve(configPath));
  }

  override async load(): Promise<FrameworkConfig> {
    const merged = mergeWithDefaults(await super.load());
    validatePluginDeclarations(merged);
    const needsMigration = !(merged.migrations ?? []).includes(RTK_CAPABILITY_SPLIT_MIGRATION);
    const config = migrateRtkCapabilitySplit(merged);
    if (needsMigration) await this.save(config);
    return config;
  }

  protected async onMissing(): Promise<FrameworkConfig> {
    const config = migrateRtkCapabilitySplit(defaultConfig());
    await this.save(config);
    return config;
  }
}
