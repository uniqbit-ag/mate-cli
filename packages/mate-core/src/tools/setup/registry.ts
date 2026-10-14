import type { Plugin, PluginPolicy, PluginRegistration } from "./plugin";

export interface NormalizedRegistration {
  plugin: Plugin;
  policy: PluginPolicy;
  /** The audience that declared the plugin; `null` for base. */
  audience: string | null;
  /** The declared package a dynamic plugin was loaded from; absent for compiled-in plugins. */
  packageName?: string;
}

export function normalizeRegistration(entry: PluginRegistration): NormalizedRegistration {
  if ("plugin" in entry && "policy" in entry) {
    return {
      plugin: entry.plugin,
      policy: entry.policy,
      audience: entry.audience ?? null,
      ...(entry.packageName ? { packageName: entry.packageName } : {}),
    };
  }
  return { plugin: entry, policy: entry.defaultSelected ? "default" : "optional", audience: null };
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

  /**
   * Compiled-in plugins and top-level declarations: the only registrations a
   * pass that writes a persisted surface may reconcile.
   */
  baseRegistrations(): NormalizedRegistration[] {
    return this.getEntries().filter((entry) => entry.audience === null);
  }

  /** The registrations one audience declared; only its launch layer renders them. */
  audienceRegistrations(audience: string): NormalizedRegistration[] {
    return this.getEntries().filter((entry) => entry.audience === audience);
  }

  getPolicy(pluginId: string): PluginPolicy | undefined {
    return this.entries.find((entry) => entry.plugin.id === pluginId)?.policy;
  }
}
