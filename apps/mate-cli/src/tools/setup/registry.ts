import { graphifyPlugin } from "./capabilities/graphify";
import { headroomPlugin } from "./capabilities/headroom";
import { createOpenspecPlugin } from "./capabilities/openspec";
import { reactDoctorPlugin } from "./capabilities/react-doctor";
import { tokensavePlugin } from "./capabilities/tokensave";
import { bunPlugin } from "./package-managers/bun";
import { createUvPlugin } from "./package-managers/uv";
import { createGitignorePlugin } from "./plugins/gitignore";
import type { Plugin } from "./plugin";
import { claudePlugin } from "./providers/claude";
import { codexPlugin } from "./providers/codex";
import { opencodePlugin } from "./providers/opencode";
import { frameworkConfig } from "../../framework";

export class PluginRegistry {
  private readonly plugins: Plugin[];

  constructor(initialPlugins: Plugin[]) {
    this.plugins = [...initialPlugins];
  }

  register(plugin: Plugin): this {
    this.plugins.push(plugin);
    return this;
  }

  getAll(): Plugin[] {
    return [...this.plugins];
  }
}

function buildBuiltinPlugins(): Plugin[] {
  const providers: Plugin[] = [claudePlugin, codexPlugin, opencodePlugin];
  const packageManagers: Plugin[] = [bunPlugin, createUvPlugin()];
  const capabilities: Plugin[] = [
    createOpenspecPlugin(),
    reactDoctorPlugin,
    tokensavePlugin,
    headroomPlugin,
    graphifyPlugin,
  ];
  const allNonRoot = [...providers, ...packageManagers, ...capabilities];
  const gitignore = createGitignorePlugin(frameworkConfig.name, () => allNonRoot);

  return [...allNonRoot, gitignore];
}

export const registry = new PluginRegistry(buildBuiltinPlugins());
