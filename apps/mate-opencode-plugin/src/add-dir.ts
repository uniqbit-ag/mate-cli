import path from "node:path";

import type { Config, Hooks, Plugin } from "@opencode-ai/plugin";

// OpenCode accepts a per-path rule map for external_directory at runtime even
// though the published Config type narrows it to a single rule value.
type ExternalDirectoryRules = Record<string, "allow" | "ask" | "deny" | undefined>;
type ConfigHook = NonNullable<Hooks["config"]>;

function companionPathRules(companionPath: string): string[] {
  return [companionPath, `${companionPath}/**`];
}

function externalDirectoryRules(config: Config): ExternalDirectoryRules {
  const permission = (config.permission ??= {}) as { external_directory?: unknown };
  permission.external_directory ??= {};
  return permission.external_directory as ExternalDirectoryRules;
}

export const AddDirPlugin: Plugin = async () => {
  const companionPath = process.env.MATE_ARTIFACT_PATH?.trim();
  if (!companionPath) {
    return {};
  }

  const resolvedCompanionPath = path.resolve(companionPath);

  return {
    config: (async (cfg) => {
      const externalDirectory = externalDirectoryRules(cfg);

      for (const rule of companionPathRules(resolvedCompanionPath)) {
        if (externalDirectory[rule] === undefined) {
          externalDirectory[rule] = "allow";
        }
      }
    }) satisfies ConfigHook,
  };
};

export default AddDirPlugin;
