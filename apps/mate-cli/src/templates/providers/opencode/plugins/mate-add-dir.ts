import path from "node:path";

import type { Config, Hooks, Plugin } from "@opencode-ai/plugin";

type ExternalDirectoryPermission = NonNullable<
  NonNullable<Config["permission"]>["external_directory"]
>;
type ConfigHook = NonNullable<Hooks["config"]>;

function companionPathRules(companionPath: string): string[] {
  return [companionPath, `${companionPath}/**`];
}

function externalDirectoryRules(config: Config): ExternalDirectoryPermission {
  config.permission ??= {};
  config.permission.external_directory ??= {};
  return config.permission.external_directory;
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
