import os from "node:os";
import path from "node:path";

import { getActiveDistribution, type DistributionUpdateConfig } from "../distribution";
import { FRAMEWORK_NAME } from "../framework";
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

const updateStateFileSlug = (packageName: string): string =>
  packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");

/**
 * Every distribution built on mate-core shares `~/.mate`, but each checks its
 * own update package — so the cached state is scoped per package. A shared
 * file would let the default distribution's public-npm check poison a custom
 * distribution's banner with a version it can never install.
 */
export class UpdateStateStore extends YamlFileStore<UpdateState> {
  constructor(packageName: string = getUpdateConfig().packageName) {
    super(
      path.join(
        os.homedir(),
        `.${FRAMEWORK_NAME}`,
        `update-state-${updateStateFileSlug(packageName)}.yaml`,
      ),
    );
  }

  protected onMissing(): Promise<UpdateState> {
    return Promise.resolve({ lastChecked: "", latestVersion: null });
  }
}

export function getCurrentVersion(): string {
  return getActiveDistribution().config.version;
}

export function getUpdateConfig(): Required<DistributionUpdateConfig> {
  const { update } = getActiveDistribution().config;
  return {
    packageName: update?.packageName ?? `@uniqbit/${FRAMEWORK_NAME}`,
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
      `\n${FRAMEWORK_NAME}: update available (${current} → ${state.latestVersion})\n`,
    );
    process.stderr.write(`  Run \`${FRAMEWORK_NAME} update\` to upgrade.\n\n`);
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
      `\n${FRAMEWORK_NAME}: update required (${current} → ${state.latestVersion})\n`,
    );
    process.stderr.write(`  Run \`${FRAMEWORK_NAME} update\` before continuing.\n\n`);
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
