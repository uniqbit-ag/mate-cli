import { main } from "./cli/main";
import { setActiveDistribution, type DistributionConfig } from "./distribution";
import { createBunPlugin } from "./tools/setup/package-managers/bun";
import { createUvPlugin } from "./tools/setup/package-managers/uv";
import type { PluginRegistration } from "./tools/setup/plugin";
import { createGitignorePlugin } from "./tools/setup/plugins/gitignore";
import { PluginRegistry } from "./tools/setup/registry";

export interface CreateMateOptions {
  config: DistributionConfig;
  plugins: PluginRegistration[];
}

export interface MateCli {
  config: DistributionConfig;
  registry: PluginRegistry;
  run(argv?: string[]): Promise<void>;
}

/**
 * Assemble a distribution from an identity config and plugin registration
 * entries. Distributions choose their plugin set; the framework always adds
 * bun and uv as required runtime substrate, plus gitignore management named
 * after `config.name` (built last since it reads the full plugin set).
 * Returns the runnable CLI.
 */
export function createMate({ config, plugins }: CreateMateOptions): MateCli {
  const registry = new PluginRegistry([
    { plugin: createBunPlugin(), policy: "required" },
    { plugin: createUvPlugin(), policy: "required" },
    ...plugins,
    createGitignorePlugin(config.name),
  ]);
  setActiveDistribution({ config, registry });
  return {
    config,
    registry,
    run: (argv = process.argv) =>
      main(argv).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }),
  };
}
