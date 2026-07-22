import type { Plugin, PluginPolicy, PluginRegistration } from "./plugin";

export interface NormalizedRegistration {
  plugin: Plugin;
  policy: PluginPolicy;
}

export function normalizeRegistration(entry: PluginRegistration): NormalizedRegistration {
  if ("plugin" in entry && "policy" in entry) {
    return { plugin: entry.plugin, policy: entry.policy };
  }
  return { plugin: entry, policy: entry.defaultSelected ? "default" : "optional" };
}

export class PluginRegistry {
  private readonly entries: NormalizedRegistration[];

  constructor(initialEntries: PluginRegistration[]) {
    this.entries = initialEntries.map(normalizeRegistration);
  }

  register(entry: PluginRegistration): this {
    this.entries.push(normalizeRegistration(entry));
    return this;
  }

  getAll(): Plugin[] {
    return this.entries.map((entry) => entry.plugin);
  }

  getEntries(): NormalizedRegistration[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  getPolicy(pluginId: string): PluginPolicy | undefined {
    return this.entries.find((entry) => entry.plugin.id === pluginId)?.policy;
  }
}
