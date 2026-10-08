import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { getDefaultSetupSelections } from "./setup-compatibilities";
import { YamlFileStore } from "./yaml-file-store";
import { ConfigError, type FrameworkConfig } from "./types";

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
function migrateProfilesToAllowedAgents(config: FrameworkConfig): FrameworkConfig {
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
function validatePluginDeclarations(config: FrameworkConfig): void {
  for (const declaration of config.plugins ?? []) {
    const policy = declaration.policy as string | undefined;
    if (policy !== undefined && !PLUGIN_DECLARATION_POLICIES.includes(policy as never)) {
      throw new ConfigError(
        `plugins entry "${declaration.package}": policy "${policy}" is not allowed for declared plugins (allowed: ${PLUGIN_DECLARATION_POLICIES.join(", ")}).`,
      );
    }
  }
}

export const AUDIENCE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const AUDIENCE_KEYS = ["plugins", "studio"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAudiencePlugins(audience: string, plugins: unknown): Map<string, string> {
  if (!Array.isArray(plugins)) {
    throw new ConfigError(`audience "${audience}": plugins must be a list.`);
  }
  const versions = new Map<string, string>();
  for (const entry of plugins) {
    if (
      !isRecord(entry) ||
      typeof entry.package !== "string" ||
      typeof entry.version !== "string"
    ) {
      throw new ConfigError(
        `audience "${audience}": plugins entry must have string package and version: ${JSON.stringify(entry)}`,
      );
    }
    if (
      entry.policy !== undefined &&
      !PLUGIN_DECLARATION_POLICIES.includes(entry.policy as never)
    ) {
      throw new ConfigError(
        `audience "${audience}": plugins entry "${entry.package}": policy "${String(entry.policy)}" is not allowed for declared plugins (allowed: ${PLUGIN_DECLARATION_POLICIES.join(", ")}).`,
      );
    }
    if (versions.has(entry.package)) {
      throw new ConfigError(
        `audience "${audience}": package "${entry.package}" is declared more than once.`,
      );
    }
    versions.set(entry.package, entry.version);
  }
  return versions;
}

/**
 * Validates the optional `audiences` mapping. Only companions may declare
 * audiences; names are safe identifiers and keys form a closed set so typos
 * fail instead of silently doing nothing.
 */
function validateAudiences(config: FrameworkConfig): void {
  const audiences = config.audiences as unknown;
  if (audiences === undefined) return;
  if (config.type === "hub") {
    throw new ConfigError('Only companions may declare audiences; a "hub" framework may not.');
  }
  if (!isRecord(audiences)) {
    throw new ConfigError("audiences must be a mapping of audience name to configuration.");
  }

  const basePackages = new Set((config.plugins ?? []).map((plugin) => plugin.package));
  const seen = new Map<string, { audience: string; version: string }>();

  for (const [name, audience] of Object.entries(audiences)) {
    if (!AUDIENCE_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `Invalid audience name "${name}": must match ${AUDIENCE_NAME_PATTERN.source}.`,
      );
    }
    if (!isRecord(audience)) {
      throw new ConfigError(`audience "${name}" must be a mapping.`);
    }
    for (const key of Object.keys(audience)) {
      if (!AUDIENCE_KEYS.includes(key as never)) {
        throw new ConfigError(
          `audience "${name}": unknown key "${key}" (allowed: ${AUDIENCE_KEYS.join(", ")}).`,
        );
      }
    }

    if (audience.plugins !== undefined) {
      for (const [pkg, version] of validateAudiencePlugins(name, audience.plugins)) {
        if (basePackages.has(pkg)) {
          throw new ConfigError(
            `audience "${name}": package "${pkg}" is also declared in base plugins.`,
          );
        }
        const other = seen.get(pkg);
        if (other && other.version !== version) {
          throw new ConfigError(
            `package "${pkg}" has conflicting versions in audiences "${other.audience}" (${other.version}) and "${name}" (${version}).`,
          );
        }
        seen.set(pkg, other ?? { audience: name, version });
      }
    }

    if (audience.studio !== undefined) {
      const agent =
        isRecord(audience.studio) && isRecord(audience.studio.terminal)
          ? audience.studio.terminal.agent
          : undefined;
      if (agent !== undefined && typeof agent !== "string") {
        throw new ConfigError(`audience "${name}": studio.terminal.agent must be a string.`);
      }
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
    validateAudiences(merged);
    return merged;
  }

  protected async onMissing(): Promise<FrameworkConfig> {
    const config = defaultConfig();
    await this.save(config);
    return config;
  }
}
