import type { PluginRegistry } from "./tools/setup/registry";

/** Identity and version of the distribution assembled through `createMate`. */
export interface DistributionConfig {
  name: string;
  legacyNames?: string[];
  runtime: "bun";
  supportedAdapters: string[];
  version: string;
  /** Asset directories that override the framework defaults, highest precedence first. */
  assetRoots?: string[];
}

export interface ActiveDistribution {
  config: DistributionConfig;
  registry: PluginRegistry;
}

let active: ActiveDistribution | null = null;
let fallbackFactory: (() => ActiveDistribution) | null = null;

export function setActiveDistribution(distribution: ActiveDistribution): void {
  active = distribution;
}

export function resetActiveDistribution(): void {
  active = null;
}

/**
 * Register a lazily-built fallback used when `createMate` has not run.
 * Test harnesses use this; production bins always call `createMate` first.
 */
export function setFallbackDistribution(factory: (() => ActiveDistribution) | null): void {
  fallbackFactory = factory;
}

export function getActiveDistribution(): ActiveDistribution {
  if (!active && fallbackFactory) {
    active = fallbackFactory();
  }
  if (!active) {
    throw new Error(
      "No active distribution: call createMate({ config, plugins }) before using the framework.",
    );
  }
  return active;
}
