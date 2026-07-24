import os from "node:os";
import path from "node:path";

import { getActiveDistribution, type DistributionUpdateConfig } from "../distribution";
import { frameworkConfig } from "../framework";
import { fetchPublicPackageVersion, PUBLIC_NPM_REGISTRY } from "./public-npm";
import { YamlFileStore } from "./orchestrator/yaml-file-store";

const parse = (v: string): number[] => v.split(".").slice(0, 3).map(Number);

interface UpdateState {
  lastChecked: string;
  latestVersion: string | null;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export const updateCheckerDeps = {
  now: () => Date.now(),
  toIsoString: () => new Date().toISOString(),
};

export class UpdateStateStore extends YamlFileStore<UpdateState> {
  constructor() {
    super(path.join(os.homedir(), `.${frameworkConfig.name}`, "update-state.yaml"));
  }

  protected onMissing(): Promise<UpdateState> {
    return Promise.resolve({ lastChecked: "", latestVersion: null });
  }
}

export function getCurrentVersion(): string {
  return getActiveDistribution().config.version;
}

export function getUpdateConfig(): Required<DistributionUpdateConfig> {
  const { name, update } = getActiveDistribution().config;
  return {
    packageName: update?.packageName ?? `@uniqbit/${name}`,
    registry: update?.registry ?? PUBLIC_NPM_REGISTRY,
    enforce: update?.enforce ?? false,
  };
}

export function isCanaryVersion(version: string = getCurrentVersion()): boolean {
  return version.includes("-canary");
}

export function isNewer(latest: string, current: string): boolean {
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export async function showUpdateBannerIfAvailable(store: UpdateStateStore): Promise<void> {
  try {
    const state = await store.load();
    if (!state.latestVersion) return;
    const current = getCurrentVersion();
    if (!isNewer(state.latestVersion, current)) return;
    process.stderr.write(
      `\n${frameworkConfig.name}: update available (${current} → ${state.latestVersion})\n`,
    );
    process.stderr.write(`  Run \`${frameworkConfig.name} update\` to upgrade.\n\n`);
  } catch {
    // never block the main command
  }
}

/**
 * Distributions that set `update.enforce` refuse to run further commands while
 * a cached newer version is available. Returns true when the current command
 * must stop; state-load failures never block.
 */
export async function enforceUpdateIfRequired(store: UpdateStateStore): Promise<boolean> {
  if (!getUpdateConfig().enforce) return false;
  try {
    const state = await store.load();
    if (!state.latestVersion) return false;
    const current = getCurrentVersion();
    if (!isNewer(state.latestVersion, current)) return false;
    process.stderr.write(
      `\n${frameworkConfig.name}: update required (${current} → ${state.latestVersion})\n`,
    );
    process.stderr.write(`  Run \`${frameworkConfig.name} update\` before continuing.\n\n`);
    return true;
  } catch {
    return false;
  }
}

export async function fetchLatestVersion(): Promise<string> {
  const { packageName, registry } = getUpdateConfig();
  return fetchPublicPackageVersion(packageName, registry);
}

export function scheduleBackgroundCheck(store: UpdateStateStore): Promise<void> {
  return (async () => {
    try {
      const state = await store.load();
      const lastChecked = state.lastChecked ? new Date(state.lastChecked).getTime() : 0;
      if (updateCheckerDeps.now() - lastChecked < SIX_HOURS_MS) return;
      const latestVersion = await fetchLatestVersion();
      await store.save({ lastChecked: updateCheckerDeps.toIsoString(), latestVersion });
    } catch {
      // silent — never disrupt the main command
    }
  })();
}
