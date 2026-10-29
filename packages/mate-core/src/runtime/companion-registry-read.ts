import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "./framework";

/**
 * Read-only, synchronous readers of the two files Session Resolution checks a
 * projection against. The CLI's stores in `lib/orchestrator/` parse through
 * the same functions, so the trust check and the writers cannot disagree on
 * what the files hold.
 */

/** One `repos` entry of a companion's `registry.yaml`. */
export interface RegistryLink {
  id: string;
  path: string;
}

/** One `companions` entry of the user's `config.yaml`. */
export interface GlobalCompanionEntry {
  path: string;
}

export function globalConfigPath(home: string = os.homedir()): string {
  return path.join(home, `.${FRAMEWORK_NAME}`, "config.yaml");
}

export function companionRegistryPath(companionPath: string): string {
  return path.join(path.resolve(companionPath), `.${FRAMEWORK_NAME}`, "config", "registry.yaml");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The `companions` of a parsed `config.yaml`; entries without a string `path` are dropped. */
export function globalCompanionEntries(parsed: unknown): GlobalCompanionEntry[] {
  const companions = isRecord(parsed) ? parsed.companions : undefined;
  if (!Array.isArray(companions)) return [];
  return companions.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.path === "string" ? [{ path: entry.path }] : [],
  );
}

/** The `repos` of a parsed `registry.yaml`; entries without a string `id` and `path` are dropped. */
export function registryLinks(parsed: unknown): RegistryLink[] {
  const repos = isRecord(parsed) ? parsed.repos : undefined;
  if (!Array.isArray(repos)) return [];
  return repos.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === "string" && typeof entry.path === "string"
      ? [{ id: entry.id, path: entry.path }]
      : [],
  );
}

/** `null` for a missing file; any other read or parse failure throws. */
function readYaml(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parse(raw);
}

/** The companion paths the user registered; none when the file is missing. Throws when it cannot be read or parsed. */
export function readGlobalCompanionsSync(configPath: string = globalConfigPath()): string[] {
  return globalCompanionEntries(readYaml(configPath)).map((entry) => entry.path);
}

/** The repositories a companion links; none when its registry is missing. Throws when it cannot be read or parsed. */
export function readCompanionRegistrySync(companionPath: string): RegistryLink[] {
  return registryLinks(readYaml(companionRegistryPath(companionPath)));
}
