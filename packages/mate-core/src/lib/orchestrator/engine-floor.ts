import path from "node:path";

import semver from "semver";

import { FRAMEWORK_NAME } from "../../framework";
import { YamlFileStore } from "./yaml-file-store";

/**
 * Raw view of `framework.yaml`: `ConfigStore.load()` merges defaults, so saving
 * its result would add keys the companion never declared.
 */
class RawFrameworkConfigStore extends YamlFileStore<Record<string, unknown>> {
  protected onMissing(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
}

function rawStore(companionPath: string): RawFrameworkConfigStore {
  return new RawFrameworkConfigStore(
    path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
  );
}

/** Sets `engines.mate` to `range`. Returns true when the file was rewritten. */
export async function writeEngineFloor(companionPath: string, range: string): Promise<boolean> {
  const store = rawStore(companionPath);
  const raw = (await store.load()) ?? {};
  const engines = (raw.engines ?? {}) as Record<string, string>;
  if (engines[FRAMEWORK_NAME] === range) return false;
  await store.save({ ...raw, engines: { ...engines, [FRAMEWORK_NAME]: range } });
  return true;
}

/**
 * Raises `engines.mate` to `>=version` when it is absent or admits a lower
 * version; a floor already at or above it, or a range that does not parse,
 * is left alone. Returns true when the file was rewritten.
 */
export async function raiseEngineFloor(companionPath: string, version: string): Promise<boolean> {
  const raw = (await rawStore(companionPath).load()) ?? {};
  const current = ((raw.engines ?? {}) as Record<string, unknown>)[FRAMEWORK_NAME];
  if (typeof current === "string") {
    if (semver.validRange(current) === null) return false;
    const lowest = semver.minVersion(current);
    if (lowest && semver.gte(lowest, version)) return false;
  }
  return writeEngineFloor(companionPath, `>=${version}`);
}
