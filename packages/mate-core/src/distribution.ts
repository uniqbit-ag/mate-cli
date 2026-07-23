import type { PluginRegistry } from "./tools/setup/registry";

export interface DistributionUpdateConfig {
  /** npm package whose versions are checked and installed by `mate update`. Defaults to `@uniqbit/<name>`. */
  packageName?: string;
  /** npm registry used for update checks and downloads. Defaults to public npm. */
  registry?: string;
  /**
   * Refuse to run commands while a newer version is available, instead of
   * only printing a banner. Install-recovery commands (`install`, `update`,
   * `doctor`, `help`, `companion setup|link`) stay available so the user can
   * actually upgrade.
   */
  enforce?: boolean;
}

/** Identity and version of the distribution assembled through `createMate`. */
export interface DistributionConfig {
  name: string;
  legacyNames?: string[];
  runtime: "bun";
  version: string;
  /** Asset directories that override the framework defaults, highest precedence first. */
  assetRoots?: string[];
  /** Optional update source; defaults to `@uniqbit/<name>` on public npm. */
  update?: DistributionUpdateConfig;
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
