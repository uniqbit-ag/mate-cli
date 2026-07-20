import os from "node:os";
import path from "node:path";

import { frameworkConfig } from "../framework";
import { fetchPublicPackageVersion } from "./public-npm";
import { YamlFileStore } from "./orchestrator/yaml-file-store";
import packageJson from "../../package.json";

const parse = (v: string): number[] => v.split(".").slice(0, 3).map(Number);

interface UpdateState {
  lastChecked: string;
  latestVersion: string | null;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

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
  return packageJson.version;
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

export async function fetchLatestVersion(): Promise<string> {
  return fetchPublicPackageVersion(`@uniqbit/${frameworkConfig.name}`);
}

export function scheduleBackgroundCheck(store: UpdateStateStore): void {
  void (async () => {
    try {
      const state = await store.load();
      const lastChecked = state.lastChecked ? new Date(state.lastChecked).getTime() : 0;
      if (updateCheckerDeps.now() - lastChecked < TWELVE_HOURS_MS) return;
      const latestVersion = await fetchLatestVersion();
      await store.save({ lastChecked: updateCheckerDeps.toIsoString(), latestVersion });
    } catch {
      // silent — never disrupt the main command
    }
  })();
}
