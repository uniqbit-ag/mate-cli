import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { getDefaultSetupSelections } from "./setup-compatibilities";
import { YamlFileStore } from "./yaml-file-store";
import { ConfigError, type FrameworkConfig } from "./types";
import { parse } from "yaml";

export const RTK_CAPABILITY_SPLIT_MIGRATION = "rtk-capability-split-v1";

const HUB_MEMBER_SOURCE_KINDS = ["git", "local"] as const;

function defaultConfigPath(): string {
  return `.${FRAMEWORK_NAME}/config/framework.yaml`;
}

export function defaultConfig(): FrameworkConfig {
  const defaults = getDefaultSetupSelections();
  return {
    type: "companion",
    allowedAgents: defaults.allowedAgents,
    packageManagers: defaults.packageManagers,
    capabilities: defaults.capabilities,
  };
}

interface LegacyProfilesShape {
  profiles?: Record<string, { name?: string; allowedAgents?: string[] }>;
}

/**
 * Silently collapses the legacy `profiles` map into the flat `allowedAgents`
 * list (`profiles.default.allowedAgents` wins; other profiles are dropped).
 * The new shape persists on the next save.
 */
export function migrateProfilesToAllowedAgents(config: FrameworkConfig): FrameworkConfig {
  const legacy = config as FrameworkConfig & LegacyProfilesShape;
  if (!legacy.profiles) return config;
  const { profiles, ...rest } = legacy;
  return {
    ...rest,
    allowedAgents: rest.allowedAgents ?? profiles.default?.allowedAgents ?? [],
  };
}

export function mergeWithDefaults(existing: FrameworkConfig): FrameworkConfig {
  const defaults = defaultConfig();
  return {
    ...existing,
    type: existing.type ?? defaults.type,
    allowedAgents: existing.allowedAgents ?? [],
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

/** Reads companion configuration without migrations or default persistence. */
export async function readFrameworkConfigReadOnly(configPath: string): Promise<FrameworkConfig> {
  const parsed = parse(
    await fs.readFile(path.resolve(configPath), "utf8"),
  ) as FrameworkConfig | null;
  const merged = mergeWithDefaults(
    migrateProfilesToAllowedAgents((parsed ?? {}) as FrameworkConfig),
  );
  validateHubConfig(merged);
  validatePluginDeclarations(merged);
  return migrateRtkCapabilitySplit(merged);
}

/** Validates the shape of a hub manifest before it is used. */
export function validateHubConfig(config: FrameworkConfig): void {
  if (config.type !== "hub") {
    if (config.hub !== undefined) {
      throw new ConfigError('Only a framework with type "hub" may define hub.companions.');
    }
    return;
  }

  const members = config.hub?.companions;
  if (!Array.isArray(members)) {
    throw new ConfigError('A "hub" framework requires a hub.companions array.');
  }

  const ids = new Set<string>();
  for (const member of members) {
    if (!member || typeof member !== "object") {
      throw new ConfigError("Each hub member must be an object.");
    }

    if (typeof member.id !== "string" || member.id.trim() === "") {
      throw new ConfigError("Each hub member requires a non-empty id.");
    }
    if (ids.has(member.id)) {
      throw new ConfigError(`Hub member id is duplicated: ${member.id}`);
    }
    ids.add(member.id);

    if (
      typeof member.path !== "string" ||
      member.path.trim() === "" ||
      path.isAbsolute(member.path) ||
      path.normalize(member.path) === "." ||
      path.normalize(member.path) === ".." ||
      path.normalize(member.path).startsWith(`..${path.sep}`)
    ) {
      throw new ConfigError(`Hub member "${member.id}" path must be a relative child path.`);
    }

    const source = member.source;
    if (!source || typeof source !== "object") {
      throw new ConfigError(`Hub member "${member.id}" requires source provenance.`);
    }
    if (!HUB_MEMBER_SOURCE_KINDS.includes(source.kind)) {
      throw new ConfigError(
        `Hub member "${member.id}" source kind must be one of: ${HUB_MEMBER_SOURCE_KINDS.join(", ")}.`,
      );
    }
    if (source.kind === "git" && (typeof source.url !== "string" || source.url.trim() === "")) {
      throw new ConfigError(`Git-backed hub member "${member.id}" requires a source URL.`);
    }
    if (source.ref !== undefined && (typeof source.ref !== "string" || source.ref.trim() === "")) {
      throw new ConfigError(`Hub member "${member.id}" source ref must be a non-empty string.`);
    }
    if (
      source.kind === "git" &&
      (typeof member.materializedCommit !== "string" || member.materializedCommit.trim() === "")
    ) {
      throw new ConfigError(`Git-backed hub member "${member.id}" requires materializedCommit.`);
    }
    if (
      member.materializedCommit !== undefined &&
      (typeof member.materializedCommit !== "string" || member.materializedCommit.trim() === "")
    ) {
      throw new ConfigError(`Hub member "${member.id}" materializedCommit must be non-empty.`);
    }
  }
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
    const merged = mergeWithDefaults(migrateProfilesToAllowedAgents(await super.load()));
    validateHubConfig(merged);
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
