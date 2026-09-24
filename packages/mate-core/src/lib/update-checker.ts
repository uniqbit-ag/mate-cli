import os from "node:os";
import path from "node:path";

import semver from "semver";

import { getActiveDistribution, type DistributionUpdateConfig } from "../distribution";
import { FRAMEWORK_NAME } from "../framework";
import { fetchPublicPackageVersion, PUBLIC_NPM_REGISTRY } from "./public-npm";
import { YamlFileStore } from "./orchestrator/yaml-file-store";

interface UpdateState {
  lastChecked: string;
  latestVersion: string | null;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export const updateCheckerDeps = {
  now: () => Date.now(),
  toIsoString: () => new Date().toISOString(),
};

/** Declares that the installation's version is fixed by the artifact it was built into. */
export const UPDATE_POLICY_ENV = "MATE_UPDATE_POLICY";

export type UpdatePolicy = "default" | "pinned";

/**
 * Reported at most once per process: the three automatic-update entry points
 * each consult the policy, and an unrecognized value must not be repeated.
 */
let unrecognizedPolicyReported = false;

/** Test seam — the policy is process-wide, so its report latch must be resettable. */
export function resetUpdatePolicyReport(): void {
  unrecognizedPolicyReported = false;
}

export function getUpdatePolicy(env: NodeJS.ProcessEnv = process.env): UpdatePolicy {
  const raw = env[UPDATE_POLICY_ENV];
  if (raw === undefined || raw.trim() === "") return "default";

  const value = raw.trim();
  if (value === "pinned") return "pinned";

  if (!unrecognizedPolicyReported) {
    unrecognizedPolicyReported = true;
    process.stderr.write(
      `${FRAMEWORK_NAME}: unrecognized ${UPDATE_POLICY_ENV} value \`${value}\`; automatic update handling is unchanged.\n`,
    );
  }
  return "default";
}

export function isPinnedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return getUpdatePolicy(env) === "pinned";
}

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
    const channelSuffix = getUpdateChannel() === "canary" ? "-canary" : "";
    super(
      path.join(
        os.homedir(),
        `.${FRAMEWORK_NAME}`,
        `update-state-${updateStateFileSlug(packageName)}${channelSuffix}.yaml`,
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

export type UpdateChannel = "latest" | "canary";

export function getUpdateChannel(version: string = getCurrentVersion()): UpdateChannel {
  return isCanaryVersion(version) ? "canary" : "latest";
}

export function isNewer(latest: string, current: string): boolean {
  if (!semver.valid(latest) || !semver.valid(current)) return false;
  return semver.gt(latest, current);
}

export async function showUpdateBannerIfAvailable(store: UpdateStateStore): Promise<void> {
  if (isPinnedDeployment()) return;
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
  if (isPinnedDeployment()) return false;
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
  const latestVersion = await fetchPublicPackageVersion(packageName, registry, getUpdateChannel());
  if (!semver.valid(latestVersion)) throw new Error("npm returned an invalid version");
  return latestVersion;
}

export function scheduleBackgroundCheck(store: UpdateStateStore): Promise<void> {
  if (isPinnedDeployment()) return Promise.resolve();
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
